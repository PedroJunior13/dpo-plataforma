// Emissao de NFS-e (Nota Fiscal de Servico) via Focus NFe.
// Doc: https://focusnfe.com.br/doc/  (endpoint /v2/nfse?ref=...)
// As notas sao municipais; o provedor abstrai o padrao da prefeitura.
import { sql, one } from "./db.js";

// Configuracao da emissao. Os PADROES ja vem com a tributacao mais favoravel a
// empresa (EIRELI/Sociedade unipessoal optante pelo SIMPLES NACIONAL):
//  - optante_simples_nacional = true (ISS recolhido pelo DAS, aliquota reduzida)
//  - item_lista_servico 1.07 (suporte/licenciamento/consultoria em TI/dados)
//  - aliquota ISS 2% (piso constitucional; muitos municipios praticam 2% p/ TI)
// IMPORTANTE: confirme o item da lista e a aliquota do SEU municipio com a
// contabilidade. Os valores sao parametrizaveis por variaveis de ambiente.
const cfg = () => ({
  token: process.env.FOCUSNFE_TOKEN,
  base: (process.env.FOCUSNFE_ENV === "producao")
    ? "https://api.focusnfe.com.br"
    : "https://homologacao.focusnfe.com.br",
  cnpj: process.env.EMITENTE_CNPJ,
  im: process.env.EMITENTE_INSCRICAO_MUNICIPAL,
  municipio: process.env.EMITENTE_CODIGO_MUNICIPIO,
  item: process.env.NFSE_ITEM_LISTA_SERVICO || "1.07",
  // Codigo tributario do municipio (CNAE/cnae fiscal) — opcional, alguns municipios exigem.
  codigoTributario: process.env.NFSE_CODIGO_TRIBUTARIO_MUNICIPIO || undefined,
  aliquota: parseFloat(process.env.NFSE_ALIQUOTA_ISS || "0.02"),
  // Regime tributario favoravel por padrao (Simples Nacional). Pode ser desligado.
  optanteSimples: (process.env.NFSE_OPTANTE_SIMPLES || "true") !== "false",
  // 6 = Microempresario e Empresa de Pequeno Porte (ME/EPP) — Simples Nacional.
  regimeEspecial: process.env.NFSE_REGIME_ESPECIAL_TRIBUTACAO || undefined,
});

export function enabled() { return !!process.env.FOCUSNFE_TOKEN; }

// Emissao automatica apos a compra. Ligada por padrao quando o token existe;
// pode ser desligada com NFSE_AUTO=false (ex.: para homologar antes).
export function autoEnabled() {
  return enabled() && (process.env.NFSE_AUTO || "true") !== "false";
}

// Emite automaticamente a NFS-e do ULTIMO pagamento aprovado da assinatura.
// Best-effort: nunca lanca — devolve {skipped|issued|error} para registro.
export async function autoIssueForSubscription(subscriptionId) {
  if (!autoEnabled()) return { skipped: "nfse_auto_off" };
  try {
    const pay = await one(sql`SELECT * FROM payments WHERE subscription_id=${subscriptionId}
                              AND status IN ('approved','paid','active','confirmed') ORDER BY created_at DESC LIMIT 1`);
    if (!pay) return { skipped: "sem_pagamento_aprovado" };
    const exist = await one(sql`SELECT id, status FROM invoices WHERE payment_id=${pay.id} ORDER BY created_at DESC LIMIT 1`);
    if (exist && exist.status !== "error") return { skipped: "ja_emitida", invoiceId: exist.id };
    const res = await issueForPayment(pay.id);
    return { issued: true, ...res };
  } catch (e) {
    console.error("[nfse:auto]", e?.message || e);
    return { error: e?.message || String(e) };
  }
}

// Emite uma NFS-e para um pagamento aprovado.
export async function issueForPayment(paymentId) {
  const c = cfg();
  if (!c.token) throw new Error("FOCUSNFE_TOKEN nao configurado.");

  const pay = await one(sql`SELECT * FROM payments WHERE id=${paymentId}`);
  if (!pay) throw new Error("Pagamento nao encontrado.");
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${pay.tenant_id}`);

  const ref = `pay_${paymentId}`;
  const valor = (pay.amount_cents / 100).toFixed(2);

  // Registra a fatura como "processing"
  const inv = await one(sql`
    INSERT INTO invoices (tenant_id, payment_id, provider, provider_ref, status, amount_cents)
    VALUES (${pay.tenant_id}, ${paymentId}, 'focusnfe', ${ref}, 'processing', ${pay.amount_cents})
    RETURNING *`);

  const body = {
    data_emissao: new Date().toISOString().slice(0, 10),
    prestador: { cnpj: c.cnpj, inscricao_municipal: c.im, codigo_municipio: c.municipio },
    tomador: {
      cnpj: (tenant.doc || "").replace(/\D/g, "").length === 14 ? tenant.doc.replace(/\D/g, "") : undefined,
      cpf: (tenant.doc || "").replace(/\D/g, "").length === 11 ? tenant.doc.replace(/\D/g, "") : undefined,
      razao_social: tenant.name,
      email: tenant.email || undefined,
    },
    // Natureza da operacao 1 = Tributacao no municipio (padrao para servico local).
    natureza_operacao: "1",
    optante_simples_nacional: c.optanteSimples,
    regime_especial_tributacao: c.regimeEspecial,
    servico: {
      aliquota: c.aliquota,
      discriminacao: `Licenca de uso e suporte da plataforma DPO PJ Protection (conformidade LGPD/GDPR) — modulo ${tenant.plan_id}.`,
      iss_retido: false,
      item_lista_servico: c.item,
      codigo_tributario_municipio: c.codigoTributario,
      valor_servicos: Number(valor),
    },
  };

  const r = await fetch(`${c.base}/v2/nfse?ref=${encodeURIComponent(ref)}`, {
    method: "POST",
    headers: { "Authorization": "Basic " + Buffer.from(c.token + ":").toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) {
    await sql`UPDATE invoices SET status='error', message=${JSON.stringify(data).slice(0, 800)} WHERE id=${inv.id}`;
    throw new Error(`Focus NFe ${r.status}: ${data?.mensagem || JSON.stringify(data)}`);
  }
  // Emissao e assincrona; o status final chega via consulta/webhook.
  return { invoiceId: inv.id, ref, accepted: true, raw: data };
}

// Consulta o status de uma NFS-e ja enviada e atualiza a fatura.
export async function refreshInvoice(invoiceId) {
  const c = cfg();
  const inv = await one(sql`SELECT * FROM invoices WHERE id=${invoiceId}`);
  if (!inv) throw new Error("Fatura nao encontrada.");
  const r = await fetch(`${c.base}/v2/nfse/${encodeURIComponent(inv.provider_ref)}`, {
    headers: { "Authorization": "Basic " + Buffer.from(c.token + ":").toString("base64") },
  });
  const data = await r.json().catch(() => ({}));
  const map = { autorizado: "issued", cancelado: "canceled", erro_autorizacao: "error", processando_autorizacao: "processing" };
  const status = map[data?.status] || inv.status;
  await sql`UPDATE invoices SET status=${status}, number=${data?.numero || inv.number},
            pdf_url=${data?.url_danfse || data?.caminho_danfse || inv.pdf_url},
            xml_url=${data?.caminho_xml_nota_fiscal || inv.xml_url},
            message=${data?.mensagem || null} WHERE id=${invoiceId}`;
  return { status, raw: data };
}

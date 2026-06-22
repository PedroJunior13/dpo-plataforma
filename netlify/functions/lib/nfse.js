// Emissao de NFS-e (Nota Fiscal de Servico) via Focus NFe.
// Doc: https://focusnfe.com.br/doc/  (endpoint /v2/nfse?ref=...)
// As notas sao municipais; o provedor abstrai o padrao da prefeitura.
import { sql, one } from "./db.js";
import { allSettings } from "./settings.js";

// Configuracao da emissao. Os PADROES ja vem com a tributacao mais favoravel a
// empresa (EIRELI/Sociedade unipessoal optante pelo SIMPLES NACIONAL):
//  - optante_simples_nacional = true (ISS recolhido pelo DAS, aliquota reduzida)
//  - item_lista_servico 1.07 (suporte/licenciamento/consultoria em TI/dados)
//  - aliquota ISS 2% (piso constitucional; muitos municipios praticam 2% p/ TI)
// IMPORTANTE: confirme o item da lista e a aliquota do SEU municipio com a
// contabilidade. Tudo e parametrizavel pela aba "Integracoes" do painel
// (precedencia) ou por variaveis de ambiente (fallback).
//
// Mapa chave-do-banco -> variavel-de-ambiente:
//   nfse_token              -> FOCUSNFE_TOKEN
//   nfse_env                -> FOCUSNFE_ENV          (producao|homologacao)
//   nfse_cnpj               -> EMITENTE_CNPJ
//   nfse_im                 -> EMITENTE_INSCRICAO_MUNICIPAL
//   nfse_municipio          -> EMITENTE_CODIGO_MUNICIPIO  (cod. IBGE 7 digitos)
//   nfse_item_lista         -> NFSE_ITEM_LISTA_SERVICO
//   nfse_codigo_tributario  -> NFSE_CODIGO_TRIBUTARIO_MUNICIPIO
//   nfse_aliquota           -> NFSE_ALIQUOTA_ISS      (ex.: 0.02 = 2%)
//   nfse_optante_simples    -> NFSE_OPTANTE_SIMPLES   ("true"/"false")
//   nfse_regime_especial    -> NFSE_REGIME_ESPECIAL_TRIBUTACAO
//   nfse_auto               -> NFSE_AUTO              ("true"/"false")
const pick = (s, key, envName, def) => {
  if (s && s[key] != null && s[key] !== "") return s[key];
  if (envName && process.env[envName] != null && process.env[envName] !== "") return process.env[envName];
  return def;
};

async function cfg() {
  const s = await allSettings().catch(() => ({}));
  const env = pick(s, "nfse_env", "FOCUSNFE_ENV", "homologacao");
  return {
    token: pick(s, "nfse_token", "FOCUSNFE_TOKEN", undefined),
    base: env === "producao" ? "https://api.focusnfe.com.br" : "https://homologacao.focusnfe.com.br",
    env,
    cnpj: pick(s, "nfse_cnpj", "EMITENTE_CNPJ", undefined),
    im: pick(s, "nfse_im", "EMITENTE_INSCRICAO_MUNICIPAL", undefined),
    municipio: pick(s, "nfse_municipio", "EMITENTE_CODIGO_MUNICIPIO", undefined),
    item: pick(s, "nfse_item_lista", "NFSE_ITEM_LISTA_SERVICO", "1.07"),
    codigoTributario: pick(s, "nfse_codigo_tributario", "NFSE_CODIGO_TRIBUTARIO_MUNICIPIO", undefined),
    aliquota: parseFloat(pick(s, "nfse_aliquota", "NFSE_ALIQUOTA_ISS", "0.02")),
    optanteSimples: String(pick(s, "nfse_optante_simples", "NFSE_OPTANTE_SIMPLES", "true")) !== "false",
    regimeEspecial: pick(s, "nfse_regime_especial", "NFSE_REGIME_ESPECIAL_TRIBUTACAO", undefined),
    auto: String(pick(s, "nfse_auto", "NFSE_AUTO", "true")) !== "false",
  };
}

// Habilitado quando ha token (no banco OU na env).
export async function enabled() {
  const c = await cfg();
  return !!c.token;
}

// Emissao automatica apos a compra. Ligada por padrao quando o token existe;
// pode ser desligada (nfse_auto=false) para homologar antes.
export async function autoEnabled() {
  const c = await cfg();
  return !!c.token && c.auto;
}

// Diagnostico para a aba Integracoes: o que esta configurado e o que falta.
// NUNCA expoe o token completo — apenas se existe e os 4 ultimos digitos.
export async function status() {
  const c = await cfg();
  const tokenMasked = c.token ? ("•••• " + String(c.token).slice(-4)) : null;
  const required = { token: !!c.token, cnpj: !!c.cnpj, im: !!c.im, municipio: !!c.municipio };
  const missing = Object.keys(required).filter((k) => !required[k]);
  return {
    enabled: !!c.token,
    auto: !!c.token && c.auto,
    env: c.env,
    ready: missing.length === 0,
    missing,
    tokenMasked,
    fields: {
      cnpj: c.cnpj || null, im: c.im || null, municipio: c.municipio || null,
      item: c.item, codigoTributario: c.codigoTributario || null,
      aliquota: c.aliquota, optanteSimples: c.optanteSimples,
      regimeEspecial: c.regimeEspecial || null,
    },
  };
}

// Emite automaticamente a NFS-e do ULTIMO pagamento aprovado da assinatura.
// Best-effort: nunca lanca — devolve {skipped|issued|error} para registro.
export async function autoIssueForSubscription(subscriptionId) {
  if (!(await autoEnabled())) return { skipped: "nfse_auto_off" };
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
  const c = await cfg();
  if (!c.token) throw new Error("NFS-e nao configurada: informe o token Focus NFe na aba Integracoes.");
  if (!c.cnpj || !c.im || !c.municipio) {
    throw new Error("NFS-e incompleta: preencha CNPJ, Inscricao Municipal e Codigo do Municipio (IBGE) na aba Integracoes.");
  }

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
  const c = await cfg();
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

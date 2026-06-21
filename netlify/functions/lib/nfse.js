// Emissao de NFS-e (Nota Fiscal de Servico) via Focus NFe.
// Doc: https://focusnfe.com.br/doc/  (endpoint /v2/nfse?ref=...)
// As notas sao municipais; o provedor abstrai o padrao da prefeitura.
import { sql, one } from "./db.js";

const cfg = () => ({
  token: process.env.FOCUSNFE_TOKEN,
  base: (process.env.FOCUSNFE_ENV === "producao")
    ? "https://api.focusnfe.com.br"
    : "https://homologacao.focusnfe.com.br",
  cnpj: process.env.EMITENTE_CNPJ,
  im: process.env.EMITENTE_INSCRICAO_MUNICIPAL,
  municipio: process.env.EMITENTE_CODIGO_MUNICIPIO,
  item: process.env.NFSE_ITEM_LISTA_SERVICO || "1.07",
  aliquota: parseFloat(process.env.NFSE_ALIQUOTA_ISS || "0.02"),
});

export function enabled() { return !!process.env.FOCUSNFE_TOKEN; }

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
    servico: {
      aliquota: c.aliquota,
      discriminacao: `Licenca de uso da plataforma DPO PJ Protection — ${tenant.plan_id}.`,
      iss_retido: false,
      item_lista_servico: c.item,
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

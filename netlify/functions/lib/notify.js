// Notificacoes: e-mail (Resend) e WhatsApp (Meta Cloud API).
// Toda notificacao e registrada em `notifications` para auditoria.
import { sql } from "./db.js";
import { getSetting } from "./settings.js";

// Config do e-mail transacional com PRECEDENCIA do painel (Integracoes) sobre a
// env. Assim o Dono ativa os envios direto na plataforma, sem depender de mexer
// nas variaveis de ambiente do Netlify. Se nada estiver configurado, retorna
// key vazia e o envio e apenas registrado como "queued" (sem quebrar o fluxo).
export async function emailConfig() {
  const [key, fromName, fromEmail] = await Promise.all([
    getSetting("RESEND_API_KEY", "RESEND_API_KEY", ""),
    getSetting("NOTIFY_FROM_NAME", "NOTIFY_FROM_NAME", "DPO PJ Protection"),
    getSetting("NOTIFY_FROM_EMAIL", "NOTIFY_FROM_EMAIL", "contato@dpopjprotection.com.br"),
  ]);
  return { key: key || "", fromName, fromEmail, configured: !!(key && key.trim()) };
}

// Timeout duro para qualquer chamada a provedor externo (Resend/WhatsApp).
// Sem isto, um provedor lento/inacessivel deixaria a funcao serverless pendurada
// ate o limite do Netlify e o cliente receberia HTTP 502. Com AbortController,
// no pior caso desistimos em FETCH_TIMEOUT_MS e a operacao principal (ex.: abrir
// chamado) NUNCA fica refem do envio do e-mail.
const FETCH_TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS || 6000);
async function fetchWithTimeout(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

export async function sendEmail({ tenantId = null, to, subject, html, type = "info" }) {
  let status = "queued", err = null;
  const cfg = await emailConfig();
  if (cfg.configured && to) {
    try {
      const r = await fetchWithTimeout("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${cfg.fromName} <${cfg.fromEmail}>`,
          to: [to], subject, html,
        }),
      });
      status = r.ok ? "sent" : "error";
      if (!r.ok) err = await r.text();
    } catch (e) { status = "error"; err = e.name === "AbortError" ? "timeout" : e.message; }
  }
  // O registro de auditoria nunca pode derrubar a operacao que disparou o e-mail.
  try {
    await sql`INSERT INTO notifications (tenant_id, type, channel, destination, subject, body, status, sent_at)
              VALUES (${tenantId}, ${type}, 'email', ${to}, ${subject}, ${(html || "").slice(0, 4000)},
                      ${status}, ${status === "sent" ? new Date().toISOString() : null})`;
  } catch (e) { console.error("[notify:email] log falhou (nao-fatal):", e?.message || e); }
  return { status, err };
}

export async function sendWhatsApp({ tenantId = null, to, text, type = "info" }) {
  let status = "queued", err = null;
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId && to) {
    try {
      const r = await fetchWithTimeout(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/\D/g, ""), type: "text", text: { body: text } }),
      });
      status = r.ok ? "sent" : "error";
      if (!r.ok) err = await r.text();
    } catch (e) { status = "error"; err = e.name === "AbortError" ? "timeout" : e.message; }
  }
  try {
    await sql`INSERT INTO notifications (tenant_id, type, channel, destination, subject, body, status, sent_at)
              VALUES (${tenantId}, ${type}, 'whatsapp', ${to}, null, ${(text || "").slice(0, 4000)},
                      ${status}, ${status === "sent" ? new Date().toISOString() : null})`;
  } catch (e) { console.error("[notify:whatsapp] log falhou (nao-fatal):", e?.message || e); }
  return { status, err };
}

// Link wa.me pronto (fallback sempre disponivel, mesmo sem Cloud API).
export function waLink(phone, text) {
  return `https://wa.me/${(phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(text || "")}`;
}

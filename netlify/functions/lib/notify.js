// Notificacoes: e-mail (Resend, best-effort) e WhatsApp (Meta Cloud API).
// Toda notificacao e registrada em `notifications` para auditoria.
//
// IMPORTANTE: a plataforma NAO expoe mais configuracao de e-mail transacional no
// painel. As notificacoes operacionais (vencimentos, pendencias, status de
// licenca) vivem DENTRO do Painel do Dono (central de Notificacoes). O e-mail
// continua disponivel apenas como canal BEST-EFFORT: se a env RESEND_API_KEY
// estiver definida no servidor, os avisos transacionais sao enviados; caso
// contrario o envio e apenas registrado como "queued" e nada quebra.
import { sql } from "./db.js";
import { getSetting } from "./settings.js";

// Config do e-mail via Resend, lida da env (com precedencia de painel caso a
// chave ainda exista em platform_settings). Sem chave => configured=false e o
// envio degrada para "queued" sem afetar a operacao principal.
export async function emailConfig() {
  const [key, fromName, fromEmail] = await Promise.all([
    getSetting("RESEND_API_KEY", "RESEND_API_KEY", ""),
    getSetting("NOTIFY_FROM_NAME", "NOTIFY_FROM_NAME", "DPO PJ Protection"),
    getSetting("NOTIFY_FROM_EMAIL", "NOTIFY_FROM_EMAIL", "contato@dpopjprotection.com.br"),
  ]);
  const resendOk = !!(key && key.trim());
  return { provider: "resend", key: key || "", fromName, fromEmail, resendOk, configured: resendOk };
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

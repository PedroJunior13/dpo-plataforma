// Notificacoes: e-mail (Resend) e WhatsApp (Meta Cloud API).
// Toda notificacao e registrada em `notifications` para auditoria.
import { sql } from "./db.js";

export async function sendEmail({ tenantId = null, to, subject, html, type = "info" }) {
  let status = "queued", err = null;
  if (process.env.RESEND_API_KEY && to) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${process.env.NOTIFY_FROM_NAME || "DPO PJ Protection"} <${process.env.NOTIFY_FROM_EMAIL || "contato@dpopjprotection.com.br"}>`,
          to: [to], subject, html,
        }),
      });
      status = r.ok ? "sent" : "error";
      if (!r.ok) err = await r.text();
    } catch (e) { status = "error"; err = e.message; }
  }
  await sql`INSERT INTO notifications (tenant_id, type, channel, destination, subject, body, status, sent_at)
            VALUES (${tenantId}, ${type}, 'email', ${to}, ${subject}, ${(html || "").slice(0, 4000)},
                    ${status}, ${status === "sent" ? new Date().toISOString() : null})`;
  return { status, err };
}

export async function sendWhatsApp({ tenantId = null, to, text, type = "info" }) {
  let status = "queued", err = null;
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId && to) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/\D/g, ""), type: "text", text: { body: text } }),
      });
      status = r.ok ? "sent" : "error";
      if (!r.ok) err = await r.text();
    } catch (e) { status = "error"; err = e.message; }
  }
  await sql`INSERT INTO notifications (tenant_id, type, channel, destination, subject, body, status, sent_at)
            VALUES (${tenantId}, ${type}, 'whatsapp', ${to}, null, ${(text || "").slice(0, 4000)},
                    ${status}, ${status === "sent" ? new Date().toISOString() : null})`;
  return { status, err };
}

// Link wa.me pronto (fallback sempre disponivel, mesmo sem Cloud API).
export function waLink(phone, text) {
  return `https://wa.me/${(phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(text || "")}`;
}

// Notificacoes: e-mail (Resend OU SMTP) e WhatsApp (Meta Cloud API).
// Toda notificacao e registrada em `notifications` para auditoria.
import { sql } from "./db.js";
import { getSetting } from "./settings.js";
import net from "node:net";
import tls from "node:tls";

// Config do e-mail transacional com PRECEDENCIA do painel (Integracoes) sobre a
// env. Dois provedores possiveis:
//   - "resend": API HTTP do Resend (requer conta + dominio verificado).
//   - "smtp":   qualquer caixa de e-mail que o Dono JA tenha (Gmail com senha de
//               app, e-mail do proprio dominio, etc.) — dispensa criar conta nova
//               de servico transacional e verificar dominio em terceiros.
// Se nada estiver configurado, o envio e apenas registrado como "queued" (sem
// quebrar o fluxo principal — abrir chamado/gerar licenca nunca falha por e-mail).
export async function emailConfig() {
  const [key, fromName, fromEmail, provider, host, port, secure, user, pass] = await Promise.all([
    getSetting("RESEND_API_KEY", "RESEND_API_KEY", ""),
    getSetting("NOTIFY_FROM_NAME", "NOTIFY_FROM_NAME", "DPO PJ Protection"),
    getSetting("NOTIFY_FROM_EMAIL", "NOTIFY_FROM_EMAIL", "contato@dpopjprotection.com.br"),
    getSetting("EMAIL_PROVIDER", "EMAIL_PROVIDER", ""),
    getSetting("SMTP_HOST", "SMTP_HOST", ""),
    getSetting("SMTP_PORT", "SMTP_PORT", ""),
    getSetting("SMTP_SECURE", "SMTP_SECURE", ""),
    getSetting("SMTP_USER", "SMTP_USER", ""),
    getSetting("SMTP_PASS", "SMTP_PASS", ""),
  ]);
  const smtp = {
    host: (host || "").trim(),
    port: parseInt(port, 10) || 465,
    // secure=true => TLS implicito (465). false => STARTTLS (587).
    secure: secure ? /^(1|true|ssl|yes)$/i.test(String(secure).trim()) : (parseInt(port, 10) !== 587),
    user: (user || "").trim(),
    pass: pass || "",
  };
  // Provedor efetivo: respeita a escolha do painel; se vazio, deduz pelo que estiver
  // preenchido (SMTP tem prioridade so quando o Resend nao tem chave).
  let prov = (provider || "").trim().toLowerCase();
  const resendOk = !!(key && key.trim());
  const smtpOk = !!(smtp.host && smtp.user && smtp.pass);
  if (prov !== "resend" && prov !== "smtp") prov = resendOk ? "resend" : (smtpOk ? "smtp" : "resend");
  const configured = prov === "smtp" ? smtpOk : resendOk;
  return { provider: prov, key: key || "", fromName, fromEmail, smtp, resendOk, smtpOk, configured };
}

// ---- Cliente SMTP minimo, SEM dependencias (node:net + node:tls) ----
// Evita adicionar pacotes ao package.json (o Dono faz deploy pelo GitHub web, sem
// npm local) e nao arrisca quebrar o build. Suporta AUTH LOGIN sobre TLS implicito
// (465) e STARTTLS (587). Em caso de erro, apenas retorna status "error" — nunca
// lanca para o chamador (o e-mail e sempre best-effort).
function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }
function mimeHeader(s) { return /^[\x00-\x7F]*$/.test(s || "") ? (s || "") : `=?UTF-8?B?${b64(s)}?=`; }

async function sendViaSmtp({ smtp, fromName, fromEmail, to, subject, html }) {
  return new Promise((resolve) => {
    let socket, buf = "", waiter = null, settled = false;
    const finish = (status, err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { socket && socket.destroy(); } catch (_) {}
      resolve({ status, err: err || null });
    };
    const timer = setTimeout(() => finish("error", "smtp timeout"), (FETCH_TIMEOUT_MS + 6000));

    // Extrai uma resposta SMTP completa (ultima linha = "NNN " com espaco apos o codigo).
    const tryExtract = () => {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const consumed = lines.slice(0, i + 1).join("\r\n").length + 2;
          const code = parseInt(lines[i].slice(0, 3), 10);
          buf = buf.slice(consumed);
          return code;
        }
      }
      return null;
    };
    const onData = (d) => {
      buf += d.toString("utf8");
      if (waiter) { const c = tryExtract(); if (c != null) { const w = waiter; waiter = null; w(c); } }
    };
    const expect = () => new Promise((res) => {
      const c = tryExtract(); if (c != null) return res(c);
      waiter = res;
    });
    const send = (line) => socket.write(line + "\r\n");

    const domain = (fromEmail.split("@")[1] || "dpopjprotection.com.br");
    const buildMessage = () => {
      const b = Buffer.from(html || "", "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
      return [
        `From: ${mimeHeader(fromName)} <${fromEmail}>`,
        `To: ${to}`,
        `Subject: ${mimeHeader(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``, b,
      ].join("\r\n");
    };

    const converse = async (afterTls) => {
      try {
        let code;
        if (!afterTls) { code = await expect(); if (code !== 220) return finish("error", "greeting " + code); }
        send(`EHLO ${domain}`); code = await expect(); if (code !== 250) return finish("error", "ehlo " + code);
        send(`AUTH LOGIN`); code = await expect(); if (code !== 334) return finish("error", "auth-start " + code);
        send(b64(smtp.user)); code = await expect(); if (code !== 334) return finish("error", "auth-user " + code);
        send(b64(smtp.pass)); code = await expect(); if (code !== 235) return finish("error", "auth-fail " + code);
        send(`MAIL FROM:<${fromEmail}>`); code = await expect(); if (code !== 250) return finish("error", "mailfrom " + code);
        send(`RCPT TO:<${to}>`); code = await expect(); if (code !== 250 && code !== 251) return finish("error", "rcpt " + code);
        send(`DATA`); code = await expect(); if (code !== 354) return finish("error", "data " + code);
        socket.write(buildMessage() + "\r\n.\r\n");
        code = await expect(); if (code !== 250) return finish("error", "send " + code);
        send(`QUIT`);
        finish("sent", null);
      } catch (e) { finish("error", e?.message || String(e)); }
    };

    try {
      if (smtp.secure) {
        // TLS implicito (porta 465).
        socket = tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host }, () => converse(false));
        socket.on("data", onData);
        socket.on("error", (e) => finish("error", e.message));
      } else {
        // Texto puro + STARTTLS (porta 587).
        const plain = net.connect({ host: smtp.host, port: smtp.port }, async () => {
          try {
            let code = await expect(); if (code !== 220) return finish("error", "greeting " + code);
            send(`EHLO ${domain}`); code = await expect(); if (code !== 250) return finish("error", "ehlo " + code);
            send(`STARTTLS`); code = await expect(); if (code !== 220) return finish("error", "starttls " + code);
            plain.removeListener("data", onData);
            socket = tls.connect({ socket: plain, host: smtp.host, servername: smtp.host }, () => converse(true));
            socket.on("data", onData);
            socket.on("error", (e) => finish("error", e.message));
          } catch (e) { finish("error", e?.message || String(e)); }
        });
        socket = plain;
        plain.on("data", onData);
        plain.on("error", (e) => finish("error", e.message));
      }
    } catch (e) { finish("error", e?.message || String(e)); }
  });
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
    if (cfg.provider === "smtp") {
      const r = await sendViaSmtp({ smtp: cfg.smtp, fromName: cfg.fromName, fromEmail: cfg.fromEmail, to, subject, html });
      status = r.status; err = r.err;
    } else {
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

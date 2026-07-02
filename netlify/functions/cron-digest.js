// Tarefa agendada — RESUMO SEMANAL DO DONO (segunda 12:00 UTC ≈ 09:00 BRT).
// Envia, por e-mail, um retrato do negocio para o dono "saber na hora" sem precisar
// abrir o painel: receita, novos assinantes, compras a liberar, vencimentos proximos
// e — o mais sensivel ao tempo — os CHAMADOS DE SUPORTE aguardando 1a resposta com o
// tempo de espera (SLA). E 100% somente-leitura: nao altera nenhum dado, apenas le e
// dispara 1 e-mail. Reaproveitavel pelo painel (botao "Enviar resumo agora").
import { sql } from "./lib/db.js";
import { sendEmail, emailConfig } from "./lib/notify.js";

export const config = { schedule: "0 12 * * 1" };

const OWNER_EMAIL = () => process.env.SUPPORT_EMAIL || process.env.OWNER_EMAIL || "pedrobj@gmail.com";
const brl = (c) => "R$ " + ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dtBR = (d) => (d ? new Date(d).toLocaleDateString("pt-BR") : "—");
async function safe(p, fb) { try { return await p; } catch (e) { console.error("[digest]", e?.message || e); return fb; } }
const first = (rows) => (Array.isArray(rows) && rows[0]) || null;

// Coleta todos os numeros do negocio (somente-leitura, tolerante a falhas parciais).
export async function buildDigest() {
  const totals = first(await safe(sql`
    SELECT
      (SELECT count(*)::int FROM tenants t WHERE t.is_owner=FALSE AND COALESCE(t.is_demo,FALSE)=FALSE
          AND EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id=t.id)) AS subscribers,
      (SELECT count(*)::int FROM tenants t WHERE t.is_owner=FALSE AND COALESCE(t.is_demo,FALSE)=FALSE
          AND t.status='active' AND EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id=t.id AND l.status='active')) AS active,
      (SELECT count(*)::int FROM tenants WHERE status IN ('suspended','blocked')) AS blocked,
      (SELECT count(*)::int FROM licenses WHERE status='active') AS active_licenses,
      (SELECT count(*)::int FROM licenses WHERE status='issued') AS pending_activation,
      (SELECT count(*)::int FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
         WHERE t.is_owner=FALSE AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id=t.id)) AS pending_purchases`),
    { subscribers: 0, active: 0, blocked: 0, active_licenses: 0, pending_activation: 0, pending_purchases: 0 }) || {};

  const mrr = (first(await safe(sql`SELECT coalesce(sum(amount_cents),0)::int AS cents FROM subscriptions WHERE status='active'`, null)) || { cents: 0 }).cents;

  // Novos assinantes e receita aprovada nos ultimos 7 dias.
  const newSubs = (first(await safe(sql`
    SELECT count(*)::int AS n FROM tenants t
    WHERE t.is_owner=FALSE AND COALESCE(t.is_demo,FALSE)=FALSE
      AND t.created_at > now() - interval '7 days'
      AND EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id=t.id)`, null)) || { n: 0 }).n;
  const revenue7d = (first(await safe(sql`
    SELECT coalesce(sum(amount_cents),0)::int AS cents, count(*)::int AS n
    FROM payments WHERE status='approved' AND coalesce(paid_at, created_at) > now() - interval '7 days'`, null)) || { cents: 0, n: 0 });

  // Vencimentos: assinaturas que vencem (ou venceram) na janela de 7 dias.
  const overdue = await safe(sql`
    SELECT t.name, t.email, s.current_period_end, p.name AS plan_name
    FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN plans p ON p.id=s.plan_id
    WHERE t.is_owner=FALSE AND s.current_period_end IS NOT NULL
      AND s.current_period_end < now() + interval '7 days'
    ORDER BY s.current_period_end ASC LIMIT 30`, []);

  // Licencas avulsas (sem assinatura) que vencem em 7 dias.
  const expiringLic = await safe(sql`
    SELECT t.name, t.email, l.valid_until, p.name AS plan_name
    FROM licenses l JOIN tenants t ON t.id=l.tenant_id LEFT JOIN plans p ON p.id=l.plan_id
    WHERE t.is_owner=FALSE AND COALESCE(t.is_demo,FALSE)=FALSE AND l.status='active'
      AND l.valid_until IS NOT NULL AND l.valid_until < now() + interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id=t.id AND s.current_period_end IS NOT NULL)
    ORDER BY l.valid_until ASC LIMIT 30`, []);

  // SUPORTE — chamados abertos e, principalmente, os que ainda aguardam 1a resposta.
  const tks = first(await safe(sql`
    SELECT
      count(*) FILTER (WHERE status IN ('aberto','em_andamento','aguardando_cliente'))::int AS open,
      count(*) FILTER (WHERE first_response_at IS NULL AND status <> 'fechado' AND status <> 'resolvido')::int AS awaiting_first,
      count(*) FILTER (WHERE last_actor='cliente' AND status IN ('aberto','em_andamento'))::int AS awaiting_reply
    FROM support_tickets`, null)) || { open: 0, awaiting_first: 0, awaiting_reply: 0 };
  // Fila detalhada: os mais antigos sem 1a resposta (com horas de espera para SLA).
  const oldest = await safe(sql`
    SELECT ticket_no, subject, priority, opener_name, opener_email, created_at,
           round(EXTRACT(EPOCH FROM (now() - created_at))/3600)::int AS hours
    FROM support_tickets
    WHERE first_response_at IS NULL AND status NOT IN ('fechado','resolvido')
    ORDER BY created_at ASC LIMIT 10`, []);

  const emailConfigured = (await safe(emailConfig(), { configured: false })).configured;
  return {
    generatedAt: new Date().toISOString(),
    totals, mrrCents: mrr, newSubs,
    revenue7dCents: revenue7d.cents, payments7d: revenue7d.n,
    overdue, expiringLic, tickets: tks, oldestTickets: oldest,
    emailConfigured, inbox: OWNER_EMAIL(),
  };
}

// Monta o HTML do e-mail (visual sobrio, navy + dourado da marca).
export function renderDigestHtml(d) {
  const t = d.totals || {};
  const card = (label, val, hint) =>
    `<td style="padding:10px 12px;border:1px solid #1e3350;border-radius:10px;background:#0b1a31;vertical-align:top">
       <div style="font-size:11px;color:#8fb0d9;text-transform:uppercase;letter-spacing:.5px">${label}</div>
       <div style="font-size:22px;font-weight:800;color:#e9f1fb;margin-top:2px">${val}</div>
       ${hint ? `<div style="font-size:11px;color:#7f97b5;margin-top:2px">${hint}</div>` : ""}
     </td>`;
  const row = (cells) => `<table role="presentation" width="100%" cellspacing="8" cellpadding="0"><tr>${cells.join("")}</tr></table>`;

  const listRows = (arr, dateField, label) => arr.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:6px">
         ${arr.map((o) => {
           const end = new Date(o[dateField]).getTime();
           const days = Math.ceil((end - Date.now()) / 864e5);
           const tag = days < 0 ? `<span style="color:#ff9aa8">${Math.abs(days)}d atrasado</span>` : `em ${days}d`;
           return `<tr>
             <td style="padding:6px 8px;border-bottom:1px solid #16283f;color:#cfe0f7;font-size:13px">${esc(o.name)}<div style="color:#7f97b5;font-size:11px">${esc(o.plan_name || "")}</div></td>
             <td style="padding:6px 8px;border-bottom:1px solid #16283f;color:#cfe0f7;font-size:13px;text-align:right">${dtBR(o[dateField])}<div style="color:#7f97b5;font-size:11px">${tag}</div></td>
           </tr>`;
         }).join("")}
       </table>`
    : `<div style="color:#7f97b5;font-size:13px;margin-top:6px">Nenhum ${label}. 🎉</div>`;

  const ticketRows = (d.oldestTickets || []).length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:6px">
         ${d.oldestTickets.map((k) => {
           const warn = k.hours >= 24;
           return `<tr>
             <td style="padding:6px 8px;border-bottom:1px solid #16283f;color:#cfe0f7;font-size:13px">#${k.ticket_no} · ${esc(k.subject || "")}<div style="color:#7f97b5;font-size:11px">${esc(k.opener_name || k.opener_email || "")} · ${esc(k.priority || "normal")}</div></td>
             <td style="padding:6px 8px;border-bottom:1px solid #16283f;font-size:13px;text-align:right;color:${warn ? "#ff9aa8" : "#f3d171"};font-weight:700">${k.hours}h${warn ? " ⚠️" : ""}</td>
           </tr>`;
         }).join("")}
       </table>`
    : `<div style="color:#8fe6a0;font-size:13px;margin-top:6px">Nenhum chamado aguardando 1ª resposta. 🎉</div>`;

  // Aviso operacional dentro do resumo: os avisos por licenca vivem no Painel →
  // Notificacoes (nao dependem de e-mail). O e-mail é apenas um canal opcional.
  const emailWarn = "";

  return `<div style="background:#071223;padding:24px;font-family:Segoe UI,Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;background:#0a1730;border:1px solid #1e3350;border-radius:16px;overflow:hidden">
      <div style="padding:20px 22px;background:linear-gradient(135deg,#0d213f,#0a1730);border-bottom:1px solid #1e3350">
        <div style="font-size:18px;font-weight:800;color:#e9f1fb">DPO PJ <span style="color:#d9a441">Protection</span></div>
        <div style="font-size:13px;color:#8fb0d9;margin-top:2px">Resumo semanal do negócio · ${dtBR(d.generatedAt)}</div>
      </div>
      <div style="padding:18px 20px">
        ${emailWarn}
        <h3 style="color:#e9f1fb;font-size:14px;margin:4px 0 8px">Visão geral</h3>
        ${row([card("Assinantes", t.subscribers || 0, `${t.active || 0} ativos`), card("Receita recorrente", brl(d.mrrCents), "MRR ativo"), card("Novos (7d)", d.newSubs || 0, "com licença")])}
        ${row([card("Receita aprovada (7d)", brl(d.revenue7dCents), `${d.payments7d || 0} pagamento(s)`), card("Compras a liberar", t.pending_purchases || 0, "gerar licença"), card("Bloqueados", t.blocked || 0, "inadimplência")])}

        <h3 style="color:#e9f1fb;font-size:14px;margin:18px 0 4px">🎧 Suporte — atenção ao SLA</h3>
        <div style="color:#8fb0d9;font-size:13px">Abertos: <b style="color:#e9f1fb">${d.tickets.open}</b> · Aguardando 1ª resposta: <b style="color:${d.tickets.awaiting_first ? "#f3d171" : "#8fe6a0"}">${d.tickets.awaiting_first}</b> · Aguardando você responder: <b style="color:${d.tickets.awaiting_reply ? "#f3d171" : "#8fe6a0"}">${d.tickets.awaiting_reply}</b></div>
        ${ticketRows}

        <h3 style="color:#e9f1fb;font-size:14px;margin:18px 0 4px">📅 Vencimentos (próximos 7 dias)</h3>
        ${listRows(d.overdue || [], "current_period_end", "vencimento próximo")}
        ${(d.expiringLic || []).length ? `<h4 style="color:#8fb0d9;font-size:12px;margin:12px 0 0">Licenças avulsas</h4>${listRows(d.expiringLic, "valid_until", "avulsa vencendo")}` : ""}

        <div style="margin-top:20px;text-align:center">
          <a href="https://app.dpopjprotection.com.br/painel" style="display:inline-block;background:linear-gradient(135deg,#d9a441,#c78f2e);color:#1a1205;font-weight:800;text-decoration:none;padding:10px 22px;border-radius:10px;font-size:13px">Abrir o painel</a>
        </div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid #1e3350;color:#5f7794;font-size:11px;text-align:center">
        PJ Technology Solutions · CNPJ 36.741.351/0001-09 · Resumo automático — você recebe toda segunda-feira.
      </div>
    </div>
  </div>`;
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Envia o resumo agora (usado pelo agendador e pelo botao do painel).
export async function runDigest({ to = null } = {}) {
  const data = await buildDigest();
  const dest = to || OWNER_EMAIL();
  const email = await sendEmail({
    to: dest, type: "owner_digest",
    subject: `Resumo semanal — DPO PJ Protection (${dtBR(data.generatedAt)})`,
    html: renderDigestHtml(data),
  });
  return { data, email, to: dest };
}

export default async function handler() {
  try {
    const r = await runDigest();
    console.log(`[cron-digest] enviado para ${r.to} (status=${r.email?.status})`);
    return new Response(JSON.stringify({ ok: true, to: r.to, status: r.email?.status }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[cron-digest] falhou:", e?.message || e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

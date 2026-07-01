// Tarefa agendada (diaria 09:00 UTC) — ciclo de cobranca/bloqueio:
//   1) avisa vencimentos proximos (3 dias)
//   2) entra em carencia no vencimento
//   3) BLOQUEIA (kill-switch) apos a carencia
//   4) atualiza notas fiscais pendentes
import { sql } from "./lib/db.js";
import { licenseEvent, audit } from "./lib/audit.js";
import { sendEmail } from "./lib/notify.js";

export const config = { schedule: "0 9 * * *" };

const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || "5", 10);

export default async function handler() {
  const now = Date.now();
  let warned = 0, graced = 0, blocked = 0;

  // Tenants nao-dono com periodo pago conhecido
  const rows = await sql`
    SELECT t.*, s.id AS sub_id, s.current_period_end, s.billing_type
    FROM tenants t
    JOIN subscriptions s ON s.id = (SELECT id FROM subscriptions WHERE tenant_id=t.id ORDER BY created_at DESC LIMIT 1)
    WHERE t.is_owner = FALSE AND t.status NOT IN ('canceled')`;

  for (const t of rows) {
    if (!t.current_period_end) continue;
    const end = new Date(t.current_period_end).getTime();
    const daysToEnd = Math.ceil((end - now) / 864e5);
    const overdueDays = Math.floor((now - end) / 864e5);

    // 1) Aviso ate 3 dias antes — dispara 1x por periodo (idempotente).
    //    Antes exigia daysToEnd === 3 EXATO: se o cron pulasse esse dia (deploy/cold
    //    start) o cliente nunca era avisado. Agora avisa em qualquer dia da janela
    //    (1..3) e grava o period_end avisado para nao repetir.
    const alreadyWarned = t.expiring_warned_for && new Date(t.expiring_warned_for).getTime() === end;
    if (daysToEnd >= 1 && daysToEnd <= 3 && t.status === "active" && t.email && !alreadyWarned) {
      await sendEmail({ tenantId: t.id, to: t.email, type: "expiring",
        subject: `Sua assinatura vence em ${daysToEnd} dia(s) — DPO PJ Protection`,
        html: `<p>Sua assinatura vence em <b>${new Date(end).toLocaleDateString("pt-BR")}</b>. ${t.billing_type === "recurring" ? "A renovacao e automatica." : "Renove para manter o acesso."}</p>` });
      try { await sql`UPDATE tenants SET expiring_warned_for=${t.current_period_end} WHERE id=${t.id}`; } catch (e) { console.error("[cron-billing] marca aviso (nao-fatal):", e?.message || e); }
      warned++;
    }

    // 2) Carencia ao vencer (avulso ou recorrente com falha)
    if (overdueDays >= 0 && overdueDays < GRACE_DAYS && t.status === "active") {
      await sql`UPDATE tenants SET status='grace', updated_at=now() WHERE id=${t.id}`;
      if (t.email) await sendEmail({ tenantId: t.id, to: t.email, type: "overdue",
        subject: "Pagamento pendente — acao necessaria",
        html: `<p>Identificamos pendencia no pagamento. Voce tem ${GRACE_DAYS} dias de carencia antes do bloqueio. Regularize para evitar a interrupcao.</p>` });
      graced++;
    }

    // 3) Bloqueio apos carencia
    if (overdueDays >= GRACE_DAYS && ["active", "grace"].includes(t.status)) {
      await sql`UPDATE tenants SET status='blocked', updated_at=now() WHERE id=${t.id}`;
      const lic = await sql`SELECT id FROM licenses WHERE tenant_id=${t.id} AND status='active' ORDER BY created_at DESC LIMIT 1`;
      if (lic[0]) {
        await sql`UPDATE licenses SET status='suspended', version=version+1, updated_at=now() WHERE id=${lic[0].id}`;
        await licenseEvent({ licenseId: lic[0].id, tenantId: t.id, event: "suspended", actorEmail: "system", note: `Bloqueio automatico por inadimplencia (${overdueDays} dias).` });
      }
      await audit({ tenantId: t.id, actorEmail: "system", action: "auto_blocked", detail: { overdueDays } });
      if (t.email) await sendEmail({ tenantId: t.id, to: t.email, type: "blocked",
        subject: "Acesso suspenso — DPO PJ Protection",
        html: `<p>Seu acesso foi suspenso por falta de pagamento. Assim que regularizar, a reativacao e automatica.</p>` });
      blocked++;
    }
  }

  // 3b) Licencas AVULSAS por validade (valid_until) SEM assinatura recorrente —
  //     ex.: emitidas pelo dono (mensal/anual/cortesia/personalizada). O kill-switch
  //     (checkAccess) ja barra no login; aqui refletimos o bloqueio tambem no
  //     status do tenant/licenca para a gestao no painel e os alertas por e-mail.
  let warnedAvu = 0, blockedAvu = 0;
  // Query tolerante: se a coluna expiring_warned_for ainda nao migrou, cai no
  // fallback sem ela (o aviso pode repetir ate a migracao aplicar — sem quebrar o cron).
  let avu;
  try {
    avu = await sql`
      SELECT l.id AS lic_id, l.valid_until, l.expiring_warned_for, t.id AS tenant_id, t.name, t.email, t.status
      FROM licenses l JOIN tenants t ON t.id = l.tenant_id
      WHERE t.is_owner = FALSE AND COALESCE(t.is_demo,FALSE) = FALSE
        AND l.status = 'active' AND l.valid_until IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id AND s.current_period_end IS NOT NULL)`;
  } catch (e) {
    console.error("[cron-billing] avu com coluna nova falhou, usando fallback:", e?.message || e);
    avu = await sql`
      SELECT l.id AS lic_id, l.valid_until, NULL AS expiring_warned_for, t.id AS tenant_id, t.name, t.email, t.status
      FROM licenses l JOIN tenants t ON t.id = l.tenant_id
      WHERE t.is_owner = FALSE AND COALESCE(t.is_demo,FALSE) = FALSE
        AND l.status = 'active' AND l.valid_until IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id AND s.current_period_end IS NOT NULL)`;
  }
  for (const l of avu) {
    const end = new Date(l.valid_until).getTime();
    const daysToEnd = Math.ceil((end - now) / 864e5);
    const overdueDays = Math.floor((now - end) / 864e5);
    const licWarned = l.expiring_warned_for && new Date(l.expiring_warned_for).getTime() === end;
    if (daysToEnd >= 1 && daysToEnd <= 3 && l.status === "active" && l.email && !licWarned) {
      await sendEmail({ tenantId: l.tenant_id, to: l.email, type: "expiring",
        subject: `Sua licenca vence em ${daysToEnd} dia(s) — DPO PJ Protection`,
        html: `<p>Sua licenca vence em <b>${new Date(end).toLocaleDateString("pt-BR")}</b>. Renove para manter o acesso.</p>` });
      try { await sql`UPDATE licenses SET expiring_warned_for=${l.valid_until} WHERE id=${l.lic_id}`; } catch (e) { console.error("[cron-billing] marca aviso licenca (nao-fatal):", e?.message || e); }
      warnedAvu++;
    }
    if (overdueDays >= GRACE_DAYS && ["active", "grace"].includes(l.status)) {
      await sql`UPDATE tenants SET status='blocked', updated_at=now() WHERE id=${l.tenant_id}`;
      await sql`UPDATE licenses SET status='suspended', version=version+1, updated_at=now() WHERE id=${l.lic_id}`;
      await licenseEvent({ licenseId: l.lic_id, tenantId: l.tenant_id, event: "suspended", actorEmail: "system", note: `Bloqueio automatico por vencimento da licenca avulsa (${overdueDays} dias).` });
      await audit({ tenantId: l.tenant_id, actorEmail: "system", action: "auto_blocked", detail: { overdueDays, kind: "avulsa" } });
      if (l.email) await sendEmail({ tenantId: l.tenant_id, to: l.email, type: "blocked",
        subject: "Acesso suspenso — DPO PJ Protection",
        html: `<p>Seu acesso foi suspenso por vencimento da licenca. Assim que regularizar, a reativacao e automatica.</p>` });
      blockedAvu++;
    }
  }
  warned += warnedAvu; blocked += blockedAvu;

  // 4) Atualiza NFS-e em processamento (best-effort)
  try {
    const nfse = await import("./lib/nfse.js");
    if (await nfse.enabled()) {
      const pend = await sql`SELECT id FROM invoices WHERE status IN ('processing','pending') ORDER BY created_at DESC LIMIT 30`;
      for (const inv of pend) { try { await nfse.refreshInvoice(inv.id); } catch {} }
    }
  } catch {}

  console.log(`[cron-billing] warned=${warned} graced=${graced} blocked=${blocked}`);
  return new Response(JSON.stringify({ ok: true, warned, graced, blocked }), { status: 200, headers: { "Content-Type": "application/json" } });
}

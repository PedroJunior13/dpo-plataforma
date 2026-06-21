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

    // 1) Aviso 3 dias antes
    if (daysToEnd === 3 && t.status === "active" && t.email) {
      await sendEmail({ tenantId: t.id, to: t.email, type: "expiring",
        subject: "Sua assinatura vence em 3 dias — DPO PJ Protection",
        html: `<p>Sua assinatura vence em <b>${new Date(end).toLocaleDateString("pt-BR")}</b>. ${t.billing_type === "recurring" ? "A renovacao e automatica." : "Renove para manter o acesso."}</p>` });
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

  // 4) Atualiza NFS-e em processamento (best-effort)
  try {
    const nfse = await import("./lib/nfse.js");
    if (nfse.enabled()) {
      const pend = await sql`SELECT id FROM invoices WHERE status IN ('processing','pending') ORDER BY created_at DESC LIMIT 30`;
      for (const inv of pend) { try { await nfse.refreshInvoice(inv.id); } catch {} }
    }
  } catch {}

  console.log(`[cron-billing] warned=${warned} graced=${graced} blocked=${blocked}`);
  return new Response(JSON.stringify({ ok: true, warned, graced, blocked }), { status: 200, headers: { "Content-Type": "application/json" } });
}

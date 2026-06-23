// Logica comum dos webhooks: confirma pagamento -> ativa/renova ou bloqueia.
import { sql, one } from "./db.js";
import { audit } from "./audit.js";
import { licenseEvent } from "./audit.js";
import { sendEmail } from "./notify.js";
import * as nfse from "./nfse.js";

// Estende a janela paga conforme o CICLO (1 mes ou 1 ano) a partir de agora
// (ou do fim atual). Se houver dia de vencimento escolhido (1-28), ajusta a data.
function nextPeriodEnd(currentEnd, cycle, dueDay) {
  const base = currentEnd && new Date(currentEnd) > new Date() ? new Date(currentEnd) : new Date();
  const d = new Date(base);
  if (cycle === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  const dd = parseInt(dueDay, 10);
  if (Number.isFinite(dd) && dd >= 1 && dd <= 28) d.setDate(dd);
  return d.toISOString();
}

// Pagamento APROVADO: ativa tenant, estende periodo, ativa licenca, emite NFS-e.
export async function onPaymentApproved({ tenantId, gateway, gatewayPaymentId, amountCents, method, raw }) {
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${tenantId}`);
  if (!tenant) { console.warn("[webhook] tenant nao encontrado", tenantId); return; }

  const sub = await one(sql`SELECT * FROM subscriptions WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  const periodEnd = nextPeriodEnd(sub?.current_period_end, sub?.billing_cycle, sub?.due_day);

  // Registra/atualiza pagamento
  const pay = await one(sql`
    INSERT INTO payments (tenant_id, subscription_id, gateway, gateway_payment_id, method, amount_cents, status, paid_at, raw)
    VALUES (${tenantId}, ${sub?.id || null}, ${gateway}, ${gatewayPaymentId}, ${method || null}, ${amountCents || sub?.amount_cents || 0}, 'approved', now(), ${raw ? JSON.stringify(raw).slice(0, 6000) : null})
    RETURNING *`);

  if (sub) await sql`UPDATE subscriptions SET status='active', current_period_start=now(), current_period_end=${periodEnd}, updated_at=now() WHERE id=${sub.id}`;
  await sql`UPDATE tenants SET status='active', updated_at=now() WHERE id=${tenantId}`;

  // Ativa/renova licenca do tenant; estende validade do avulso.
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (lic) {
    await sql`UPDATE licenses SET status='active', valid_until=${periodEnd}, version=version+1, updated_at=now() WHERE id=${lic.id}`;
    await licenseEvent({ licenseId: lic.id, tenantId, event: "renewed", actorEmail: "system", after: { valid_until: periodEnd }, note: `Pagamento aprovado via ${gateway}.` });
  }
  await audit({ tenantId, actorEmail: "system", action: "payment_approved", entity: "payment", entityId: pay.id, detail: { gateway, amountCents } });

  // NFS-e automatica (se configurada)
  if (await nfse.enabled()) { try { await nfse.issueForPayment(pay.id); } catch (e) { console.error("[nfse]", e.message); } }

  // Aviso ao cliente
  if (tenant.email) {
    await sendEmail({ tenantId, to: tenant.email, type: "payment_approved",
      subject: "Pagamento confirmado — DPO PJ Protection",
      html: `<p>Recebemos seu pagamento. Seu acesso esta ativo ate <b>${new Date(periodEnd).toLocaleDateString("pt-BR")}</b>.</p>` });
  }
}

// Pagamento RECUSADO/expirado de assinatura: marca past_due (cron decide bloqueio).
export async function onPaymentFailed({ tenantId, gateway, gatewayPaymentId, raw }) {
  const sub = await one(sql`SELECT * FROM subscriptions WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (sub) await sql`UPDATE subscriptions SET status='past_due', updated_at=now() WHERE id=${sub.id}`;
  await sql`INSERT INTO payments (tenant_id, subscription_id, gateway, gateway_payment_id, status, raw)
            VALUES (${tenantId}, ${sub?.id || null}, ${gateway}, ${gatewayPaymentId}, 'rejected', ${raw ? JSON.stringify(raw).slice(0, 4000) : null})`;
  await audit({ tenantId, actorEmail: "system", action: "payment_failed", detail: { gateway } });
}

// Assinatura cancelada no gateway.
export async function onSubscriptionCanceled({ tenantId, gateway }) {
  const sub = await one(sql`SELECT * FROM subscriptions WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (sub) await sql`UPDATE subscriptions SET status='canceled', cancel_at_period_end=TRUE, updated_at=now() WHERE id=${sub.id}`;
  await audit({ tenantId, actorEmail: "system", action: "subscription_canceled", detail: { gateway } });
}

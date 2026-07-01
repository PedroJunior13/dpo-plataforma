// Logica comum dos webhooks: confirma pagamento -> ativa/renova ou bloqueia.
import { sql, one } from "./db.js";
import { audit } from "./audit.js";
import { licenseEvent } from "./audit.js";
import { sendEmail } from "./notify.js";
import * as nfse from "./nfse.js";
import { issueLicense, activationLink } from "./licenses.js";

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
  let lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (lic) {
    await sql`UPDATE licenses SET status='active', valid_until=${periodEnd}, version=version+1, updated_at=now() WHERE id=${lic.id}`;
    await licenseEvent({ licenseId: lic.id, tenantId, event: "renewed", actorEmail: "system", after: { valid_until: periodEnd }, note: `Pagamento aprovado via ${gateway}.` });
  } else {
    // RECONHECIMENTO DO MODULO ESCOLHIDO NA COMPRA: uma compra nova pelo site cria
    // tenant + assinatura (com o plano escolhido) mas ainda SEM licenca. Ao confirmar
    // o pagamento, emitimos a licenca automaticamente para o MODULO contratado
    // (tenant.plan_id vem do checkout) e enviamos o link de ativacao ao cliente.
    try {
      const issued = await issueLicense({
        tenantId, tenant, planId: tenant.plan_id || sub?.plan_id || "basic",
        billingType: sub?.billing_type || "monthly",
        billingCycle: sub?.billing_cycle || "monthly",
        subscriptionId: sub?.id || null,
        validUntil: periodEnd, dueDay: sub?.due_day || null,
        actor: { email: "system", name: "Pagamento aprovado" },
      });
      lic = issued.license;
      await licenseEvent({ licenseId: lic.id, tenantId, event: "issued", actorEmail: "system",
        after: { plan_id: lic.plan_id, valid_until: periodEnd }, note: `Licenca emitida automaticamente apos pagamento (${gateway}). Modulo: ${lic.plan_id}.` });
      // Envia o link de ativacao do modulo contratado.
      if (tenant.email) {
        await sendEmail({ tenantId, to: tenant.email, type: "license_issued",
          subject: `Sua licenca ${issued.plan?.name || ""} esta pronta — DPO PJ Protection`,
          html: `<p>Pagamento confirmado! Ative seu modulo <b>${issued.plan?.name || tenant.plan_id}</b> pelo link abaixo:</p>
            <p><a href="${activationLink(lic)}">${activationLink(lic)}</a></p>
            <p>Este link e pessoal e libera o seu modulo na primeira vez.</p>` });
      }
    } catch (e) { console.error("[webhook] falha ao emitir licenca automatica:", e?.message || e); }
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

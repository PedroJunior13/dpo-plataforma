// Motor de licenciamento: emissao, ativacao, suspensao, upgrade, cotas
// e o KILL-SWITCH (gating server-side por inadimplencia).
import { sql, one } from "./db.js";
import { genLicenseKey, genActivationToken } from "./auth.js";
import { licenseEvent } from "./audit.js";

const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || "5", 10);
const APP_BASE_URL = process.env.APP_BASE_URL || "https://app.dpopjprotection.com.br";

// ---------------------------------------------------------------
//  Link de ativacao pronto para enviar ao cliente
// ---------------------------------------------------------------
export function activationLink(license) {
  const u = new URL(APP_BASE_URL.replace(/\/+$/, "") + "/ativar");
  u.searchParams.set("lic", license.license_key);
  u.searchParams.set("t", license.activation_token);
  return u.toString();
}

// Mensagem padrao (WhatsApp/e-mail) com o link + a licenca.
export function invitationMessage(license, plan, tenant) {
  const link = activationLink(license);
  return [
    `Ola${tenant?.name ? `, ${tenant.name}` : ""}! Seu acesso a plataforma DPO PJ Protection esta pronto.`,
    ``,
    `Modulo: ${plan?.name || license.plan_id}`,
    `Licenca: ${license.license_key}`,
    ``,
    `1) Acesse o link abaixo`,
    `2) Crie seu usuario (e-mail e senha)`,
    `3) A licenca ja vem preenchida — confirme para liberar o acesso`,
    ``,
    `${link}`,
    ``,
    `Este link e pessoal e libera o seu modulo na primeira vez. Qualquer duvida, e so chamar.`,
  ].join("\n");
}

// ---------------------------------------------------------------
//  Emissao de licenca (cria tenant se necessario)
// ---------------------------------------------------------------
export async function issueLicense({ tenantId = null, tenant = null, planId, billingType = "monthly", subscriptionId = null, validUntil = null, actor }) {
  const plan = await one(sql`SELECT * FROM plans WHERE id=${planId}`);
  if (!plan) throw new Error("Plano inexistente.");

  // Cria tenant se nao foi passado um existente.
  let tid = tenantId;
  if (!tid) {
    const t = await one(sql`
      INSERT INTO tenants (name, email, phone, doc, plan_id, status)
      VALUES (${tenant?.name || "Novo cliente"}, ${tenant?.email || null}, ${tenant?.phone || null},
              ${tenant?.doc || null}, ${planId}, 'pending')
      RETURNING *`);
    tid = t.id;
  } else {
    await sql`UPDATE tenants SET plan_id=${planId}, updated_at=now() WHERE id=${tid}`;
  }

  // valid_until: avulso => +30 dias se nao informado; recorrente => segue assinatura
  let vu = validUntil;
  if (!vu && billingType === "monthly") {
    vu = new Date(Date.now() + 30 * 864e5).toISOString();
  }

  const lic = await one(sql`
    INSERT INTO licenses (tenant_id, plan_id, subscription_id, license_key, activation_token, status, client_quota, valid_until)
    VALUES (${tid}, ${planId}, ${subscriptionId}, ${genLicenseKey()}, ${genActivationToken()},
            'issued', ${plan.client_quota}, ${vu})
    RETURNING *`);

  await licenseEvent({
    licenseId: lic.id, tenantId: tid, event: "issued",
    actorEmail: actor?.email, after: { plan_id: planId, billing_type: billingType, valid_until: vu },
    note: `Licenca emitida (${plan.name}, ${billingType}).`,
  });

  return { license: lic, plan, link: activationLink(lic), message: invitationMessage(lic, plan, { name: tenant?.name }) };
}

// Marca como "enviada" (registro de auditoria ao copiar/enviar o link).
export async function markSent(licenseId, actor) {
  const lic = await one(sql`SELECT * FROM licenses WHERE id=${licenseId}`);
  if (!lic) throw new Error("Licenca nao encontrada.");
  await licenseEvent({ licenseId, tenantId: lic.tenant_id, event: "sent", actorEmail: actor?.email, note: "Link de ativacao enviado/copiado." });
  return lic;
}

// ---------------------------------------------------------------
//  Ativacao pelo cliente (1a vez) — cria usuario + destrava modulo
// ---------------------------------------------------------------
export async function activateLicense({ licenseKey, activationToken, user, ip }) {
  const lic = await one(sql`SELECT * FROM licenses WHERE license_key=${licenseKey}`);
  if (!lic) throw new Error("Licenca invalida.");
  if (lic.activation_token !== activationToken) throw new Error("Token de ativacao invalido.");
  if (lic.status === "revoked") throw new Error("Licenca revogada.");
  if (lic.activated_at) throw new Error("Esta licenca ja foi ativada.");

  const before = { status: lic.status, activated_at: lic.activated_at };
  // Vincula usuario ao tenant da licenca + ativa.
  await sql`UPDATE users SET tenant_id=${lic.tenant_id} WHERE id=${user.id}`;
  const updated = await one(sql`
    UPDATE licenses SET status='active', activated_at=now(), activated_by_user_id=${user.id},
           activation_ip=${ip}, version=version+1, updated_at=now()
    WHERE id=${lic.id} RETURNING *`);
  await sql`UPDATE tenants SET status='active', updated_at=now() WHERE id=${lic.tenant_id}`;

  await licenseEvent({
    licenseId: lic.id, tenantId: lic.tenant_id, event: "activated",
    actorEmail: user.email, before, after: { status: "active", activated_at: updated.activated_at, ip },
    note: "Ativacao pelo cliente (primeiro acesso).",
  });
  return updated;
}

// ---------------------------------------------------------------
//  Mudancas de estado (dono)
// ---------------------------------------------------------------
async function transition(licenseId, newStatus, event, actor, note) {
  const lic = await one(sql`SELECT * FROM licenses WHERE id=${licenseId}`);
  if (!lic) throw new Error("Licenca nao encontrada.");
  const before = { status: lic.status };
  const tenantStatus = newStatus === "active" ? "active"
    : newStatus === "suspended" ? "suspended"
    : newStatus === "revoked" ? "canceled" : null;
  const updated = await one(sql`
    UPDATE licenses SET status=${newStatus}, version=version+1, updated_at=now()
    WHERE id=${licenseId} RETURNING *`);
  if (tenantStatus) await sql`UPDATE tenants SET status=${tenantStatus}, updated_at=now() WHERE id=${lic.tenant_id}`;
  await licenseEvent({ licenseId, tenantId: lic.tenant_id, event, actorEmail: actor?.email, before, after: { status: newStatus }, note });
  return updated;
}
export const suspendLicense   = (id, a, n = "Suspensao manual.")      => transition(id, "suspended", "suspended",   a, n);
export const reactivateLicense= (id, a, n = "Reativacao.")            => transition(id, "active",    "reactivated", a, n);
export const revokeLicense    = (id, a, n = "Revogacao definitiva.")  => transition(id, "revoked",   "revoked",     a, n);

// ---------------------------------------------------------------
//  Upgrade / downgrade de modulo SEM impactar dados do cliente
//  (apenas troca plan_id + cota; o schema e o mesmo p/ todos os modulos)
// ---------------------------------------------------------------
export async function changePlan({ tenantId, newPlanId, actor }) {
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${tenantId}`);
  if (!tenant) throw new Error("Tenant nao encontrado.");
  const newPlan = await one(sql`SELECT * FROM plans WHERE id=${newPlanId}`);
  if (!newPlan) throw new Error("Plano destino inexistente.");
  const oldPlan = await one(sql`SELECT * FROM plans WHERE id=${tenant.plan_id}`);

  await sql`UPDATE tenants SET plan_id=${newPlanId}, updated_at=now() WHERE id=${tenantId}`;
  // Atualiza a licenca ativa do tenant (cota + plano), preservando ativacao/cliente.
  const lic = await one(sql`
    UPDATE licenses SET plan_id=${newPlanId}, client_quota=${newPlan.client_quota}, version=version+1, updated_at=now()
    WHERE id = (
      SELECT id FROM licenses
      WHERE tenant_id=${tenantId} AND status IN ('active','suspended','issued')
      ORDER BY created_at DESC LIMIT 1
    ) RETURNING *`);

  const event = (newPlan.tier > (oldPlan?.tier || 0)) ? "upgraded" : "downgraded";
  if (lic) {
    await licenseEvent({
      licenseId: lic.id, tenantId, event, actorEmail: actor?.email,
      before: { plan_id: tenant.plan_id, quota: oldPlan?.client_quota },
      after: { plan_id: newPlanId, quota: newPlan.client_quota },
      note: `Mudanca de modulo ${oldPlan?.name || tenant.plan_id} -> ${newPlan.name} (sem perda de dados).`,
    });
  }
  return { tenant: await one(sql`SELECT * FROM tenants WHERE id=${tenantId}`), license: lic };
}

// Ajuste manual de cota (ex.: cliente com mais de 150 — plano sob medida).
export async function setQuotaOverride({ tenantId, quota, actor }) {
  const t = await one(sql`UPDATE tenants SET client_quota_override=${quota}, updated_at=now() WHERE id=${tenantId} RETURNING *`);
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (lic) await licenseEvent({ licenseId: lic.id, tenantId, event: "quota_changed", actorEmail: actor?.email, after: { quota_override: quota }, note: "Cota ajustada manualmente." });
  return t;
}

// ---------------------------------------------------------------
//  COTA DE CLIENTES — limite por modulo
// ---------------------------------------------------------------
export async function effectiveQuota(tenant) {
  if (tenant.is_owner) return null; // ilimitado
  if (tenant.client_quota_override != null) return tenant.client_quota_override;
  const plan = await one(sql`SELECT client_quota FROM plans WHERE id=${tenant.plan_id}`);
  return plan ? plan.client_quota : 0;
}

export async function assertQuotaAvailable(tenant) {
  const quota = await effectiveQuota(tenant);
  if (quota == null) return; // ilimitado
  const row = await one(sql`SELECT count(*)::int AS n FROM clients WHERE tenant_id=${tenant.id}`);
  if (row.n >= quota) {
    const err = new Error(`Limite do modulo atingido (${quota} clientes). Faca upgrade para cadastrar mais.`);
    err.code = "QUOTA_EXCEEDED";
    throw err;
  }
}

// ---------------------------------------------------------------
//  KILL-SWITCH — checagem de acesso a cada request (server-side)
//  Retorna { allowed, reason, tenant }. Inadimplencia => allowed=false.
// ---------------------------------------------------------------
export async function checkAccess(user) {
  if (!user) return { allowed: false, reason: "Nao autenticado." };
  if (user.role === "OWNER") return { allowed: true }; // dono nunca bloqueia
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${user.tenant_id}`);
  if (!tenant) return { allowed: false, reason: "Conta sem ambiente vinculado." };
  if (tenant.is_owner) return { allowed: true, tenant };

  // Ambiente de demonstracao: liberado enquanto nao expira (sem licenca/assinatura).
  if (tenant.is_demo) {
    if (tenant.demo_expires_at && new Date(tenant.demo_expires_at).getTime() < Date.now())
      return { allowed: false, reason: "Demonstracao expirada. Solicite um novo link de demonstracao.", tenant };
    return { allowed: true, tenant };
  }

  if (tenant.status === "blocked" || tenant.status === "suspended")
    return { allowed: false, reason: "Acesso suspenso por pendencia financeira. Regularize para reativar.", tenant };
  if (tenant.status === "canceled")
    return { allowed: false, reason: "Assinatura cancelada.", tenant };

  // Confere validade da licenca / assinatura (com carencia).
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenant.id} AND status='active' ORDER BY created_at DESC LIMIT 1`);
  if (!lic) return { allowed: false, reason: "Nenhuma licenca ativa.", tenant };

  const sub = await one(sql`SELECT * FROM subscriptions WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 1`);
  const paidUntil = sub?.current_period_end || lic.valid_until;
  if (paidUntil) {
    const limit = new Date(paidUntil).getTime() + GRACE_DAYS * 864e5;
    if (Date.now() > limit)
      return { allowed: false, reason: "Pagamento vencido. Acesso bloqueado ate a regularizacao.", tenant };
  }
  return { allowed: true, tenant, license: lic };
}

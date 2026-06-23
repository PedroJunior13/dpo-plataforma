// Motor de licenciamento: emissao, ativacao, suspensao, upgrade, cotas
// e o KILL-SWITCH (gating server-side por inadimplencia).
import { sql, one } from "./db.js";
import { genLicenseKey, genActivationToken, genTempPassword, hashPassword } from "./auth.js";
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

// Gera o proximo numero/codigo legivel da licenca: DPO-L-{ANO}-{0001}.
// Best-effort: se a sequence nao existir (migracao pendente), devolve null.
async function nextLicenseNo() {
  try {
    const r = await one(sql`SELECT nextval('license_no_seq') AS n`);
    const seq = String(r.n).padStart(4, "0");
    return `DPO-L-${new Date().getFullYear()}-${seq}`;
  } catch { return null; }
}

// ---------------------------------------------------------------
//  Emissao de licenca (cria tenant se necessario)
// ---------------------------------------------------------------
export async function issueLicense({ tenantId = null, tenant = null, planId, billingType = "monthly", billingCycle = "monthly", pricing = null, reason = null, validDays = null, subscriptionId = null, validUntil = null, dueDay = null, customQuota = null, customPriceCents = null, actor }) {
  const plan = await one(sql`SELECT * FROM plans WHERE id=${planId}`);
  if (!plan) throw new Error("Plano inexistente.");

  // Licenca AVULSA PERSONALIZADA (dono): cota e valor definidos no ato da emissao.
  // - cota custom (>0) vira o snapshot da licenca E o override do tenant (trava real);
  // - cota null/0 => usa a cota padrao do plano.
  // - valor custom (>=0, centavos) e gravado em custom_price_cents (informativo).
  const cqNum = parseInt(customQuota, 10);
  const hasCustomQuota = Number.isFinite(cqNum) && cqNum > 0;
  const licQuota = hasCustomQuota ? cqNum : plan.client_quota;
  const cpcNum = parseInt(customPriceCents, 10);
  const hasCustomPrice = Number.isFinite(cpcNum) && cpcNum >= 0;

  // Tipo comercial: 'free' = cortesia/avulsa SEM custo; 'paid' = paga.
  // billingType "free" tambem marca cortesia (compat. com o seletor do painel).
  const price = (pricing === "free" || billingType === "free") ? "free" : "paid";
  const issueReason = (reason && String(reason).trim()) ? String(reason).trim().slice(0, 400) : null;

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

  // valid_until — depende do CICLO escolhido (mensal / anual / personalizado):
  //  - cortesia (free): mensal=30d, anual=365d, custom=validDays (padrao 365);
  //  - avulso pago (monthly): mensal=30d, anual=365d, custom=validDays (padrao 30);
  //  - recorrente: segue a assinatura (sem data fixa — webhook define o periodo).
  // Quando dueDay (1-28) e informado, o vencimento cai nesse dia do mes alvo.
  const cycle = (billingCycle === "annual" || billingCycle === "custom") ? billingCycle : "monthly";
  const withDueDay = (iso) => {
    const dd = parseInt(dueDay, 10);
    if (!iso || !(Number.isFinite(dd) && dd >= 1 && dd <= 28)) return iso;
    const d = new Date(iso); d.setDate(dd); return d.toISOString();
  };
  let vu = validUntil;
  if (!vu) {
    let days = null;
    if (price === "free") {
      const d = parseInt(validDays, 10);
      days = cycle === "annual" ? 365 : cycle === "custom" ? (Number.isFinite(d) && d > 0 ? d : 365) : 30;
    } else if (billingType === "monthly") {
      const d = parseInt(validDays, 10);
      days = cycle === "annual" ? 365 : cycle === "custom" ? (Number.isFinite(d) && d > 0 ? d : 30) : 30;
    }
    if (days != null) vu = withDueDay(new Date(Date.now() + days * 864e5).toISOString());
  } else {
    vu = withDueDay(vu);
  }

  // Numero/codigo legivel e sequencial da licenca (DPO-L-{ANO}-{0001}).
  // Resiliente: se a sequence ainda nao migrou, segue sem numero (nao bloqueia a emissao).
  const licenseNo = await nextLicenseNo();

  // INSERT da licenca — RESILIENTE a banco parcialmente migrado. A emissao NUNCA
  // pode ser impedida por uma coluna opcional ausente (license_no/pricing/
  // issue_reason). Tentamos o INSERT completo; se uma coluna ainda nao existir,
  // gravamos o essencial e complementamos cada campo opcional isoladamente.
  let lic;
  try {
    lic = await one(sql`
      INSERT INTO licenses (tenant_id, plan_id, subscription_id, license_key, activation_token, status, client_quota, valid_until, license_no, pricing, issue_reason, billing_cycle)
      VALUES (${tid}, ${planId}, ${subscriptionId}, ${genLicenseKey()}, ${genActivationToken()},
              'issued', ${licQuota}, ${vu}, ${licenseNo}, ${price}, ${issueReason}, ${cycle})
      RETURNING *`);
  } catch (e) {
    console.error("[issueLicense] INSERT completo falhou, usando fallback base:", e?.message || e);
    lic = await one(sql`
      INSERT INTO licenses (tenant_id, plan_id, subscription_id, license_key, activation_token, status, client_quota, valid_until)
      VALUES (${tid}, ${planId}, ${subscriptionId}, ${genLicenseKey()}, ${genActivationToken()},
              'issued', ${licQuota}, ${vu})
      RETURNING *`);
    try { await sql`UPDATE licenses SET license_no=${licenseNo}     WHERE id=${lic.id}`; lic.license_no = licenseNo; } catch {}
    try { await sql`UPDATE licenses SET pricing=${price}            WHERE id=${lic.id}`; lic.pricing = price; } catch {}
    try { await sql`UPDATE licenses SET issue_reason=${issueReason} WHERE id=${lic.id}`; lic.issue_reason = issueReason; } catch {}
    try { await sql`UPDATE licenses SET billing_cycle=${cycle}      WHERE id=${lic.id}`; lic.billing_cycle = cycle; } catch {}
  }

  // Cota personalizada => grava o override no tenant (trava real do limite). Valor
  // personalizado => grava em custom_price_cents (best-effort; coluna opcional).
  if (hasCustomQuota) {
    try { await sql`UPDATE tenants SET client_quota_override=${cqNum}, updated_at=now() WHERE id=${tid}`; } catch (e) { console.error("[issueLicense] override cota custom nao-fatal:", e?.message || e); }
  }
  if (hasCustomPrice) {
    try { await sql`UPDATE licenses SET custom_price_cents=${cpcNum} WHERE id=${lic.id}`; lic.custom_price_cents = cpcNum; } catch (e) { console.error("[issueLicense] custom_price_cents nao-fatal:", e?.message || e); }
  }

  // Registro de evento e BEST-EFFORT: a licenca ja existe e deve ser devolvida
  // mesmo que a auditoria falhe (ex.: tabela de eventos parcialmente migrada).
  const priceLabel = price === "free" ? "cortesia (sem custo)" : "paga";
  try {
    await licenseEvent({
      licenseId: lic.id, tenantId: tid, event: "issued",
      actorEmail: actor?.email,
      after: { plan_id: planId, billing_type: billingType, billing_cycle: cycle, pricing: price, issue_reason: issueReason, valid_until: vu, license_no: licenseNo, version: lic.version, client_quota: licQuota, custom_price_cents: hasCustomPrice ? cpcNum : null },
      note: `Licenca ${licenseNo || lic.license_key} emitida — ${priceLabel} (${plan.name}, ${billingType}/${cycle})${hasCustomQuota ? ` · cota personalizada: ${cqNum} clientes` : ""}${hasCustomPrice ? ` · valor: R$ ${(cpcNum / 100).toFixed(2)}` : ""}${issueReason ? ` · motivo: ${issueReason}` : ""}.`,
    });
  } catch (e) { console.error("[issueLicense] licenseEvent nao-fatal:", e?.message || e); }

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
//  Ativo / Inativo do CLIENTE (inadimplencia ou desativacao manual)
//  active=false  => tenant 'suspended' + licenca 'suspended' (kill-switch corta)
//  active=true   => tenant 'active'    + licenca 'active'
// ---------------------------------------------------------------
export async function setTenantActive({ tenantId, active, actor, reason }) {
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${tenantId}`);
  if (!tenant) throw new Error("Tenant nao encontrado.");
  if (tenant.is_owner) throw new Error("O ambiente do dono nao pode ser desativado.");
  const newTenant = active ? "active" : "suspended";
  await sql`UPDATE tenants SET status=${newTenant}, updated_at=now() WHERE id=${tenantId}`;
  // Acompanha a licenca mais recente (se houver).
  const lic = await one(sql`
    SELECT * FROM licenses WHERE tenant_id=${tenantId}
    AND status IN ('active','suspended','issued') ORDER BY created_at DESC LIMIT 1`);
  if (lic) {
    const newLic = active ? "active" : "suspended";
    await sql`UPDATE licenses SET status=${newLic}, version=version+1, updated_at=now() WHERE id=${lic.id}`;
    await licenseEvent({
      licenseId: lic.id, tenantId, event: active ? "reactivated" : "suspended",
      actorEmail: actor?.email, before: { status: lic.status }, after: { status: newLic },
      note: reason || (active ? "Cliente reativado pelo dono." : "Cliente inativado (inadimplencia/manual)."),
    });
  }
  return one(sql`SELECT * FROM tenants WHERE id=${tenantId}`);
}

// Status consolidado para exibir na gestao de licencas:
// { module, moduleName, active, status, quota }
export async function tenantStatusInfo(tenant) {
  const plan = await one(sql`SELECT * FROM plans WHERE id=${tenant.plan_id}`);
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 1`);
  const active = tenant.status === "active" && (!lic || lic.status === "active" || lic.status === "issued");
  return {
    module: tenant.plan_id,
    moduleName: plan?.name || tenant.plan_id,
    active,
    status: tenant.status,
    licenseStatus: lic?.status || null,
    quota: await effectiveQuota(tenant),
  };
}

// ---------------------------------------------------------------
//  Suporte do dono: regenerar acesso + resetar MFA do cliente
// ---------------------------------------------------------------
export async function regenerateActivation({ tenantId, actor }) {
  const lic = await one(sql`
    SELECT * FROM licenses WHERE tenant_id=${tenantId}
    ORDER BY created_at DESC LIMIT 1`);
  if (!lic) throw new Error("Nenhuma licenca para este cliente.");
  const updated = await one(sql`
    UPDATE licenses SET activation_token=${genActivationToken()}, activated_at=NULL,
      activated_by_user_id=NULL, status='issued', version=version+1, updated_at=now()
    WHERE id=${lic.id} RETURNING *`);
  await licenseEvent({ licenseId: lic.id, tenantId, event: "sent", actorEmail: actor?.email, note: "Acesso regenerado pelo suporte (novo token de ativacao)." });
  const plan = await one(sql`SELECT * FROM plans WHERE id=${updated.plan_id}`);
  const tenant = await one(sql`SELECT * FROM tenants WHERE id=${tenantId}`);
  return { license: updated, plan, link: activationLink(updated), message: invitationMessage(updated, plan, tenant) };
}

export async function resetTenantMfa({ tenantId, actor }) {
  const r = await sql`UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL WHERE tenant_id=${tenantId}`;
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (lic) await licenseEvent({ licenseId: lic.id, tenantId, event: "sent", actorEmail: actor?.email, note: "MFA do cliente resetado pelo suporte." });
  return { ok: true };
}

// Redefine a senha do usuario principal do cliente (suporte). Gera uma senha
// temporaria forte, devolvida UMA vez ao dono para repassar (WhatsApp/e-mail).
// Alvo: o ADMIN mais antigo do tenant (o titular). O 2FA do cliente continua valendo.
export async function resetTenantPassword({ tenantId, actor }) {
  const u = await one(sql`
    SELECT id, email FROM users WHERE tenant_id=${tenantId}
    ORDER BY (role='ADMIN') DESC, created_at ASC LIMIT 1`);
  if (!u) throw new Error("Nenhum usuario vinculado a este cliente.");
  const temp = genTempPassword();
  await sql`UPDATE users SET password_hash=${hashPassword(temp)} WHERE id=${u.id}`;
  // Destrava eventual bloqueio por tentativas (nao-fatal se as colunas nao existirem).
  try { await sql`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=${u.id}`; } catch {}
  const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenantId} ORDER BY created_at DESC LIMIT 1`);
  if (lic) await licenseEvent({ licenseId: lic.id, tenantId, event: "sent", actorEmail: actor?.email, note: "Senha do cliente redefinida pelo suporte (senha temporaria)." });
  return { email: u.email, tempPassword: temp };
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

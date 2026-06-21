// =====================================================================
//  API principal — roteamento interno em /api/*
//  Areas: auth | owner (super-admin) | app (operacional LGPD) | checkout | public
// =====================================================================
import { sql, one } from "./lib/db.js";
import {
  hashPassword, verifyPassword, makeToken, userFromRequest, isOwner, uuid,
  makeMfaChallenge, verifyMfaChallenge,
} from "./lib/auth.js";
import {
  json, ok, fail, unauthorized, forbidden, paymentRequired, readJson, clientIp, routePath,
} from "./lib/http.js";
import { audit } from "./lib/audit.js";
import * as L from "./lib/licenses.js";
import * as billing from "./lib/billing.js";
import * as nfse from "./lib/nfse.js";
import { sendEmail, sendWhatsApp, waLink } from "./lib/notify.js";
import { generateSecret, verifyTotp, keyuri } from "./lib/totp.js";
import { assertFeature, capabilities, hasFeature } from "./lib/plan-features.js";
import { resetDemo, demoStatus, userFromDemoToken } from "./lib/demo.js";

export const config = { path: "/api/*" };

export default async function handler(req) {
  const method = req.method;
  const path = routePath(req); // ex.: "owner/licenses"
  const seg = path.split("/");

  try {
    // -------- PUBLICO (sem auth) --------
    if (path === "public/plans" && method === "GET") return listPlans();
    if (path === "auth/login" && method === "POST") return login(req);
    if (path === "auth/mfa-verify" && method === "POST") return mfaVerify(req);
    if (path === "auth/demo-login" && method === "POST") return demoLogin(req);
    if (path === "auth/signup" && method === "POST") return signup(req);
    if (path === "auth/activate" && method === "POST") return activate(req);
    if (path === "auth/bootstrap-owner" && method === "POST") return bootstrapOwner(req);
    if (path === "checkout" && method === "POST") return checkout(req);

    // -------- AUTENTICADO --------
    const user = await userFromRequest(req);
    if (!user) return unauthorized();

    if (path === "auth/me" && method === "GET") return me(user);
    // MFA (self-service, qualquer usuario logado)
    if (path === "auth/mfa/setup" && method === "POST") return mfaSetup(user);
    if (path === "auth/mfa/enable" && method === "POST") return mfaEnable(req, user);
    if (path === "auth/mfa/disable" && method === "POST") return mfaDisable(req, user);

    // ----- AREA DO DONO (OWNER) -----
    if (seg[0] === "owner") {
      if (!isOwner(user)) return forbidden("Area exclusiva do dono da plataforma.");
      return ownerRoutes(req, user, seg, method);
    }

    // ----- APP OPERACIONAL (assinante + consultoria do dono) -----
    if (seg[0] === "app") {
      let tenant;
      if (isOwner(user)) {
        tenant = await one(sql`SELECT * FROM tenants WHERE id=${user.tenant_id}`);
      } else {
        const access = await L.checkAccess(user);     // kill-switch
        if (!access.allowed) return paymentRequired(access.reason);
        tenant = access.tenant;
      }
      if (!tenant) return forbidden("Conta sem ambiente vinculado. Ative sua licenca.");
      return appRoutes(req, user, tenant, seg.slice(1), method);
    }

    // ----- COMPAT: rotas legadas do assinante (kill-switch) -----
    const access = await L.checkAccess(user);
    if (!access.allowed) return paymentRequired(access.reason);
    return appRoutes(req, user, access.tenant, seg, method);

  } catch (e) {
    console.error("[api]", path, e);
    const code = e.httpStatus || (e.code === "QUOTA_EXCEEDED" ? 409 : 400);
    return fail(e.message || "Erro interno.", code, e.code ? { code: e.code } : {});
  }
}

// =====================================================================
//  PUBLICO / AUTH
// =====================================================================
async function listPlans() {
  const rows = await sql`SELECT id, name, tier, client_quota, price_month_cents, price_recurring_cents, features
                         FROM plans WHERE active AND id <> 'owner' ORDER BY tier`;
  return ok({ plans: rows, gateways: billing.availableGateways() });
}

async function login(req) {
  const { email, password } = await readJson(req);
  const u = await one(sql`SELECT * FROM users WHERE lower(email)=lower(${email || ""})`);
  if (!u || !u.password_hash || !verifyPassword(password || "", u.password_hash))
    return fail("E-mail ou senha invalidos.", 401);
  if (!u.active) return forbidden("Usuario inativo.");
  // 2FA: se habilitado, devolve um desafio curto em vez do token de sessao.
  if (u.mfa_enabled && u.mfa_secret) {
    return ok({ mfaRequired: true, mfaToken: await makeMfaChallenge(u) });
  }
  return finishLogin(u, req);
}

async function mfaVerify(req) {
  const { mfaToken, code } = await readJson(req);
  const ch = await verifyMfaChallenge(mfaToken);
  if (!ch) return fail("Sessao de verificacao expirada. Faca login novamente.", 401);
  const u = await one(sql`SELECT * FROM users WHERE id=${ch.id}`);
  if (!u || !u.mfa_enabled || !u.mfa_secret) return fail("MFA nao configurado.", 400);
  if (!u.active) return forbidden("Usuario inativo.");
  if (!verifyTotp(code, u.mfa_secret)) return fail("Codigo invalido. Tente novamente.", 401);
  return finishLogin(u, req);
}

async function finishLogin(u, req) {
  await sql`UPDATE users SET last_login=now() WHERE id=${u.id}`;
  await audit({ tenantId: u.tenant_id, actorEmail: u.email, action: "login", ip: clientIp(req) });
  return ok({ token: await makeToken(u), user: pubUser(u) });
}

// Login do ambiente de demonstracao (sem senha — o token do link e a credencial).
async function demoLogin(req) {
  const { token } = await readJson(req);
  const r = await userFromDemoToken((token || "").trim());
  if (r.error) return fail(r.error, 401);
  await sql`UPDATE users SET last_login=now() WHERE id=${r.user.id}`;
  return ok({ token: await makeToken(r.user), user: pubUser(r.user), demo: true });
}

// Cadastro do cliente (cria usuario SEM tenant; vincula na ativacao).
async function signup(req) {
  const { email, password, name } = await readJson(req);
  if (!email || !password) return fail("Informe e-mail e senha.");
  if (String(password).length < 8) return fail("A senha deve ter ao menos 8 caracteres.");
  const exists = await one(sql`SELECT id FROM users WHERE lower(email)=lower(${email})`);
  if (exists) return fail("Ja existe um usuario com este e-mail.", 409);
  const u = await one(sql`
    INSERT INTO users (email, password_hash, name, role, tenant_id)
    VALUES (${email}, ${hashPassword(password)}, ${name || ""}, 'ADMIN', NULL)
    RETURNING *`);
  return ok({ token: await makeToken(u), user: pubUser(u) });
}

// Ativacao com a licenca (destrava o modulo na 1a vez).
async function activate(req) {
  const user = await userFromRequest(req);
  if (!user) return unauthorized("Faca login/cadastro antes de ativar.");
  const { licenseKey, activationToken } = await readJson(req);
  const lic = await L.activateLicense({
    licenseKey: (licenseKey || "").trim().toUpperCase(),
    activationToken: (activationToken || "").trim(),
    user, ip: clientIp(req),
  });
  const u = await one(sql`SELECT * FROM users WHERE id=${user.id}`);
  await audit({ tenantId: lic.tenant_id, actorEmail: user.email, action: "license_activated", entity: "license", entityId: lic.id, ip: clientIp(req) });
  return ok({ token: await makeToken(u), license: lic, user: pubUser(u) });
}

// Define a senha do dono na 1a vez (protegido por BOOTSTRAP_TOKEN).
async function bootstrapOwner(req) {
  const { token, password } = await readJson(req);
  if (!process.env.BOOTSTRAP_TOKEN) return fail("Bootstrap desativado.", 403);
  if (token !== process.env.BOOTSTRAP_TOKEN) return forbidden("Token de bootstrap invalido.");
  if (!password || String(password).length < 10) return fail("Defina uma senha forte (10+ caracteres).");
  const email = process.env.OWNER_EMAIL || "pedrobj@gmail.com";
  const u = await one(sql`UPDATE users SET password_hash=${hashPassword(password)} WHERE lower(email)=lower(${email}) RETURNING *`);
  if (!u) return fail("Usuario dono nao encontrado (rode a migracao do banco).", 404);
  await audit({ tenantId: u.tenant_id, actorEmail: email, action: "owner_bootstrap" });
  return ok({ message: "Senha do dono definida. Faca login.", email });
}

async function me(user) {
  const u = await one(sql`SELECT id, email, name, role, tenant_id, mfa_enabled FROM users WHERE id=${user.id}`);
  let caps = null, tenant = null;
  if (u?.tenant_id) {
    tenant = await one(sql`SELECT * FROM tenants WHERE id=${u.tenant_id}`);
    if (tenant) caps = capabilities(tenant);
  }
  return ok({ user: u, capabilities: caps, tenant: tenant ? pubTenant(tenant) : null });
}
function pubUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, tenant_id: u.tenant_id, mfa_enabled: !!u.mfa_enabled }; }
function pubTenant(t) { return { id: t.id, name: t.name, plan_id: t.plan_id, status: t.status, is_owner: t.is_owner, is_demo: !!t.is_demo, demo_expires_at: t.demo_expires_at || null }; }

// ---------- MFA self-service ----------
async function mfaSetup(user) {
  const u = await one(sql`SELECT email FROM users WHERE id=${user.id}`);
  const secret = generateSecret();
  await sql`UPDATE users SET mfa_secret=${secret}, mfa_enabled=FALSE WHERE id=${user.id}`;
  return ok({ secret, otpauth: keyuri({ secret, label: u.email }) });
}
async function mfaEnable(req, user) {
  const { code } = await readJson(req);
  const u = await one(sql`SELECT * FROM users WHERE id=${user.id}`);
  if (!u.mfa_secret) return fail("Inicie a configuracao do MFA primeiro.");
  if (!verifyTotp(code, u.mfa_secret)) return fail("Codigo invalido.", 401);
  await sql`UPDATE users SET mfa_enabled=TRUE WHERE id=${user.id}`;
  await audit({ tenantId: u.tenant_id, actorEmail: u.email, action: "mfa_enabled" });
  return ok({ enabled: true });
}
async function mfaDisable(req, user) {
  const { code } = await readJson(req);
  const u = await one(sql`SELECT * FROM users WHERE id=${user.id}`);
  if (u.mfa_enabled && !verifyTotp(code, u.mfa_secret || "")) return fail("Codigo invalido.", 401);
  await sql`UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL WHERE id=${user.id}`;
  await audit({ tenantId: u.tenant_id, actorEmail: u.email, action: "mfa_disabled" });
  return ok({ enabled: false });
}

// =====================================================================
//  CHECKOUT (publico) — gera cobranca e devolve URL do gateway
// =====================================================================
async function checkout(req) {
  const b = await readJson(req);
  const { planId, billingType = "monthly", method = "pix", gateway, tenant: t } = b;
  const plan = await one(sql`SELECT * FROM plans WHERE id=${planId} AND active`);
  if (!plan || plan.id === "owner") return fail("Plano invalido.");
  if (!t?.email || !t?.name) return fail("Informe nome e e-mail do assinante.");

  const amount = billingType === "recurring" ? plan.price_recurring_cents : plan.price_month_cents;

  const tenant = await one(sql`
    INSERT INTO tenants (name, email, phone, doc, plan_id, status)
    VALUES (${t.name}, ${t.email}, ${t.phone || null}, ${t.doc || null}, ${planId}, 'pending')
    RETURNING *`);

  const charge = await billing.createCharge({ gateway, billingType, method, tenant, plan, amountCents: amount });

  const sub = await one(sql`
    INSERT INTO subscriptions (tenant_id, plan_id, billing_type, gateway, gateway_subscription_id, amount_cents, status)
    VALUES (${tenant.id}, ${planId}, ${billingType}, ${charge.gateway}, ${charge.gatewaySubscriptionId || null}, ${amount}, 'pending')
    RETURNING *`);
  await sql`INSERT INTO payments (tenant_id, subscription_id, gateway, gateway_payment_id, method, amount_cents, status)
            VALUES (${tenant.id}, ${sub.id}, ${charge.gateway}, ${charge.gatewayRef || charge.gatewaySubscriptionId || null}, ${method}, ${amount}, 'pending')`;
  await audit({ tenantId: tenant.id, actorEmail: t.email, action: "checkout_created", entity: "subscription", entityId: sub.id, detail: { planId, billingType, amount } });

  return ok({ checkoutUrl: charge.checkoutUrl, tenantId: tenant.id, subscriptionId: sub.id, amountCents: amount });
}

// =====================================================================
//  AREA DO DONO (OWNER)
// =====================================================================
async function ownerRoutes(req, user, seg, method) {
  const r = seg.slice(1).join("/");

  if (r === "dashboard" && method === "GET") return ownerDashboard();

  if (r === "plans" && method === "GET")
    return ok({ plans: await sql`SELECT * FROM plans ORDER BY tier` });

  // ---- TENANTS ----
  if (r === "tenants" && method === "GET") {
    const rows = await sql`
      SELECT t.*, p.name AS plan_name,
        (SELECT count(*)::int FROM clients c WHERE c.tenant_id=t.id) AS clients_count,
        (SELECT current_period_end FROM subscriptions s WHERE s.tenant_id=t.id ORDER BY created_at DESC LIMIT 1) AS paid_until
      FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
      WHERE t.is_owner = FALSE ORDER BY t.created_at DESC`;
    return ok({ tenants: rows });
  }
  if (r === "tenants" && method === "POST") {
    const b = await readJson(req);
    if (!b.name) return fail("Informe o nome do cliente.");
    const t = await one(sql`
      INSERT INTO tenants (name, email, phone, doc, plan_id, status)
      VALUES (${b.name}, ${b.email || null}, ${b.phone || null}, ${b.doc || null}, ${b.planId || "basic"}, 'pending')
      RETURNING *`);
    await audit({ actorEmail: user.email, action: "tenant_created", entity: "tenant", entityId: t.id });
    return ok({ tenant: t });
  }
  if (seg[1] === "tenants" && seg[2] && method === "GET" && !seg[3]) {
    const t = await one(sql`SELECT t.*, p.name AS plan_name FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=${seg[2]}`);
    if (!t) return fail("Tenant nao encontrado.", 404);
    const licenses = await sql`SELECT * FROM licenses WHERE tenant_id=${t.id} ORDER BY created_at DESC`;
    const payments = await sql`SELECT * FROM payments WHERE tenant_id=${t.id} ORDER BY created_at DESC LIMIT 50`;
    const events = await sql`SELECT * FROM license_events WHERE tenant_id=${t.id} ORDER BY created_at DESC LIMIT 100`;
    return ok({ tenant: t, licenses, payments, events });
  }
  if (seg[1] === "tenants" && seg[2] && seg[3] === "plan" && method === "POST") {
    const b = await readJson(req);
    const res = await L.changePlan({ tenantId: seg[2], newPlanId: b.planId, actor: user });
    await audit({ tenantId: seg[2], actorEmail: user.email, action: "plan_changed", entity: "tenant", entityId: seg[2], detail: { to: b.planId } });
    return ok(res);
  }
  if (seg[1] === "tenants" && seg[2] && seg[3] === "quota" && method === "POST") {
    const b = await readJson(req);
    const t = await L.setQuotaOverride({ tenantId: seg[2], quota: b.quota ?? null, actor: user });
    return ok({ tenant: t });
  }

  // ---- LICENCAS ----
  if (r === "licenses" && method === "GET") {
    const rows = await sql`
      SELECT l.*, t.name AS tenant_name, t.email AS tenant_email, t.phone AS tenant_phone, p.name AS plan_name
      FROM licenses l JOIN tenants t ON t.id=l.tenant_id LEFT JOIN plans p ON p.id=l.plan_id
      ORDER BY l.created_at DESC LIMIT 300`;
    return ok({ licenses: rows.map(decorate) });
  }
  if (r === "licenses" && method === "POST") {
    const b = await readJson(req);
    if (!b.tenantId && !b.tenant?.name) return fail("Informe um cliente (novo ou existente).");
    const res = await L.issueLicense({
      tenantId: b.tenantId || null,
      tenant: b.tenant || null,
      planId: b.planId || "basic",
      billingType: b.billingType || "monthly",
      actor: user,
    });
    await audit({ tenantId: res.license.tenant_id, actorEmail: user.email, action: "license_issued", entity: "license", entityId: res.license.id, detail: { planId: b.planId } });
    return ok({
      license: res.license, plan: res.plan,
      link: res.link, message: res.message,
      whatsapp: b.tenant?.phone ? waLink(b.tenant.phone, res.message) : null,
    });
  }
  if (seg[1] === "licenses" && seg[2] && seg[3] === "send" && method === "POST") {
    const lic = await one(sql`SELECT l.*, t.name AS tenant_name, t.email AS tenant_email, t.phone AS tenant_phone, p.name AS plan_name
                              FROM licenses l JOIN tenants t ON t.id=l.tenant_id LEFT JOIN plans p ON p.id=l.plan_id WHERE l.id=${seg[2]}`);
    if (!lic) return fail("Licenca nao encontrada.", 404);
    await L.markSent(lic.id, user);
    const plan = await one(sql`SELECT * FROM plans WHERE id=${lic.plan_id}`);
    const link = L.activationLink(lic);
    const message = L.invitationMessage(lic, plan, { name: lic.tenant_name });
    const b = await readJson(req).catch(() => ({}));
    if (b?.email && lic.tenant_email) {
      await sendEmail({ tenantId: lic.tenant_id, to: lic.tenant_email, subject: "Seu acesso — DPO PJ Protection",
        html: `<pre style="font-family:inherit">${message}</pre>`, type: "license_sent" });
    }
    return ok({ link, message, whatsapp: lic.tenant_phone ? waLink(lic.tenant_phone, message) : null });
  }
  if (seg[1] === "licenses" && seg[2] && seg[3] === "suspend" && method === "POST")
    return ok({ license: await L.suspendLicense(seg[2], user) });
  if (seg[1] === "licenses" && seg[2] && seg[3] === "reactivate" && method === "POST")
    return ok({ license: await L.reactivateLicense(seg[2], user) });
  if (seg[1] === "licenses" && seg[2] && seg[3] === "revoke" && method === "POST")
    return ok({ license: await L.revokeLicense(seg[2], user) });

  // ---- PAGAMENTOS / NOTAS / AUDITORIA ----
  if (r === "payments" && method === "GET") {
    const rows = await sql`SELECT p.*, t.name AS tenant_name FROM payments p JOIN tenants t ON t.id=p.tenant_id ORDER BY p.created_at DESC LIMIT 200`;
    return ok({ payments: rows });
  }
  if (seg[1] === "payments" && seg[2] && seg[3] === "invoice" && method === "POST") {
    if (!nfse.enabled()) return fail("NFS-e nao configurada (FOCUSNFE_TOKEN).", 400);
    return ok(await nfse.issueForPayment(seg[2]));
  }
  if (r === "audit" && method === "GET") {
    const rows = await sql`SELECT * FROM license_events ORDER BY created_at DESC LIMIT 300`;
    return ok({ events: rows });
  }

  // ---- MEUS CLIENTES (consultoria do dono; tenant do proprio dono, ilimitado) ----
  if (r === "clients" && method === "GET") {
    const rows = await sql`SELECT * FROM clients WHERE tenant_id=${user.tenant_id} ORDER BY created_at DESC`;
    return ok({ clients: rows, used: rows.length, quota: null });
  }
  if (r === "clients" && method === "POST") {
    const b = await readJson(req);
    if (!b.name) return fail("Informe o nome do cliente.");
    const c = await one(sql`INSERT INTO clients (tenant_id, name, cnpj, slug, sector, contact_name, contact_email, phase, status)
      VALUES (${user.tenant_id}, ${b.name}, ${b.cnpj || null}, ${b.slug || null}, ${b.sector || null},
              ${b.contactName || null}, ${b.contactEmail || null}, ${b.phase || "diagnostico"}, ${b.status || "ativo"}) RETURNING *`);
    await audit({ tenantId: user.tenant_id, actorEmail: user.email, action: "client_created", entity: "client", entityId: c.id });
    return ok({ client: c });
  }

  // ---- DEMONSTRACAO ----
  if (r === "demo" && method === "GET") {
    return ok({ demo: await demoStatus() });
  }
  if (r === "demo" && method === "POST") {
    const res = await resetDemo({ actor: user });
    await audit({ tenantId: res.tenant.id, actorEmail: user.email, action: "demo_generated",
      entity: "tenant", entityId: res.tenant.id, detail: { expiresAt: res.expiresAt } });
    return ok({ link: res.link, expiresAt: res.expiresAt });
  }

  return fail("Rota do dono nao encontrada: " + r, 404);
}

function decorate(lic) { return { ...lic, activation_link: L.activationLink(lic) }; }

async function ownerDashboard() {
  const totals = await one(sql`SELECT
    (SELECT count(*)::int FROM tenants WHERE is_owner=FALSE) AS tenants,
    (SELECT count(*)::int FROM tenants WHERE status='active') AS active,
    (SELECT count(*)::int FROM tenants WHERE status IN ('suspended','blocked')) AS blocked,
    (SELECT count(*)::int FROM licenses WHERE status='active') AS active_licenses,
    (SELECT count(*)::int FROM licenses WHERE status='issued') AS pending_activation`);
  const mrr = await one(sql`SELECT coalesce(sum(amount_cents),0)::int AS cents FROM subscriptions WHERE status='active'`);
  const overdue = await sql`
    SELECT t.id, t.name, t.email, t.phone, t.status, s.current_period_end, s.billing_type, p.name AS plan_name
    FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN plans p ON p.id=s.plan_id
    WHERE t.is_owner=FALSE AND s.current_period_end IS NOT NULL
      AND s.current_period_end < now() + interval '7 days'
    ORDER BY s.current_period_end ASC LIMIT 50`;
  const byPlan = await sql`SELECT t.plan_id, p.name, count(*)::int AS n FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
    WHERE t.is_owner=FALSE GROUP BY t.plan_id, p.name ORDER BY t.plan_id`;
  return ok({ totals, mrrCents: mrr.cents, overdue, byPlan, nfseEnabled: nfse.enabled(), gateways: billing.availableGateways() });
}

// =====================================================================
//  APP OPERACIONAL LGPD (assinante + consultoria do dono)
//  Gating de recursos por modulo via assertFeature(tenant, ...).
//  seg = caminho apos "app/" (ex.: ["clients","<id>","projects"])
// =====================================================================
async function appRoutes(req, user, tenant, seg, method) {
  const head = seg[0] || "";

  // ---- BOOTSTRAP do app (carregamento inicial) ----
  if (head === "bootstrap" && method === "GET") {
    const caps = capabilities(tenant);
    const quota = await L.effectiveQuota(tenant);
    const counts = await one(sql`SELECT
      (SELECT count(*)::int FROM clients          WHERE tenant_id=${tenant.id}) AS clients,
      (SELECT count(*)::int FROM titular_requests WHERE tenant_id=${tenant.id} AND status<>'concluido') AS open_requests,
      (SELECT count(*)::int FROM incidents        WHERE tenant_id=${tenant.id} AND status<>'fechado')   AS open_incidents,
      (SELECT count(*)::int FROM documents        WHERE tenant_id=${tenant.id}) AS documents,
      (SELECT count(*)::int FROM projects         WHERE tenant_id=${tenant.id}) AS projects`);
    return ok({ capabilities: caps, quota, used: counts.clients, counts,
      user: { name: user.name, email: user.email, role: user.role },
      tenant: pubTenant(tenant) });
  }

  // ---- CLIENTES (todos os modulos; com cota) ----
  if (head === "clients" && !seg[1] && method === "GET") {
    const rows = await sql`SELECT * FROM clients WHERE tenant_id=${tenant.id} ORDER BY created_at DESC`;
    const quota = await L.effectiveQuota(tenant);
    return ok({ clients: rows, quota, used: rows.length });
  }
  if (head === "clients" && !seg[1] && method === "POST") {
    await L.assertQuotaAvailable(tenant);
    const b = await readJson(req);
    if (!b.name) return fail("Informe o nome do cliente.");
    const c = await one(sql`INSERT INTO clients (tenant_id, name, cnpj, slug, sector, contact_name, contact_email, phase, status)
      VALUES (${tenant.id}, ${b.name}, ${b.cnpj || null}, ${b.slug || null}, ${b.sector || null},
              ${b.contactName || null}, ${b.contactEmail || null}, ${b.phase || "diagnostico"}, ${b.status || "ativo"}) RETURNING *`);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "client_created", entity: "client", entityId: c.id });
    return ok({ client: c });
  }
  if (head === "clients" && seg[1] && !seg[2] && method === "GET") {
    const c = await one(sql`SELECT * FROM clients WHERE id=${seg[1]} AND tenant_id=${tenant.id}`);
    if (!c) return fail("Cliente nao encontrado.", 404);
    const documents = await sql`SELECT * FROM documents WHERE client_id=${c.id} ORDER BY created_at DESC`;
    const requests  = await sql`SELECT * FROM titular_requests WHERE client_id=${c.id} ORDER BY created_at DESC`;
    const incidents = await sql`SELECT * FROM incidents WHERE client_id=${c.id} ORDER BY created_at DESC`;
    const projects  = hasFeature(tenant, "projects")
      ? await sql`SELECT * FROM projects WHERE client_id=${c.id} ORDER BY created_at DESC` : [];
    return ok({ client: c, documents, requests, incidents, projects });
  }
  if (head === "clients" && seg[1] && !seg[2] && method === "POST") {
    const b = await readJson(req);
    const c = await one(sql`UPDATE clients SET
      name=coalesce(${b.name || null}, name), cnpj=${b.cnpj ?? null}, sector=${b.sector ?? null},
      contact_name=${b.contactName ?? null}, contact_email=${b.contactEmail ?? null},
      phase=coalesce(${b.phase || null}, phase), status=coalesce(${b.status || null}, status)
      WHERE id=${seg[1]} AND tenant_id=${tenant.id} RETURNING *`);
    if (!c) return fail("Cliente nao encontrado.", 404);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "client_updated", entity: "client", entityId: c.id });
    return ok({ client: c });
  }

  // ---- DOCUMENTOS versionados (todos os modulos) ----
  if (head === "documents" && !seg[1] && method === "GET") {
    const clientId = new URL(req.url).searchParams.get("clientId");
    const rows = clientId
      ? await sql`SELECT d.*, (SELECT max(version) FROM document_versions v WHERE v.document_id=d.id) AS last_version
                  FROM documents d WHERE d.tenant_id=${tenant.id} AND d.client_id=${clientId} ORDER BY d.created_at DESC`
      : await sql`SELECT d.*, (SELECT max(version) FROM document_versions v WHERE v.document_id=d.id) AS last_version
                  FROM documents d WHERE d.tenant_id=${tenant.id} ORDER BY d.created_at DESC`;
    return ok({ documents: rows });
  }
  if (head === "documents" && !seg[1] && method === "POST") {
    const b = await readJson(req);
    if (!b.docType && !b.title) return fail("Informe tipo/titulo do documento.");
    const d = await one(sql`INSERT INTO documents (tenant_id, client_id, doc_type, title)
      VALUES (${tenant.id}, ${b.clientId || null}, ${b.docType || "documento"}, ${b.title || null}) RETURNING *`);
    await one(sql`INSERT INTO document_versions (tenant_id, document_id, version, content, created_by)
      VALUES (${tenant.id}, ${d.id}, 1, ${b.content || ""}, ${user.id}) RETURNING id`);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "document_created", entity: "document", entityId: d.id });
    return ok({ document: d });
  }
  if (head === "documents" && seg[1] && !seg[2] && method === "GET") {
    const d = await one(sql`SELECT * FROM documents WHERE id=${seg[1]} AND tenant_id=${tenant.id}`);
    if (!d) return fail("Documento nao encontrado.", 404);
    const versions = await sql`SELECT v.*, u.email AS author FROM document_versions v LEFT JOIN users u ON u.id=v.created_by
      WHERE v.document_id=${d.id} ORDER BY v.version DESC`;
    return ok({ document: d, versions });
  }
  if (head === "documents" && seg[1] && seg[2] === "version" && method === "POST") {
    const b = await readJson(req);
    const d = await one(sql`SELECT * FROM documents WHERE id=${seg[1]} AND tenant_id=${tenant.id}`);
    if (!d) return fail("Documento nao encontrado.", 404);
    const last = await one(sql`SELECT coalesce(max(version),0)::int AS v FROM document_versions WHERE document_id=${d.id}`);
    const v = await one(sql`INSERT INTO document_versions (tenant_id, document_id, version, content, created_by)
      VALUES (${tenant.id}, ${d.id}, ${last.v + 1}, ${b.content || ""}, ${user.id}) RETURNING *`);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "document_versioned", entity: "document", entityId: d.id, detail: { version: v.version } });
    return ok({ version: v });
  }

  // ---- SOLICITACOES DE TITULARES (todos) ----
  if (head === "requests" && !seg[1] && method === "GET") {
    const rows = await sql`SELECT r.*, c.name AS client_name FROM titular_requests r LEFT JOIN clients c ON c.id=r.client_id
      WHERE r.tenant_id=${tenant.id} ORDER BY r.created_at DESC LIMIT 300`;
    return ok({ requests: rows });
  }
  if (head === "requests" && !seg[1] && method === "POST") {
    const b = await readJson(req);
    const r = await one(sql`INSERT INTO titular_requests (tenant_id, client_id, kind, requester, status)
      VALUES (${tenant.id}, ${b.clientId || null}, ${b.kind || "acesso"}, ${b.requester || null}, ${b.status || "aberto"}) RETURNING *`);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "request_created", entity: "titular_request", entityId: r.id });
    return ok({ request: r });
  }
  if (head === "requests" && seg[1] && !seg[2] && method === "POST") {
    const b = await readJson(req);
    const r = await one(sql`UPDATE titular_requests SET status=coalesce(${b.status || null}, status)
      WHERE id=${seg[1]} AND tenant_id=${tenant.id} RETURNING *`);
    if (!r) return fail("Solicitacao nao encontrada.", 404);
    return ok({ request: r });
  }

  // ---- INCIDENTES (todos) ----
  if (head === "incidents" && !seg[1] && method === "GET") {
    const rows = await sql`SELECT i.*, c.name AS client_name FROM incidents i LEFT JOIN clients c ON c.id=i.client_id
      WHERE i.tenant_id=${tenant.id} ORDER BY i.created_at DESC LIMIT 300`;
    return ok({ incidents: rows });
  }
  if (head === "incidents" && !seg[1] && method === "POST") {
    const b = await readJson(req);
    const i = await one(sql`INSERT INTO incidents (tenant_id, client_id, title, severity, status)
      VALUES (${tenant.id}, ${b.clientId || null}, ${b.title || "Incidente"}, ${b.severity || "media"}, ${b.status || "aberto"}) RETURNING *`);
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "incident_created", entity: "incident", entityId: i.id });
    return ok({ incident: i });
  }
  if (head === "incidents" && seg[1] && !seg[2] && method === "POST") {
    const b = await readJson(req);
    const i = await one(sql`UPDATE incidents SET status=coalesce(${b.status || null}, status), severity=coalesce(${b.severity || null}, severity)
      WHERE id=${seg[1]} AND tenant_id=${tenant.id} RETURNING *`);
    if (!i) return fail("Incidente nao encontrado.", 404);
    return ok({ incident: i });
  }

  // ---- PROJETOS / FASES (Intermediario+) ----
  if (head === "projects") {
    assertFeature(tenant, "projects");
    if (!seg[1] && method === "GET") {
      const clientId = new URL(req.url).searchParams.get("clientId");
      const rows = clientId
        ? await sql`SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.tenant_id=${tenant.id} AND p.client_id=${clientId} ORDER BY p.created_at DESC`
        : await sql`SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.tenant_id=${tenant.id} ORDER BY p.created_at DESC`;
      return ok({ projects: rows });
    }
    if (!seg[1] && method === "POST") {
      const b = await readJson(req);
      if (!b.clientId || !b.name) return fail("Informe cliente e nome do projeto.");
      const p = await one(sql`INSERT INTO projects (tenant_id, client_id, name, phase, due_date)
        VALUES (${tenant.id}, ${b.clientId}, ${b.name}, ${b.phase || "diagnostico"}, ${b.dueDate || null}) RETURNING *`);
      await audit({ tenantId: tenant.id, actorEmail: user.email, action: "project_created", entity: "project", entityId: p.id });
      return ok({ project: p });
    }
    if (seg[1] && !seg[2] && method === "POST") {
      const b = await readJson(req);
      const p = await one(sql`UPDATE projects SET phase=coalesce(${b.phase || null}, phase), due_date=${b.dueDate ?? null}, name=coalesce(${b.name || null}, name)
        WHERE id=${seg[1]} AND tenant_id=${tenant.id} RETURNING *`);
      if (!p) return fail("Projeto nao encontrado.", 404);
      return ok({ project: p });
    }
  }

  // ---- TAREFAS (Intermediario+) ----
  if (head === "tasks") {
    assertFeature(tenant, "tasks");
    if (!seg[1] && method === "GET") {
      const projectId = new URL(req.url).searchParams.get("projectId");
      const rows = projectId
        ? await sql`SELECT * FROM tasks WHERE tenant_id=${tenant.id} AND project_id=${projectId} ORDER BY created_at DESC`
        : await sql`SELECT * FROM tasks WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 300`;
      return ok({ tasks: rows });
    }
    if (!seg[1] && method === "POST") {
      const b = await readJson(req);
      if (!b.projectId || !b.title) return fail("Informe projeto e titulo da tarefa.");
      const tk = await one(sql`INSERT INTO tasks (tenant_id, project_id, title, status, assignee_id)
        VALUES (${tenant.id}, ${b.projectId}, ${b.title}, ${b.status || "todo"}, ${b.assigneeId || null}) RETURNING *`);
      return ok({ task: tk });
    }
    if (seg[1] && !seg[2] && method === "POST") {
      const b = await readJson(req);
      const tk = await one(sql`UPDATE tasks SET status=coalesce(${b.status || null}, status), title=coalesce(${b.title || null}, title), assignee_id=${b.assigneeId ?? null}
        WHERE id=${seg[1]} AND tenant_id=${tenant.id} RETURNING *`);
      if (!tk) return fail("Tarefa nao encontrada.", 404);
      return ok({ task: tk });
    }
  }

  // ---- EQUIPE (Avancado+) — usuarios do tenant com menor privilegio ----
  if (head === "team") {
    assertFeature(tenant, "team");
    if (!seg[1] && method === "GET") {
      const rows = await sql`SELECT id, email, name, role, active, last_login, mfa_enabled, created_at
        FROM users WHERE tenant_id=${tenant.id} ORDER BY created_at DESC`;
      return ok({ team: rows });
    }
    if (!seg[1] && method === "POST") {
      // Só ADMIN/OWNER pode adicionar membros.
      if (!["ADMIN", "OWNER"].includes(user.role)) return forbidden("Apenas administradores adicionam membros.");
      const b = await readJson(req);
      if (!b.email || !b.password) return fail("Informe e-mail e uma senha inicial (8+).");
      if (String(b.password).length < 8) return fail("A senha inicial deve ter ao menos 8 caracteres.");
      const role = ["DPO", "AUDITOR", "COLABORADOR"].includes(b.role) ? b.role : "COLABORADOR";
      const exists = await one(sql`SELECT id FROM users WHERE lower(email)=lower(${b.email})`);
      if (exists) return fail("Ja existe um usuario com este e-mail.", 409);
      const m = await one(sql`INSERT INTO users (tenant_id, email, password_hash, name, role)
        VALUES (${tenant.id}, ${b.email}, ${hashPassword(b.password)}, ${b.name || ""}, ${role}) RETURNING id, email, name, role, active, created_at`);
      await audit({ tenantId: tenant.id, actorEmail: user.email, action: "team_member_added", entity: "user", entityId: m.id, detail: { role } });
      return ok({ member: m });
    }
    if (seg[1] && !seg[2] && method === "POST") {
      if (!["ADMIN", "OWNER"].includes(user.role)) return forbidden("Apenas administradores.");
      const b = await readJson(req);
      const m = await one(sql`UPDATE users SET active=coalesce(${b.active ?? null}, active), role=coalesce(${b.role || null}, role)
        WHERE id=${seg[1]} AND tenant_id=${tenant.id} AND role<>'OWNER' RETURNING id, email, name, role, active`);
      if (!m) return fail("Membro nao encontrado.", 404);
      return ok({ member: m });
    }
  }

  // ---- ASSINATURA / STATUS DO PROPRIO TENANT ----
  if (head === "subscription" && method === "GET") {
    const sub = await one(sql`SELECT * FROM subscriptions WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 1`);
    const lic = await one(sql`SELECT * FROM licenses WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 1`);
    const plan = await one(sql`SELECT * FROM plans WHERE id=${tenant.plan_id}`);
    return ok({ tenant: pubTenant(tenant), subscription: sub, license: lic, plan, capabilities: capabilities(tenant) });
  }

  return fail("Rota nao encontrada: " + seg.join("/"), 404);
}

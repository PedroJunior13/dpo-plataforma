// =====================================================================
//  API principal — roteamento interno em /api/*
//  Areas: auth | owner (super-admin) | app (operacional LGPD) | checkout | public
// =====================================================================
import { sql, one } from "./lib/db.js";
import {
  hashPassword, verifyPassword, makeToken, userFromRequest, isOwner, uuid,
  makeMfaChallenge, verifyMfaChallenge, makeSupportToken,
  isLocked, lockMinutesLeft, MAX_FAILED_LOGINS, LOCKOUT_MINUTES,
} from "./lib/auth.js";
import {
  json, ok, fail, unauthorized, forbidden, paymentRequired, readJson, clientIp, routePath,
} from "./lib/http.js";
import { audit, setAuditContext, auditOrigin } from "./lib/audit.js";
import * as L from "./lib/licenses.js";
import * as billing from "./lib/billing.js";
import * as nfse from "./lib/nfse.js";
import { allSettings, setSettings } from "./lib/settings.js";
import { sendEmail, sendWhatsApp, waLink } from "./lib/notify.js";
import { generateSecret, verifyTotp, keyuri } from "./lib/totp.js";
import { assertFeature, capabilities, hasFeature } from "./lib/plan-features.js";
import { resetDemo, demoStatus, userFromDemoToken } from "./lib/demo.js";

export const config = { path: "/api/*" };

export default async function handler(req) {
  const method = req.method;
  const path = routePath(req); // ex.: "owner/licenses"
  const seg = path.split("/");

  // Captura a origem (ip + dispositivo + geolocalizacao) uma unica vez por request,
  // para que toda a trilha de auditoria registre DE ONDE a acao partiu.
  setAuditContext(auditOrigin(req));

  try {
    // -------- PUBLICO (sem auth) --------
    if (path === "public/plans" && method === "GET") return listPlans();
    if (path === "auth/login" && method === "POST") return login(req);
    if (path === "auth/mfa-verify" && method === "POST") return mfaVerify(req);
    if (path === "auth/demo-login" && method === "POST") return demoLogin(req);
    if (path === "auth/signup" && method === "POST") return signup(req);
    if (path === "auth/activate" && method === "POST") return activate(req);
    if (path === "auth/bootstrap-owner" && method === "POST") return bootstrapOwner(req);
    // Status do bootstrap (sem segredo): so informa se a recuperacao esta habilitada.
    if (path === "auth/bootstrap-status" && method === "GET") return ok({ available: !!process.env.BOOTSTRAP_TOKEN });
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
    // Erro de configuracao do servidor (ex.: JWT_SECRET ausente): mensagem clara,
    // sem vazar stack, para nao confundir com "senha invalida".
    if (/JWT_SECRET/.test(e?.message || "")) {
      return fail("Servidor sem JWT_SECRET configurado. Defina a variavel de ambiente no Netlify e tente de novo.", 500, { code: "SERVER_MISCONFIG" });
    }
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

// Semente do dono: garante o usuario OWNER (pedrobj@gmail.com) com a senha PADRAO
// quando ainda nao houver senha definida. Idempotente — so escreve se password_hash
// for NULL. Usado no 1o login para que o dono nunca fique travado sem acesso.
async function ensureOwnerDefaultPassword() {
  const email = (process.env.OWNER_EMAIL || "pedrobj@gmail.com").toLowerCase();
  const pwd = process.env.DEFAULT_OWNER_PASSWORD || "Mamacita@2030@";
  const hash = hashPassword(pwd);
  let u = await one(sql`UPDATE users SET password_hash=${hash}, role='OWNER', active=TRUE,
                          failed_logins=0, locked_until=NULL
                        WHERE lower(email)=lower(${email}) AND password_hash IS NULL
                        RETURNING *`);
  if (!u) {
    // Dono ainda nao semeado (migracao recem-rodada): cria com a senha padrao.
    u = await one(sql`INSERT INTO users (email, name, role, active, password_hash, tenant_id)
                      VALUES (${email}, 'Pedro (Dono)', 'OWNER', TRUE, ${hash},
                              '00000000-0000-0000-0000-000000000001')
                      ON CONFLICT (email) DO NOTHING RETURNING *`);
    if (!u) u = await one(sql`SELECT * FROM users WHERE lower(email)=lower(${email})`);
  }
  if (u) { try { await audit({ tenantId: u.tenant_id, actorEmail: email, action: "owner_seed_default_password" }); } catch {} }
  return u;
}

async function login(req) {
  // Config critica ausente => erro claro (e nao "senha invalida", que confunde).
  if (!process.env.JWT_SECRET) {
    return fail("Servidor sem JWT_SECRET configurado. Defina a variavel de ambiente no Netlify e tente de novo.", 500, { code: "SERVER_MISCONFIG" });
  }
  const { email, password } = await readJson(req);
  let u = await one(sql`SELECT * FROM users WHERE lower(email)=lower(${email || ""})`);
  // 1o acesso do dono: se o usuario dono ainda nao tem senha definida, aplica a
  // senha PADRAO (Mamacita@2030@, ou DEFAULT_OWNER_PASSWORD). Idempotente: so age
  // quando password_hash e NULL — nunca sobrescreve uma senha ja trocada pelo dono.
  if ((!u || !u.password_hash) &&
      String(email || "").toLowerCase() === (process.env.OWNER_EMAIL || "pedrobj@gmail.com").toLowerCase()) {
    try { u = await ensureOwnerDefaultPassword(); }
    catch (e) { console.warn("[login] seed do dono nao-fatal:", e.message); }
  }
  // Resposta generica p/ usuario inexistente (nao revela se o e-mail existe).
  if (!u || !u.password_hash) return fail("E-mail ou senha invalidos.", 401);
  // Anti brute-force: conta travada temporariamente.
  if (isLocked(u)) {
    return fail(`Muitas tentativas. Tente novamente em ${lockMinutesLeft(u)} min.`, 429, { code: "LOCKED" });
  }
  if (!verifyPassword(password || "", u.password_hash)) {
    await registerFailedLogin(u, req);
    return fail("E-mail ou senha invalidos.", 401);
  }
  if (!u.active) return forbidden("Usuario inativo.");
  // Sucesso: zera contador de falhas (bookkeeping NUNCA derruba um login valido).
  await clearLoginFailures(u.id);
  // 2FA: se habilitado, devolve um desafio curto em vez do token de sessao.
  if (u.mfa_enabled && u.mfa_secret) {
    return ok({ mfaRequired: true, mfaToken: await makeMfaChallenge(u) });
  }
  return finishLogin(u, req);
}

// Zera o contador de falhas. Resiliente: se o banco estiver parcialmente migrado
// (colunas failed_logins/locked_until ausentes), falha em silencio sem bloquear o
// login — a senha (e o MFA) ja foram validados antes deste ponto.
async function clearLoginFailures(id) {
  try { await sql`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=${id}`; }
  catch (e) { console.warn("[login] clearLoginFailures nao-fatal:", e.message); }
}

// Incrementa o contador de falhas e trava a conta ao atingir o limite.
// Resiliente: uma falha de escrita aqui nunca deve mascarar a resposta de login.
async function registerFailedLogin(u, req) {
  try {
    const n = (u.failed_logins || 0) + 1;
    if (n >= MAX_FAILED_LOGINS) {
      const until = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
      await sql`UPDATE users SET failed_logins=${n}, locked_until=${until} WHERE id=${u.id}`;
      await audit({ tenantId: u.tenant_id, actorEmail: u.email, action: "login_locked", detail: { attempts: n }, ip: clientIp(req) });
    } else {
      await sql`UPDATE users SET failed_logins=${n} WHERE id=${u.id}`;
    }
  } catch (e) { console.warn("[login] registerFailedLogin nao-fatal:", e.message); }
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
  const ip = clientIp(req);
  // Bookkeeping resiliente: registra tudo; se as colunas novas faltarem (banco
  // parcialmente migrado), cai para o minimo (last_login) e, no pior caso, segue
  // sem bloquear a sessao. Emitir o token de uma autenticacao valida e prioridade.
  try {
    await sql`UPDATE users SET last_login=now(), last_login_at=now(), last_login_ip=${ip}, failed_logins=0, locked_until=NULL WHERE id=${u.id}`;
  } catch (e) {
    console.warn("[login] bookkeeping completo falhou, tentando minimo:", e.message);
    try { await sql`UPDATE users SET last_login=now() WHERE id=${u.id}`; }
    catch (e2) { console.warn("[login] bookkeeping minimo falhou (nao-fatal):", e2.message); }
  }
  try { await audit({ tenantId: u.tenant_id, actorEmail: u.email, action: "login", ip }); } catch {}
  return ok({ token: await makeToken(u), user: pubUser(u) });
}

// Login do ambiente de demonstracao (sem senha — o token do link e a credencial).
async function demoLogin(req) {
  const { token } = await readJson(req);
  const r = await userFromDemoToken((token || "").trim());
  if (r.error) return fail(r.error, 401);
  await sql`UPDATE users SET last_login=now() WHERE id=${r.user.id}`;
  return ok({ token: await makeToken(r.user), user: pubUser(r.user), demo: true,
    expiresAt: r.tenant?.demo_expires_at || null });
}

// Cadastro do cliente (cria usuario SEM tenant; vincula na ativacao).
// 2FA e configurado logo apos (obrigatorio) e a licenca e inserida em seguida,
// de modo que o usuario cai exatamente no perfil (tenant) da licenca.
async function signup(req) {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const password = String(body.password || "");
  if (!email || !password) return fail("Informe e-mail e senha.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("E-mail invalido.");
  if (password.length < 8) return fail("A senha deve ter ao menos 8 caracteres.");
  const exists = await one(sql`SELECT id FROM users WHERE lower(email)=lower(${email})`);
  if (exists) return fail("Ja existe um usuario com este e-mail. Faca login para ativar.", 409, { code: "EMAIL_EXISTS" });
  const u = await one(sql`
    INSERT INTO users (email, password_hash, name, role, tenant_id)
    VALUES (${email}, ${hashPassword(password)}, ${name}, 'ADMIN', NULL)
    RETURNING *`);
  await audit({ tenantId: null, actorEmail: email, action: "signup", ip: clientIp(req) });
  return ok({ token: await makeToken(u), user: pubUser(u) });
}

// Ativacao com a licenca (destrava o modulo na 1a vez).
// Seguranca: exige 2FA configurado ANTES de vincular a licenca ao perfil.
async function activate(req) {
  const reqUser = await userFromRequest(req);
  if (!reqUser) return unauthorized("Faca login/cadastro antes de ativar.");
  const cur = await one(sql`SELECT * FROM users WHERE id=${reqUser.id}`);
  if (!cur) return unauthorized();
  if (!cur.active) return forbidden("Usuario inativo.");
  if (!cur.mfa_enabled) {
    return fail("Configure a verificacao em duas etapas (2FA) antes de ativar.", 403, { code: "MFA_REQUIRED" });
  }
  const { licenseKey, activationToken } = await readJson(req);
  const lic = await L.activateLicense({
    licenseKey: (licenseKey || "").trim().toUpperCase(),
    activationToken: (activationToken || "").trim(),
    user: cur, ip: clientIp(req),
  });
  const u = await one(sql`SELECT * FROM users WHERE id=${cur.id}`);
  await audit({ tenantId: lic.tenant_id, actorEmail: cur.email, action: "license_activated", entity: "license", entityId: lic.id, ip: clientIp(req) });
  return ok({ token: await makeToken(u), license: lic, user: pubUser(u) });
}

// Define/redefine a senha do dono (protegido por BOOTSTRAP_TOKEN). Serve tanto
// para o 1o acesso quanto para recuperacao posterior — basta reativar o token.
async function bootstrapOwner(req) {
  const { token, password } = await readJson(req);
  if (!process.env.BOOTSTRAP_TOKEN) {
    return fail("Recuperacao desativada. Configure BOOTSTRAP_TOKEN no Netlify (Environment variables) e tente de novo.", 403, { code: "BOOTSTRAP_DISABLED" });
  }
  if (token !== process.env.BOOTSTRAP_TOKEN) {
    try { await audit({ tenantId: null, actorEmail: process.env.OWNER_EMAIL || "pedrobj@gmail.com", action: "owner_bootstrap_denied", ip: clientIp(req) }); } catch {}
    return forbidden("Token de recuperacao invalido.");
  }
  if (!password || String(password).length < 10) return fail("Defina uma senha forte (10+ caracteres).");
  const email = (process.env.OWNER_EMAIL || "pedrobj@gmail.com").toLowerCase();
  const hash = hashPassword(password);
  // Caso comum: o dono ja foi semeado — define a senha preservando o vinculo.
  let u = await one(sql`UPDATE users SET password_hash=${hash}, role='OWNER', active=TRUE
                        WHERE lower(email)=lower(${email}) RETURNING *`);
  if (!u) {
    // Defensivo: o seed do dono ainda nao rodou — cria o usuario dono.
    try {
      u = await one(sql`INSERT INTO users (email, name, role, active, password_hash)
                        VALUES (${email}, 'Pedro (Dono)', 'OWNER', TRUE, ${hash})
                        ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='OWNER', active=TRUE
                        RETURNING *`);
    } catch (e) {
      console.error("[bootstrap] criacao do dono falhou:", e.message);
      return fail("Usuario dono nao encontrado e nao foi possivel cria-lo. Rode a migracao do banco (db/schema.sql) e tente de novo.", 500, { code: "OWNER_MISSING" });
    }
  }
  // Vincula o tenant do dono, se existir, sem falhar caso ainda nao haja.
  try {
    const ot = await one(sql`SELECT id FROM tenants WHERE id='00000000-0000-0000-0000-000000000001'`);
    if (ot && !u.tenant_id) { await sql`UPDATE users SET tenant_id=${ot.id} WHERE id=${u.id}`; u.tenant_id = ot.id; }
  } catch {}
  // Destrava eventual bloqueio por tentativas (nao-fatal).
  try { await sql`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=${u.id}`; } catch {}
  await audit({ tenantId: u.tenant_id, actorEmail: email, action: "owner_bootstrap", ip: clientIp(req) });
  return ok({ message: "Senha do dono definida. Faca login em / (e ative o 2FA na aba Conta).", email });
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
  let { planId, billingType = "monthly", method = "pix", gateway, tenant: t } = b;
  const plan = await one(sql`SELECT * FROM plans WHERE id=${planId} AND active`);
  if (!plan || plan.id === "owner") return fail("Plano invalido.");
  if (!t?.email || !t?.name) return fail("Informe nome e e-mail do assinante.");

  // Regra de negocio: cobranca RECORRENTE e EXCLUSIVA do cartao de credito
  // (renovacao automatica so e possivel no cartao). Garantia no servidor, alem
  // da trava do checkout no front: recusa a combinacao invalida.
  if (billingType === "recurring" && method !== "credit_card") {
    return fail("A cobranca recorrente e exclusiva do cartao de credito. Para PIX ou boleto, escolha a cobranca avulsa.", 400, { code: "RECURRING_REQUIRES_CARD" });
  }

  const amount = billingType === "recurring" ? plan.price_recurring_cents : plan.price_month_cents;

  const tenant = await one(sql`
    INSERT INTO tenants (name, email, phone, doc, plan_id, status)
    VALUES (${t.name}, ${t.email}, ${t.phone || null}, ${t.doc || null}, ${planId}, 'pending')
    RETURNING *`);

  // Tenta o gateway; se NENHUM estiver configurado, segue em modo "manual":
  // a compra fica registrada (pendente) e o dono gera a licenca em 1 clique.
  let charge = null, manual = false;
  try {
    charge = await billing.createCharge({ gateway, billingType, method, tenant, plan, amountCents: amount });
  } catch (e) {
    manual = true;
    charge = { gateway: "manual", checkoutUrl: null, gatewayRef: null, gatewaySubscriptionId: null };
  }

  const sub = await one(sql`
    INSERT INTO subscriptions (tenant_id, plan_id, billing_type, gateway, gateway_subscription_id, amount_cents, status)
    VALUES (${tenant.id}, ${planId}, ${billingType}, ${charge.gateway}, ${charge.gatewaySubscriptionId || null}, ${amount}, 'pending')
    RETURNING *`);
  await sql`INSERT INTO payments (tenant_id, subscription_id, gateway, gateway_payment_id, method, amount_cents, status)
            VALUES (${tenant.id}, ${sub.id}, ${charge.gateway}, ${charge.gatewayRef || charge.gatewaySubscriptionId || null}, ${method}, ${amount}, 'pending')`;
  await audit({ tenantId: tenant.id, actorEmail: t.email, action: "checkout_created", entity: "subscription", entityId: sub.id, detail: { planId, billingType, amount, manual } });

  // Alimenta o CRM (funil) com a intencao de compra — vira "proposta".
  try { await crmUpsertFromCheckout({ tenant: t, tenantId: tenant.id, planId, amount }); } catch (_) {}

  return ok({
    checkoutUrl: charge.checkoutUrl, manual,
    tenantId: tenant.id, subscriptionId: sub.id, amountCents: amount,
    planName: plan.name,
    message: manual
      ? "Pedido registrado! Nossa equipe vai confirmar o pagamento e liberar seu acesso em instantes."
      : null,
  });
}

// Cria/atualiza um contato no CRM a partir de um checkout (funil de vendas).
async function crmUpsertFromCheckout({ tenant: t, tenantId, planId, amount }) {
  const doc = (t.doc || "").replace(/\D/g, "") || null;
  const existing = await one(sql`
    SELECT * FROM crm_contacts
    WHERE (email IS NOT NULL AND lower(email)=lower(${t.email}))
       OR (${doc}::text IS NOT NULL AND doc=${doc})
    ORDER BY created_at DESC LIMIT 1`);
  if (existing) {
    await sql`UPDATE crm_contacts SET tenant_id=${tenantId}, stage='proposta', plan_interest=${planId},
      value_cents=${amount}, company=coalesce(${t.name}, company), phone=coalesce(${t.phone || null}, phone),
      doc=coalesce(${doc}, doc), last_contact_at=now(), updated_at=now() WHERE id=${existing.id}`;
    await sql`INSERT INTO crm_activities (contact_id, type, body, actor_email)
      VALUES (${existing.id}, 'campanha', ${'Nova compra via checkout: ' + planId}, 'checkout')`;
    return existing.id;
  }
  const c = await one(sql`
    INSERT INTO crm_contacts (tenant_id, name, company, doc, email, phone, source, stage, plan_interest, value_cents)
    VALUES (${tenantId}, ${t.name}, ${t.name}, ${doc}, ${t.email}, ${t.phone || null}, 'checkout', 'proposta', ${planId}, ${amount})
    RETURNING id`);
  await sql`INSERT INTO crm_activities (contact_id, type, body, actor_email)
    VALUES (${c.id}, 'campanha', ${'Lead criado via checkout: ' + planId}, 'checkout')`;
  return c.id;
}

// AUTO-CRM na emissao da licenca: garante que TODO novo cliente (compra ou emissao
// manual) tenha um cadastro no CRM no estagio "cliente". Idempotente e best-effort.
async function crmEnsureClientFromTenant(tenantId, planId, source = "licenca") {
  try {
    const t = await one(sql`SELECT id, name, email, phone, doc FROM tenants WHERE id=${tenantId}`);
    if (!t) return null;
    const doc = (t.doc || "").replace(/\D/g, "") || null;
    const existing = await one(sql`SELECT id FROM crm_contacts WHERE tenant_id=${tenantId}
      OR (email IS NOT NULL AND lower(email)=lower(${t.email || ""})) ORDER BY created_at DESC LIMIT 1`);
    if (existing) {
      await sql`UPDATE crm_contacts SET tenant_id=${tenantId}, stage='cliente', plan_interest=coalesce(${planId}, plan_interest),
        company=coalesce(${t.name}, company), phone=coalesce(${t.phone || null}, phone), doc=coalesce(${doc}, doc),
        last_contact_at=now(), updated_at=now() WHERE id=${existing.id}`;
      return existing.id;
    }
    const c = await one(sql`
      INSERT INTO crm_contacts (tenant_id, name, company, doc, email, phone, source, stage, plan_interest)
      VALUES (${tenantId}, ${t.name}, ${t.name}, ${doc}, ${t.email || null}, ${t.phone || null}, ${source}, 'cliente', ${planId})
      RETURNING id`);
    await sql`INSERT INTO crm_activities (contact_id, type, body, actor_email)
      VALUES (${c.id}, 'nota', ${'Cliente cadastrado automaticamente na emissao da licenca (' + (planId || "") + ').'}, 'system')`;
    return c.id;
  } catch (e) { console.error("[crm:autoclient]", e?.message); return null; }
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
    const rows = await safe(sql`
      SELECT l.*, t.name AS tenant_name, t.email AS tenant_email, t.phone AS tenant_phone,
             t.status AS tenant_status, t.client_quota_override, p.name AS plan_name, p.tier AS plan_tier,
             (SELECT count(*)::int FROM clients c WHERE c.tenant_id=t.id) AS clients_count
      FROM licenses l JOIN tenants t ON t.id=l.tenant_id LEFT JOIN plans p ON p.id=l.plan_id
      ORDER BY l.created_at DESC LIMIT 300`, []);
    const plans = await safe(sql`SELECT id,name,tier,client_quota FROM plans WHERE id<>'owner' ORDER BY tier`, []);
    return ok({ licenses: rows.map(decorate), plans });
  }
  if (r === "licenses" && method === "POST") {
    const b = await readJson(req);
    if (!b.tenantId && !b.tenant?.name) return fail("Informe um cliente (novo ou existente).");
    const isFree = b.pricing === "free" || b.billingType === "free";
    const res = await L.issueLicense({
      tenantId: b.tenantId || null,
      tenant: b.tenant || null,
      planId: b.planId || "basic",
      // Cortesia (sem custo) nao tem cobranca recorrente: forca avulsa por validade.
      billingType: isFree ? "monthly" : (b.billingType || "monthly"),
      pricing: isFree ? "free" : "paid",
      reason: b.reason || null,
      validDays: b.validDays || null,
      actor: user,
    });
    // AUTO-CRM: toda licenca emitida manualmente tambem cadastra o cliente no CRM.
    await crmEnsureClientFromTenant(res.license.tenant_id, b.planId || "basic", "emissao_manual");
    await audit({ tenantId: res.license.tenant_id, actorEmail: user.email, action: "license_issued", entity: "license", entityId: res.license.id, detail: { planId: b.planId, license_no: res.license.license_no, pricing: res.license.pricing, reason: b.reason || null } });
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
      await safe(sendEmail({ tenantId: lic.tenant_id, to: lic.tenant_email, subject: "Seu acesso — DPO PJ Protection",
        html: `<pre style="font-family:inherit">${message}</pre>`, type: "license_sent" }), null);
    }
    return ok({ link, message, whatsapp: lic.tenant_phone ? waLink(lic.tenant_phone, message) : null });
  }
  if (seg[1] === "licenses" && seg[2] && seg[3] === "suspend" && method === "POST")
    return ok({ license: await L.suspendLicense(seg[2], user) });
  if (seg[1] === "licenses" && seg[2] && seg[3] === "reactivate" && method === "POST")
    return ok({ license: await L.reactivateLicense(seg[2], user) });
  if (seg[1] === "licenses" && seg[2] && seg[3] === "revoke" && method === "POST")
    return ok({ license: await L.revokeLicense(seg[2], user) });

  // Ativar / Inativar cliente (inadimplencia ou desativacao manual).
  if (seg[1] === "tenants" && seg[2] && seg[3] === "active" && method === "POST") {
    const b = await readJson(req);
    const t = await L.setTenantActive({ tenantId: seg[2], active: !!b.active, actor: user, reason: b.reason });
    await audit({ tenantId: seg[2], actorEmail: user.email, action: b.active ? "tenant_reactivated" : "tenant_inactivated", entity: "tenant", entityId: seg[2], detail: { reason: b.reason || null }, ip: clientIp(req) });
    return ok({ tenant: t, status: await L.tenantStatusInfo(t) });
  }
  // Acesso de suporte: gera token de impersonacao (dono opera no ambiente do cliente).
  if (seg[1] === "tenants" && seg[2] && seg[3] === "support" && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const t = await one(sql`SELECT * FROM tenants WHERE id=${seg[2]}`);
    if (!t) return fail("Cliente nao encontrado.", 404);
    const token = await makeSupportToken(user, t.id);
    await sql`INSERT INTO support_sessions (owner_email, tenant_id, reason, ip) VALUES (${user.email}, ${t.id}, ${b?.reason || null}, ${clientIp(req)})`;
    await audit({ tenantId: t.id, actorEmail: user.email, action: "support_access", entity: "tenant", entityId: t.id, detail: { reason: b?.reason || null }, ip: clientIp(req) });
    return ok({ token, tenant: pubTenant(t), link: `/app/?support=${encodeURIComponent(token)}` });
  }
  // Regenerar acesso (novo token de ativacao) e resetar MFA — suporte.
  if (seg[1] === "tenants" && seg[2] && seg[3] === "regen" && method === "POST") {
    const res = await L.regenerateActivation({ tenantId: seg[2], actor: user });
    await audit({ tenantId: seg[2], actorEmail: user.email, action: "access_regenerated", entity: "tenant", entityId: seg[2], ip: clientIp(req) });
    const t = await one(sql`SELECT phone FROM tenants WHERE id=${seg[2]}`);
    return ok({ link: res.link, message: res.message, whatsapp: t?.phone ? waLink(t.phone, res.message) : null });
  }
  if (seg[1] === "tenants" && seg[2] && seg[3] === "reset-mfa" && method === "POST") {
    await L.resetTenantMfa({ tenantId: seg[2], actor: user });
    await audit({ tenantId: seg[2], actorEmail: user.email, action: "mfa_reset_by_support", entity: "tenant", entityId: seg[2], ip: clientIp(req) });
    return ok({ ok: true });
  }
  // Redefinir senha do cliente (gera senha temporaria) — suporte do dono.
  if (seg[1] === "tenants" && seg[2] && seg[3] === "reset-password" && method === "POST") {
    const res = await L.resetTenantPassword({ tenantId: seg[2], actor: user });
    await audit({ tenantId: seg[2], actorEmail: user.email, action: "password_reset_by_support", entity: "tenant", entityId: seg[2], ip: clientIp(req) });
    const t = await one(sql`SELECT phone FROM tenants WHERE id=${seg[2]}`);
    const msg = `Sua senha de acesso a plataforma DPO PJ Protection foi redefinida.\n\nE-mail: ${res.email}\nSenha temporaria: ${res.tempPassword}\n\nAcesse e troque a senha assim que entrar. Seu 2FA continua valendo.`;
    return ok({ email: res.email, tempPassword: res.tempPassword, message: msg, whatsapp: t?.phone ? waLink(t.phone, msg) : null });
  }

  // ---- PAGAMENTOS / NOTAS ----
  if (r === "payments" && method === "GET") {
    const rows = await safe(sql`SELECT p.*, t.name AS tenant_name FROM payments p JOIN tenants t ON t.id=p.tenant_id ORDER BY p.created_at DESC LIMIT 200`, []);
    return ok({ payments: rows });
  }
  if (seg[1] === "payments" && seg[2] && seg[3] === "invoice" && method === "POST") {
    if (!(await nfse.enabled())) return fail("NFS-e nao configurada. Configure na aba Integracoes.", 400);
    return ok(await nfse.issueForPayment(seg[2]));
  }

  // ---- INTEGRACOES (configuracao da NFS-e e demais parametros) ----
  // GET: estado atual (token mascarado) + diagnostico do que falta.
  if (r === "integrations" && method === "GET") {
    return ok({ nfse: await nfse.status() });
  }
  // POST: salva os parametros de emissao da NFS-e (precedencia sobre env).
  // O token so e sobrescrito quando enviado nao-vazio (evita apagar por engano).
  if (seg[1] === "integrations" && seg[2] === "nfse" && seg[3] == null && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const patch = {};
    const map = {
      env: "nfse_env", cnpj: "nfse_cnpj", im: "nfse_im", municipio: "nfse_municipio",
      item: "nfse_item_lista", codigoTributario: "nfse_codigo_tributario",
      aliquota: "nfse_aliquota", optanteSimples: "nfse_optante_simples",
      regimeEspecial: "nfse_regime_especial", auto: "nfse_auto",
    };
    for (const [field, key] of Object.entries(map)) {
      if (b[field] === undefined) continue; // nao mexe no que nao veio
      let v = b[field];
      if (typeof v === "boolean") v = v ? "true" : "false";
      patch[key] = v;
    }
    // Token: so grava se veio preenchido; string vazia explicita = remover.
    if (typeof b.token === "string") {
      const tk = b.token.trim();
      if (tk && !/^[•*]/.test(tk)) patch.nfse_token = tk;   // ignora o valor mascarado
      else if (b.clearToken === true) patch.nfse_token = "";
    }
    await setSettings(patch, user.email);
    await audit({ actorEmail: user.email, action: "integrations_nfse_updated", entity: "settings",
      detail: { keys: Object.keys(patch), env: patch.nfse_env }, ip: clientIp(req) });
    return ok({ nfse: await nfse.status() });
  }
  // POST .../test: valida a configuracao (campos obrigatorios presentes).
  if (seg[1] === "integrations" && seg[2] === "nfse" && seg[3] === "test" && method === "POST") {
    const st = await nfse.status();
    if (!st.enabled) return fail("Informe o token Focus NFe para ativar a emissao.", 400);
    if (!st.ready) return fail("Faltam dados obrigatorios: " + (st.missing || []).join(", "), 400);
    return ok({ nfse: st, message: `Configuracao valida (ambiente: ${st.env}). Pronta para emitir.` });
  }

  // ---- COMPRAS (transacoes do checkout que chegam ao painel) ----
  // Cada compra traz toda a informacao da transacao + o modulo escolhido,
  // com botao "Gerar licenca" (1 clique) inerente ao modulo comprado.
  if (r === "purchases" && method === "GET") {
    const rows = await safe(sql`
      SELECT s.id AS subscription_id, s.status AS sub_status, s.billing_type, s.gateway,
             s.amount_cents, s.created_at, s.plan_id,
             t.id AS tenant_id, t.name AS tenant_name, t.email AS tenant_email, t.phone AS tenant_phone,
             t.doc AS tenant_doc, t.status AS tenant_status, p.name AS plan_name, p.tier AS plan_tier,
             p.client_quota,
             (SELECT pay.method FROM payments pay WHERE pay.subscription_id=s.id ORDER BY pay.created_at DESC LIMIT 1) AS method,
             (SELECT pay.status FROM payments pay WHERE pay.subscription_id=s.id ORDER BY pay.created_at DESC LIMIT 1) AS pay_status,
             EXISTS(SELECT 1 FROM licenses l WHERE l.tenant_id=t.id) AS has_license
      FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN plans p ON p.id=s.plan_id
      WHERE t.is_owner=FALSE ORDER BY s.created_at DESC LIMIT 200`, []);
    return ok({ purchases: rows });
  }
  // Gera a licenca inerente ao modulo comprado, a partir da assinatura.
  if (seg[1] === "purchases" && seg[2] && seg[3] === "issue" && method === "POST") {
    const sub = await one(sql`SELECT * FROM subscriptions WHERE id=${seg[2]}`);
    if (!sub) return fail("Compra nao encontrada.", 404);
    const exists = await one(sql`SELECT id FROM licenses WHERE tenant_id=${sub.tenant_id} ORDER BY created_at DESC LIMIT 1`);
    if (exists) return fail("Este cliente ja possui licenca. Gerencie em Licencas.", 409, { code: "ALREADY_LICENSED" });
    const res = await L.issueLicense({
      tenantId: sub.tenant_id, planId: sub.plan_id, billingType: sub.billing_type || "monthly",
      subscriptionId: sub.id, actor: user,
    });
    // Marca a assinatura como ativa (pagamento confirmado manualmente) e CRM => cliente.
    await sql`UPDATE subscriptions SET status='active' WHERE id=${sub.id}`;
    await crmEnsureClientFromTenant(sub.tenant_id, sub.plan_id, "compra");
    const t = await one(sql`SELECT name, email, phone FROM tenants WHERE id=${sub.tenant_id}`);

    // ENVIO AUTOMATICO: licenca + credenciais/instrucoes de acesso vao direto ao
    // e-mail do comprador (independente do "+ Emitir licenca" avulso). Best-effort:
    // se o e-mail falhar, a emissao continua valida e o link fica disponivel ao dono.
    // emailStatus reflete o RESULTADO REAL do envio: "sent" (entregue ao provedor),
    // "queued" (provedor de e-mail NAO configurado — RESEND_API_KEY ausente) ou
    // "error" (provedor recusou). So marcamos "enviado" quando status==="sent".
    let emailedTo = null, emailStatus = null;
    if (t?.email) {
      const sent = await safe(sendEmail({
        tenantId: sub.tenant_id, to: t.email,
        subject: "Seu acesso e sua licença — DPO PJ Protection",
        html: licenseEmailHtml({ tenantName: t.name, planName: res.plan?.name, licenseKey: res.license.license_key, licenseNo: res.license.license_no, link: res.link }),
        type: "license_credentials",
      }), null);
      emailStatus = sent?.status || "error";
      if (emailStatus === "sent") { emailedTo = t.email; await L.markSent(res.license.id, user).catch(() => {}); }
    }
    // EMISSAO AUTOMATICA da NFS-e (apos a compra). Best-effort e nao-bloqueante:
    // se a integracao nao estiver configurada/aprovada, a licenca segue valida.
    let nfseAuto = null;
    try {
      const nf = await nfse.autoIssueForSubscription(sub.id);
      if (nf?.issued) { nfseAuto = "emitida"; await audit({ tenantId: sub.tenant_id, actorEmail: "system", action: "nfse_auto_issued", entity: "invoice", entityId: nf.invoiceId || null, detail: { ref: nf.ref } }); }
      else if (nf?.error) nfseAuto = "erro";
      else nfseAuto = nf?.skipped || null;
    } catch (e) { console.error("[nfse:auto:route]", e?.message); }
    await audit({ tenantId: sub.tenant_id, actorEmail: user.email, action: "license_issued_from_purchase", entity: "license", entityId: res.license.id, detail: { subscriptionId: sub.id, planId: sub.plan_id, license_no: res.license.license_no, emailedTo, emailStatus, nfse: nfseAuto } });
    return ok({ license: res.license, plan: res.plan, link: res.link, message: res.message, emailedTo, emailStatus, nfse: nfseAuto, whatsapp: t?.phone ? waLink(t.phone, res.message) : null });
  }

  // ---- AUDITORIA (trilha completa da area negocial: eventos + audit_log) ----
  if (r === "audit" && method === "GET") {
    const lim = Math.min(parseInt(new URL(req.url).searchParams.get("limit") || "300", 10) || 300, 500);
    const events = await safe(sql`SELECT 'license' AS kind, id::text AS id, created_at, event AS action, actor_email, tenant_id, note AS detail,
                                    NULL AS ip, NULL AS user_agent, NULL AS geo_label
                             FROM license_events ORDER BY created_at DESC LIMIT 200`, []);
    // Inclui origem detalhada (ip, dispositivo, local) — fallback gracioso se as colunas ainda nao migraram.
    const logs = await safe(sql`SELECT 'audit' AS kind, id::text AS id, created_at, action, actor_email, tenant_id, (detail::text) AS detail,
                                  ip, user_agent, geo_label
                           FROM audit_log ORDER BY created_at DESC LIMIT 200`,
                      await safe(sql`SELECT 'audit' AS kind, id::text AS id, created_at, action, actor_email, tenant_id, (detail::text) AS detail,
                                  ip, NULL AS user_agent, NULL AS geo_label
                           FROM audit_log ORDER BY created_at DESC LIMIT 200`, []));
    const merged = [...events, ...logs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, lim);
    return ok({ events: merged });
  }

  // ---- CRM (funil de vendas + atividades + campanhas de fidelizacao) ----
  if (seg[1] === "crm") return ownerCrmRoutes(req, user, seg.slice(2), method);

  // ---- SERVICE DESK (fila de chamados, SLA, respostas, dashboards) ----
  if (seg[1] === "support") return ownerSupportRoutes(req, user, seg.slice(2), method);

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

// E-mail HTML com a licenca + credenciais/instrucoes de primeiro acesso.
// Enviado automaticamente ao comprador quando o dono emite a licenca pela aba Compras.
function licenseEmailHtml({ tenantName, planName, licenseKey, licenseNo, link }) {
  const no = licenseNo ? `<tr><td style="padding:4px 0;color:#667">Nº da licença</td><td style="padding:4px 0;font-weight:700">${escapeHtml(licenseNo)}</td></tr>` : "";
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e">
    <h2 style="margin:0 0 4px">Bem-vindo(a) à DPO PJ Protection 🛡️</h2>
    <p style="color:#555;line-height:1.6">Olá${tenantName ? `, <strong>${escapeHtml(tenantName)}</strong>` : ""}! Seu acesso à plataforma de conformidade LGPD/GDPR já está liberado. Siga os 3 passos abaixo para começar.</p>
    <table style="width:100%;border-collapse:collapse;background:#f6f7fb;border-radius:10px;padding:8px;margin:14px 0">
      <tr><td style="padding:4px 0;color:#667">Módulo contratado</td><td style="padding:4px 0;font-weight:700">${escapeHtml(planName || "")}</td></tr>
      ${no}
      <tr><td style="padding:4px 0;color:#667">Sua licença</td><td style="padding:4px 0;font-weight:700;font-family:monospace">${escapeHtml(licenseKey)}</td></tr>
    </table>
    <ol style="line-height:1.8;color:#333">
      <li>Clique no botão <strong>Ativar meu acesso</strong> abaixo.</li>
      <li>Crie seu usuário (seu <strong>e-mail</strong> e uma <strong>senha</strong>).</li>
      <li>A licença já vem preenchida — é só confirmar para liberar o módulo.</li>
    </ol>
    <p style="text-align:center;margin:22px 0">
      <a href="${escapeHtml(link)}" style="background:#c9a14a;color:#1a1a2e;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px;display:inline-block">Ativar meu acesso →</a>
    </p>
    <p style="color:#888;font-size:12px;line-height:1.5">Se o botão não funcionar, copie e cole este link no navegador:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
    <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
    <p style="color:#999;font-size:12px">Este link é pessoal e libera o seu módulo no primeiro acesso. Em caso de dúvida, basta responder este e-mail.<br>DPO PJ Protection — PJ Technology Solutions.</p>
  </div>`;
}

// =====================================================================
//  CRM — funil de vendas, atividades e campanhas de fidelizacao
//  cseg = caminho apos "owner/crm/" (ex.: ["contacts","<id>","activity"])
// =====================================================================
const CRM_STAGES = ["lead", "contato", "proposta", "ganho", "perdido", "cliente"];

// Consulta de leitura tolerante a falha de schema. Se o banco estiver
// parcialmente migrado (uma tabela/coluna ainda nao criada), NAO derruba o
// painel inteiro: registra o erro no log e devolve um valor padrao seguro.
// Usado nos paineis do dono (dashboard/CRM) — areas que nunca podem falhar.
async function safe(promise, fallback) {
  try { return await promise; }
  catch (e) { console.error("[api:safe]", e?.message || e); return fallback; }
}
async function ownerCrmRoutes(req, user, cseg, method) {
  const head = cseg[0] || "";

  // ---- Indicadores do funil (para o dashboard do CRM) ----
  if (head === "stats" && method === "GET") {
    const byStage = await safe(sql`SELECT stage, count(*)::int AS n, coalesce(sum(value_cents),0)::int AS value
      FROM crm_contacts GROUP BY stage`, []);
    const totals = await safe(one(sql`SELECT
      (SELECT count(*)::int FROM crm_contacts) AS contacts,
      (SELECT count(*)::int FROM crm_contacts WHERE stage='cliente') AS clients,
      (SELECT count(*)::int FROM crm_contacts WHERE next_action_at IS NOT NULL AND next_action_at < now() + interval '3 days') AS due_soon,
      (SELECT count(*)::int FROM crm_campaigns) AS campaigns`),
      { contacts: 0, clients: 0, due_soon: 0, campaigns: 0 });
    const map = {}; CRM_STAGES.forEach(s => map[s] = { n: 0, value: 0 });
    (byStage || []).forEach(r => { if (map[r.stage]) map[r.stage] = { n: r.n, value: r.value }; });
    const won = map.ganho.n + map.cliente.n;
    const conversion = totals.contacts ? Math.round((won / totals.contacts) * 100) : 0;
    return ok({ byStage: map, totals, conversion, stages: CRM_STAGES });
  }

  // ---- Auto-preenchimento por CNPJ (BrasilAPI — gratuita, sem chave) ----
  if (head === "cnpj" && cseg[1] && method === "GET") {
    const doc = (cseg[1] || "").replace(/\D/g, "");
    if (doc.length !== 14) return fail("CNPJ invalido.");
    try {
      const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${doc}`);
      if (!r.ok) return fail("CNPJ nao encontrado.", 404);
      const d = await r.json();
      return ok({ company: {
        name: d.razao_social || d.nome_fantasia || "",
        fantasy: d.nome_fantasia || "",
        email: d.email || "",
        phone: d.ddd_telefone_1 || "",
        city: d.municipio || "", uf: d.uf || "",
      } });
    } catch (_) { return fail("Consulta de CNPJ indisponivel no momento.", 502); }
  }

  // ---- CONTATOS ----
  if (head === "contacts" && !cseg[1] && method === "GET") {
    const stage = new URL(req.url).searchParams.get("stage");
    const rows = stage
      ? await safe(sql`SELECT * FROM crm_contacts WHERE stage=${stage} ORDER BY updated_at DESC LIMIT 500`, [])
      : await safe(sql`SELECT * FROM crm_contacts ORDER BY updated_at DESC LIMIT 500`, []);
    return ok({ contacts: rows });
  }
  if (head === "contacts" && !cseg[1] && method === "POST") {
    const b = await readJson(req);
    if (!b.name) return fail("Informe o nome do contato.");
    const doc = (b.doc || "").replace(/\D/g, "") || null;
    const stage = CRM_STAGES.includes(b.stage) ? b.stage : "lead";
    const c = await one(sql`INSERT INTO crm_contacts
      (name, company, doc, email, phone, source, stage, plan_interest, value_cents, owner_email, notes, tags, next_action_at)
      VALUES (${b.name}, ${b.company || null}, ${doc}, ${b.email || null}, ${b.phone || null},
              ${b.source || "manual"}, ${stage}, ${b.planInterest || null}, ${b.valueCents || 0},
              ${user.email}, ${b.notes || null}, ${b.tags || null}, ${b.nextActionAt || null}) RETURNING *`);
    await sql`INSERT INTO crm_activities (contact_id, type, body, actor_email) VALUES (${c.id}, 'nota', 'Contato criado.', ${user.email})`;
    await audit({ actorEmail: user.email, action: "crm_contact_created", entity: "crm_contact", entityId: c.id });
    return ok({ contact: c });
  }
  if (head === "contacts" && cseg[1] && !cseg[2] && method === "GET") {
    const c = await one(sql`SELECT * FROM crm_contacts WHERE id=${cseg[1]}`);
    if (!c) return fail("Contato nao encontrado.", 404);
    const activities = await sql`SELECT * FROM crm_activities WHERE contact_id=${c.id} ORDER BY created_at DESC LIMIT 100`;
    return ok({ contact: c, activities });
  }
  if (head === "contacts" && cseg[1] && !cseg[2] && method === "POST") {
    const b = await readJson(req);
    const doc = b.doc != null ? ((b.doc || "").replace(/\D/g, "") || null) : undefined;
    const c = await one(sql`UPDATE crm_contacts SET
      name=coalesce(${b.name || null}, name), company=${b.company ?? null}, email=${b.email ?? null},
      phone=${b.phone ?? null}, doc=coalesce(${doc ?? null}, doc),
      plan_interest=${b.planInterest ?? null}, value_cents=coalesce(${b.valueCents ?? null}, value_cents),
      notes=${b.notes ?? null}, tags=${b.tags ?? null}, next_action_at=${b.nextActionAt ?? null},
      updated_at=now() WHERE id=${cseg[1]} RETURNING *`);
    if (!c) return fail("Contato nao encontrado.", 404);
    return ok({ contact: c });
  }
  // Mover de estagio no funil (registra atividade).
  if (head === "contacts" && cseg[1] && cseg[2] === "stage" && method === "POST") {
    const b = await readJson(req);
    if (!CRM_STAGES.includes(b.stage)) return fail("Estagio invalido.");
    const c = await one(sql`UPDATE crm_contacts SET stage=${b.stage}, last_contact_at=now(), updated_at=now() WHERE id=${cseg[1]} RETURNING *`);
    if (!c) return fail("Contato nao encontrado.", 404);
    await sql`INSERT INTO crm_activities (contact_id, type, body, actor_email) VALUES (${c.id}, 'estagio', ${'Movido para: ' + b.stage}, ${user.email})`;
    await audit({ actorEmail: user.email, action: "crm_stage_changed", entity: "crm_contact", entityId: c.id, detail: { stage: b.stage } });
    return ok({ contact: c });
  }
  // Registrar atividade (nota/ligacao/email/whatsapp/reuniao).
  if (head === "contacts" && cseg[1] && cseg[2] === "activity" && method === "POST") {
    const b = await readJson(req);
    const types = ["nota", "ligacao", "email", "whatsapp", "reuniao", "campanha"];
    const type = types.includes(b.type) ? b.type : "nota";
    const a = await one(sql`INSERT INTO crm_activities (contact_id, type, body, actor_email)
      VALUES (${cseg[1]}, ${type}, ${b.body || null}, ${user.email}) RETURNING *`);
    await sql`UPDATE crm_contacts SET last_contact_at=now(), next_action_at=${b.nextActionAt ?? null}, updated_at=now() WHERE id=${cseg[1]}`;
    return ok({ activity: a });
  }

  // ---- CAMPANHAS (fidelizacao/retencao) ----
  // Resiliente: se a tabela ainda nao migrou, devolve lista vazia em vez de quebrar a UI.
  if (head === "campaigns" && !cseg[1] && method === "GET") {
    const rows = await safe(sql`SELECT * FROM crm_campaigns ORDER BY created_at DESC LIMIT 100`, []);
    return ok({ campaigns: rows });
  }
  if (head === "campaigns" && !cseg[1] && method === "POST") {
    const b = await readJson(req);
    if (!b.name || !b.message) return fail("Informe nome e mensagem da campanha.");
    const channel = b.channel === "email" ? "email" : "whatsapp";
    const c = await safe(one(sql`INSERT INTO crm_campaigns (name, channel, audience, message, scheduled_at)
      VALUES (${b.name}, ${channel}, ${b.audience || "todos"}, ${b.message}, ${b.scheduledAt || null}) RETURNING *`), null);
    if (!c) return fail("Nao foi possivel criar a campanha agora. Tente novamente em instantes.", 503);
    await audit({ actorEmail: user.email, action: "crm_campaign_created", entity: "crm_campaign", entityId: c.id });
    return ok({ campaign: c });
  }
  // Disparo da campanha: monta os destinatarios + links prontos (wa.me / mailto).
  // Sem custo de API: o dono dispara em 1 clique pelos links gerados.
  if (head === "campaigns" && cseg[1] && cseg[2] === "send" && method === "POST") {
    const camp = await safe(one(sql`SELECT * FROM crm_campaigns WHERE id=${cseg[1]}`), null);
    if (!camp) return fail("Campanha nao encontrada.", 404);
    const aud = camp.audience || "todos";
    const contacts = await safe(
      aud === "todos"
        ? sql`SELECT * FROM crm_contacts WHERE phone IS NOT NULL OR email IS NOT NULL`
        : sql`SELECT * FROM crm_contacts WHERE stage=${aud} AND (phone IS NOT NULL OR email IS NOT NULL)`,
      []);
    const recipients = contacts.map(c => {
      const msg = (camp.message || "").replace(/\{nome\}/gi, c.name || "").replace(/\{empresa\}/gi, c.company || "");
      return {
        id: c.id, name: c.name, phone: c.phone, email: c.email,
        whatsapp: c.phone ? waLink(c.phone, msg) : null,
        mailto: c.email ? `mailto:${c.email}?subject=${encodeURIComponent(camp.name)}&body=${encodeURIComponent(msg)}` : null,
      };
    });
    // Canal e-mail: dispara de fato via Resend quando configurado (objetivo/automatizado).
    let emailed = 0;
    if (camp.channel === "email") {
      for (const r of recipients) {
        if (!r.email) continue;
        const msg = (camp.message || "").replace(/\{nome\}/gi, r.name || "").replace(/\{empresa\}/gi, "");
        const sent = await safe(sendEmail({
          to: r.email, subject: camp.name,
          html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.6">${escapeHtml(msg).replace(/\n/g, "<br>")}</div>`,
          type: "campaign",
        }), null);
        if (sent) emailed++;
      }
    }
    await safe(sql`UPDATE crm_campaigns SET status='enviada', sent_count=${recipients.length}, sent_at=now() WHERE id=${camp.id}`, null);
    for (const c of contacts) {
      await safe(sql`INSERT INTO crm_activities (contact_id, type, body, actor_email) VALUES (${c.id}, 'campanha', ${'Campanha: ' + camp.name}, ${user.email})`, null);
    }
    await audit({ actorEmail: user.email, action: "crm_campaign_sent", entity: "crm_campaign", entityId: camp.id, detail: { recipients: recipients.length, emailed } });
    return ok({ recipients, sentCount: recipients.length, emailed });
  }

  return fail("Rota de CRM nao encontrada: " + cseg.join("/"), 404);
}

// =====================================================================
//  SERVICE DESK — suporte integrado (chamados/tickets)
//  Abertos no app pelos assinantes/consultores e clientes; gerenciados
//  pelo dono na fila "Suporte" (SLA, status, respostas, dashboards).
// =====================================================================
const TICKET_STATUSES  = ["aberto", "em_andamento", "aguardando_cliente", "resolvido", "fechado"];
const TICKET_PRIORITIES = ["baixa", "normal", "alta", "urgente"];
// Categorias de "provavel problema" oferecidas ao abrir o chamado.
const TICKET_CATEGORIES = [
  { id: "acesso",       label: "Acesso / login / senha" },
  { id: "licenca",      label: "Licença / cobrança / upgrade" },
  { id: "clientes",     label: "Cadastro de clientes / cota" },
  { id: "documentos",   label: "Documentos / modelos / relatórios" },
  { id: "questionario", label: "Assistente de adequação / questionários" },
  { id: "incidentes",   label: "Incidentes / titulares" },
  { id: "treinamento",  label: "Treinamentos / cursos" },
  { id: "bug",          label: "Erro / comportamento inesperado" },
  { id: "duvida",       label: "Dúvida de uso" },
  { id: "sugestao",     label: "Sugestão / melhoria" },
  { id: "outro",        label: "Outro" },
];
// SLA de 1a resposta (horas) por prioridade.
const TICKET_SLA_HOURS = { urgente: 4, alta: 8, normal: 24, baixa: 48 };
const SUPPORT_INBOX = () => process.env.SUPPORT_EMAIL || process.env.OWNER_EMAIL || null;

function ticketCategoryLabel(id) {
  const c = TICKET_CATEGORIES.find(x => x.id === id);
  return c ? c.label : (id || "Outro");
}
// Anexo seguro: limita tamanho (~2,7MB base64 ~= 2MB binario) e normaliza campos.
function sanitizeAttachment(att) {
  if (!att || !att.data || !att.name) return null;
  const data = String(att.data);
  if (data.length > 2_700_000) throw httpError("Anexo muito grande (limite 2 MB).", 413);
  return { name: String(att.name).slice(0, 180), type: String(att.type || "application/octet-stream").slice(0, 120), data };
}
// Remove o base64 pesado da mensagem e expoe so a flag de existencia do anexo.
// Usado para devolver a conversa sem trafegar arquivos (download e sob demanda).
function stripMsgAttachment(m) {
  return { ...m, attachment_data: undefined, has_attachment: !!m.attachment_name };
}
function httpError(msg, status) { const e = new Error(msg); e.httpStatus = status; return e; }
// Escape para conteudo em HTML de e-mail (evita injecao no corpo da mensagem).
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function ownerSupportRoutes(req, user, sseg, method) {
  const head = sseg[0] || "";

  // ---- Indicadores do service desk (dashboard de suporte) ----
  if (head === "stats" && method === "GET") {
    const byStatus = await safe(sql`SELECT status, count(*)::int AS n FROM support_tickets GROUP BY status`, []);
    const byPriority = await safe(sql`SELECT priority, count(*)::int AS n FROM support_tickets GROUP BY priority`, []);
    const totals = await safe(one(sql`SELECT
      (SELECT count(*)::int FROM support_tickets) AS total,
      (SELECT count(*)::int FROM support_tickets WHERE status IN ('aberto','em_andamento','aguardando_cliente')) AS open,
      (SELECT count(*)::int FROM support_tickets WHERE status='aberto' AND first_response_at IS NULL) AS unanswered,
      (SELECT count(*)::int FROM support_tickets WHERE last_actor='cliente' AND status NOT IN ('resolvido','fechado')) AS needs_reply,
      (SELECT count(*)::int FROM support_tickets WHERE status='resolvido') AS resolved,
      (SELECT count(*)::int FROM support_tickets WHERE created_at > now() - interval '7 days') AS last7,
      (SELECT count(*)::int FROM support_tickets WHERE resolved_at IS NOT NULL AND resolved_at > now() - interval '7 days') AS resolved7`),
      { total: 0, open: 0, unanswered: 0, needs_reply: 0, resolved: 0, last7: 0, resolved7: 0 });
    // Tempo medio de 1a resposta (horas) nos chamados ja respondidos.
    const frt = await safe(one(sql`SELECT coalesce(avg(EXTRACT(EPOCH FROM (first_response_at - created_at))/3600.0),0)::numeric(10,1) AS hours
      FROM support_tickets WHERE first_response_at IS NOT NULL`), { hours: 0 });
    // SLA: chamados sem 1a resposta cujo prazo ja estourou.
    const breaching = await safe(sql`SELECT priority, count(*)::int AS n FROM support_tickets
      WHERE first_response_at IS NULL AND status IN ('aberto','em_andamento')
        AND created_at < now() - (CASE priority WHEN 'urgente' THEN interval '4 hours'
          WHEN 'alta' THEN interval '8 hours' WHEN 'baixa' THEN interval '48 hours'
          ELSE interval '24 hours' END)
      GROUP BY priority`, []);
    const sMap = {}; TICKET_STATUSES.forEach(s => sMap[s] = 0); (byStatus || []).forEach(r => { sMap[r.status] = r.n; });
    const pMap = {}; TICKET_PRIORITIES.forEach(p => pMap[p] = 0); (byPriority || []).forEach(r => { pMap[r.priority] = r.n; });
    const breachingTotal = (breaching || []).reduce((a, r) => a + r.n, 0);
    return ok({ byStatus: sMap, byPriority: pMap, totals, avgFirstResponseHours: Number(frt.hours) || 0,
      breaching: breachingTotal, statuses: TICKET_STATUSES, priorities: TICKET_PRIORITIES, slaHours: TICKET_SLA_HOURS });
  }

  // ---- FILA de chamados (ordem de abertura; filtros opcionais) ----
  if (head === "tickets" && !sseg[1] && method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const open = url.searchParams.get("open"); // "1" => somente em andamento
    const rows = await safe(
      status
        ? sql`SELECT t.*, (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id=t.id) AS msg_count
               FROM support_tickets t WHERE t.status=${status} ORDER BY t.created_at ASC LIMIT 500`
        : open === "1"
          ? sql`SELECT t.*, (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id=t.id) AS msg_count
                 FROM support_tickets t WHERE t.status IN ('aberto','em_andamento','aguardando_cliente') ORDER BY t.created_at ASC LIMIT 500`
          : sql`SELECT t.*, (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id=t.id) AS msg_count
                 FROM support_tickets t ORDER BY t.created_at ASC LIMIT 500`,
      []);
    // Nao devolve o base64 do anexo na listagem (peso); so a flag de existencia.
    const tickets = (rows || []).map(t => ({ ...t, attachment_data: undefined, has_attachment: !!t.attachment_name }));
    return ok({ tickets, slaHours: TICKET_SLA_HOURS, categories: TICKET_CATEGORIES });
  }

  // ---- DETALHE do chamado + conversa ----
  if (head === "tickets" && sseg[1] && !sseg[2] && method === "GET") {
    const t = await one(sql`SELECT * FROM support_tickets WHERE id=${sseg[1]}`);
    if (!t) return fail("Chamado nao encontrado.", 404);
    const messages = await sql`SELECT * FROM support_ticket_messages WHERE ticket_id=${t.id} ORDER BY created_at ASC LIMIT 500`;
    return ok({ ticket: { ...t, attachment_data: undefined, has_attachment: !!t.attachment_name }, messages: messages.map(stripMsgAttachment) });
  }

  // ---- DOWNLOAD do anexo do CHAMADO (base64) ----
  if (head === "tickets" && sseg[1] && sseg[2] === "attachment" && method === "GET") {
    const t = await one(sql`SELECT attachment_name, attachment_type, attachment_data FROM support_tickets WHERE id=${sseg[1]}`);
    if (!t || !t.attachment_data) return fail("Sem anexo.", 404);
    return ok({ name: t.attachment_name, type: t.attachment_type, data: t.attachment_data });
  }

  // ---- DOWNLOAD do anexo de uma MENSAGEM da conversa (base64) ----
  if (head === "tickets" && sseg[1] && sseg[2] === "messages" && sseg[3] && sseg[4] === "attachment" && method === "GET") {
    const mid = parseInt(sseg[3], 10);
    if (!Number.isFinite(mid)) return fail("Mensagem invalida.", 400);
    const m = await one(sql`SELECT attachment_name, attachment_type, attachment_data
      FROM support_ticket_messages WHERE id=${mid} AND ticket_id=${sseg[1]}`);
    if (!m || !m.attachment_data) return fail("Sem anexo.", 404);
    return ok({ name: m.attachment_name, type: m.attachment_type, data: m.attachment_data });
  }

  // ---- RESPONDER ao cliente (registra mensagem + anexo opcional + e-mail) ----
  if (head === "tickets" && sseg[1] && sseg[2] === "reply" && method === "POST") {
    const b = await readJson(req);
    if (!b.body || !String(b.body).trim()) return fail("Escreva a resposta.");
    const t = await one(sql`SELECT * FROM support_tickets WHERE id=${sseg[1]}`);
    if (!t) return fail("Chamado nao encontrado.", 404);
    const newStatus = TICKET_STATUSES.includes(b.status) ? b.status : "aguardando_cliente";
    const att = sanitizeAttachment(b.attachment);
    await sql`INSERT INTO support_ticket_messages
      (ticket_id, author_role, author_email, author_name, body, attachment_name, attachment_type, attachment_data)
      VALUES (${t.id}, 'suporte', ${user.email}, ${user.name || "Suporte"}, ${String(b.body).slice(0, 8000)},
        ${att?.name || null}, ${att?.type || null}, ${att?.data || null})`;
    await sql`UPDATE support_tickets SET status=${newStatus}, last_actor='suporte', updated_at=now(),
      first_response_at=coalesce(first_response_at, now()),
      resolved_at=${newStatus === "resolvido" || newStatus === "fechado" ? new Date().toISOString() : null}
      WHERE id=${t.id}`;
    await audit({ tenantId: t.tenant_id, actorEmail: user.email, action: "support_reply",
      entity: "support_ticket", entityId: t.id, detail: { status: newStatus, attachment: att?.name || null } });
    if (t.opener_email) {
      await safe(sendEmail({ tenantId: t.tenant_id, to: t.opener_email,
        subject: `[Chamado #${t.ticket_no}] Resposta do suporte — ${t.subject}`,
        type: "support",
        html: `<p>Olá ${escapeHtml(t.opener_name || "")},</p>
          <p>Há uma nova resposta no seu chamado <b>#${t.ticket_no}</b> (${escapeHtml(t.subject)}):</p>
          <blockquote style="border-left:3px solid #d4a017;padding-left:12px;color:#333">${escapeHtml(String(b.body)).replace(/\n/g, "<br>")}</blockquote>
          ${att ? `<p>📎 Anexo: ${escapeHtml(att.name)} (acesse a plataforma para baixar)</p>` : ""}
          <p>Acesse a plataforma, menu <b>Suporte</b>, para acompanhar e responder.</p>
          <p style="color:#888;font-size:12px">DPO PJ Protection — Suporte</p>` }), null);
    }
    return ok({ ok: true, status: newStatus });
  }

  // ---- ALTERAR STATUS / PRIORIDADE ----
  if (head === "tickets" && sseg[1] && sseg[2] === "status" && method === "POST") {
    const b = await readJson(req);
    const t = await one(sql`SELECT * FROM support_tickets WHERE id=${sseg[1]}`);
    if (!t) return fail("Chamado nao encontrado.", 404);
    const status = TICKET_STATUSES.includes(b.status) ? b.status : t.status;
    const priority = TICKET_PRIORITIES.includes(b.priority) ? b.priority : t.priority;
    const upd = await one(sql`UPDATE support_tickets SET status=${status}, priority=${priority}, updated_at=now(),
      resolved_at=${status === "resolvido" || status === "fechado" ? new Date().toISOString() : null}
      WHERE id=${t.id} RETURNING *`);
    await audit({ tenantId: t.tenant_id, actorEmail: user.email, action: "support_status_changed",
      entity: "support_ticket", entityId: t.id, detail: { status, priority } });
    return ok({ ticket: { ...upd, attachment_data: undefined, has_attachment: !!upd.attachment_name } });
  }

  return fail("Rota de suporte nao encontrada: " + sseg.join("/"), 404);
}

// Sub-rotas de suporte DENTRO do app (assinante/consultor e cliente abrem e
// acompanham os proprios chamados). tenant = ambiente do solicitante.
async function appSupportRoutes(req, user, tenant, sseg, method) {
  const head = sseg[0] || "";

  // Catalogo de categorias/prioridades para montar o formulario.
  if (head === "meta" && method === "GET") {
    return ok({ categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES });
  }

  // Lista dos chamados do proprio tenant.
  if (!head && method === "GET") {
    const rows = await safe(sql`SELECT id, ticket_no, category, subject, priority, status, last_actor,
        attachment_name, created_at, updated_at,
        (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id=support_tickets.id) AS msg_count
      FROM support_tickets WHERE tenant_id=${tenant.id} ORDER BY created_at DESC LIMIT 200`, []);
    return ok({ tickets: rows, categories: TICKET_CATEGORIES });
  }

  // Abrir um novo chamado.
  if (!head && method === "POST") {
    const b = await readJson(req);
    const subject = String(b.subject || "").trim();
    const description = String(b.description || "").trim();
    if (!subject) return fail("Informe um assunto para o chamado.");
    if (!description) return fail("Descreva o problema.");
    const category = TICKET_CATEGORIES.some(c => c.id === b.category) ? b.category : "outro";
    const priority = TICKET_PRIORITIES.includes(b.priority) ? b.priority : "normal";
    const openerName = String(b.name || user.name || "").slice(0, 160) || (user.email || "");
    const openerEmail = String(b.email || user.email || "").slice(0, 180) || null;
    const att = sanitizeAttachment(b.attachment);
    const t = await one(sql`INSERT INTO support_tickets
      (tenant_id, opener_email, opener_name, category, subject, description, priority, status,
       attachment_name, attachment_type, attachment_data, last_actor)
      VALUES (${tenant.id}, ${openerEmail}, ${openerName}, ${category}, ${subject}, ${description}, ${priority},
        'aberto', ${att?.name || null}, ${att?.type || null}, ${att?.data || null}, 'cliente') RETURNING *`);
    await sql`INSERT INTO support_ticket_messages (ticket_id, author_role, author_email, author_name, body)
      VALUES (${t.id}, 'cliente', ${openerEmail}, ${openerName}, ${description})`;
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "support_ticket_opened",
      entity: "support_ticket", entityId: t.id, detail: { ticketNo: t.ticket_no, category, priority } });
    // Notifica o suporte (dono). O envio do e-mail e BEST-EFFORT: usamos safe()
    // para que uma falha/lentidao do provedor (Resend) jamais derrube a abertura
    // do chamado — o protocolo ja foi gravado e deve ser sempre devolvido.
    const inbox = SUPPORT_INBOX();
    if (inbox) {
      await safe(sendEmail({ tenantId: tenant.id, to: inbox,
        subject: `[Chamado #${t.ticket_no}] ${ticketCategoryLabel(category)} — ${subject}`,
        type: "support",
        html: `<p><b>Novo chamado #${t.ticket_no}</b> (${escapeHtml(ticketCategoryLabel(category))}, prioridade ${escapeHtml(priority)})</p>
          <p><b>De:</b> ${escapeHtml(openerName)} &lt;${escapeHtml(openerEmail || "")}&gt;<br>
             <b>Ambiente:</b> ${escapeHtml(tenant.name || tenant.id)}</p>
          <p><b>Assunto:</b> ${escapeHtml(subject)}</p>
          <blockquote style="border-left:3px solid #d4a017;padding-left:12px;color:#333">${escapeHtml(description).replace(/\n/g, "<br>")}</blockquote>
          ${att ? `<p>📎 Anexo: ${escapeHtml(att.name)}</p>` : ""}
          <p>Abra o <b>Painel → Suporte</b> para responder.</p>` }), null);
    }
    return ok({ ticketNo: t.ticket_no, id: t.id, status: t.status });
  }

  // Download do anexo do CHAMADO (base64) — so do proprio tenant.
  if (head && sseg[1] === "attachment" && method === "GET") {
    const t = await one(sql`SELECT attachment_name, attachment_type, attachment_data
      FROM support_tickets WHERE id=${head} AND tenant_id=${tenant.id}`);
    if (!t || !t.attachment_data) return fail("Sem anexo.", 404);
    return ok({ name: t.attachment_name, type: t.attachment_type, data: t.attachment_data });
  }

  // Download do anexo de uma MENSAGEM da conversa (base64) — so do proprio tenant.
  if (head && sseg[1] === "messages" && sseg[2] && sseg[3] === "attachment" && method === "GET") {
    const mid = parseInt(sseg[2], 10);
    if (!Number.isFinite(mid)) return fail("Mensagem invalida.", 400);
    // Garante que a mensagem pertence a um chamado do proprio tenant (join de seguranca).
    const m = await one(sql`SELECT m.attachment_name, m.attachment_type, m.attachment_data
      FROM support_ticket_messages m JOIN support_tickets t ON t.id=m.ticket_id
      WHERE m.id=${mid} AND m.ticket_id=${head} AND t.tenant_id=${tenant.id}`);
    if (!m || !m.attachment_data) return fail("Sem anexo.", 404);
    return ok({ name: m.attachment_name, type: m.attachment_type, data: m.attachment_data });
  }

  // Detalhe + conversa de um chamado do proprio tenant.
  if (head && sseg[1] !== "reply" && method === "GET") {
    const t = await one(sql`SELECT * FROM support_tickets WHERE id=${head} AND tenant_id=${tenant.id}`);
    if (!t) return fail("Chamado nao encontrado.", 404);
    const messages = await sql`SELECT * FROM support_ticket_messages WHERE ticket_id=${t.id} ORDER BY created_at ASC LIMIT 500`;
    return ok({ ticket: { ...t, attachment_data: undefined, has_attachment: !!t.attachment_name }, messages: messages.map(stripMsgAttachment) });
  }

  // Cliente responde no proprio chamado (com anexo opcional).
  if (head && sseg[1] === "reply" && method === "POST") {
    const b = await readJson(req);
    if (!b.body || !String(b.body).trim()) return fail("Escreva sua mensagem.");
    const t = await one(sql`SELECT * FROM support_tickets WHERE id=${head} AND tenant_id=${tenant.id}`);
    if (!t) return fail("Chamado nao encontrado.", 404);
    const att = sanitizeAttachment(b.attachment);
    await sql`INSERT INTO support_ticket_messages
      (ticket_id, author_role, author_email, author_name, body, attachment_name, attachment_type, attachment_data)
      VALUES (${t.id}, 'cliente', ${t.opener_email}, ${t.opener_name}, ${String(b.body).slice(0, 8000)},
        ${att?.name || null}, ${att?.type || null}, ${att?.data || null})`;
    const newStatus = t.status === "resolvido" || t.status === "fechado" ? "aberto" : t.status;
    await sql`UPDATE support_tickets SET last_actor='cliente', status=${newStatus}, resolved_at=NULL, updated_at=now() WHERE id=${t.id}`;
    await audit({ tenantId: tenant.id, actorEmail: user.email, action: "support_client_reply",
      entity: "support_ticket", entityId: t.id, detail: { attachment: att?.name || null } });
    const inbox = SUPPORT_INBOX();
    if (inbox) {
      await safe(sendEmail({ tenantId: tenant.id, to: inbox,
        subject: `[Chamado #${t.ticket_no}] Resposta do cliente — ${t.subject}`,
        type: "support",
        html: `<p>O cliente respondeu no chamado <b>#${t.ticket_no}</b>:</p>
          <blockquote style="border-left:3px solid #d4a017;padding-left:12px;color:#333">${escapeHtml(String(b.body)).replace(/\n/g, "<br>")}</blockquote>
          ${att ? `<p>📎 Anexo: ${escapeHtml(att.name)} (abra o Painel → Suporte para baixar)</p>` : ""}` }), null);
    }
    return ok({ ok: true });
  }

  return fail("Rota de suporte do app nao encontrada: " + sseg.join("/"), 404);
}

async function ownerDashboard() {
  // Cada bloco e tolerante a falha de schema (banco parcialmente migrado):
  // uma tabela/coluna ausente degrada APENAS aquele indicador, sem derrubar
  // o painel inteiro. Esta area de gestao nunca pode ficar inacessivel.
  const totals = await safe(one(sql`SELECT
    (SELECT count(*)::int FROM tenants WHERE is_owner=FALSE) AS tenants,
    (SELECT count(*)::int FROM tenants WHERE status='active' AND is_owner=FALSE) AS active,
    (SELECT count(*)::int FROM tenants WHERE status IN ('suspended','blocked')) AS blocked,
    (SELECT count(*)::int FROM licenses WHERE status='active') AS active_licenses,
    (SELECT count(*)::int FROM licenses WHERE status='issued') AS pending_activation,
    (SELECT count(*)::int FROM clients c JOIN tenants t ON t.id=c.tenant_id WHERE t.is_owner=FALSE) AS clients_managed,
    (SELECT count(*)::int FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
       WHERE t.is_owner=FALSE AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id=t.id)) AS pending_purchases`),
    { tenants: 0, active: 0, blocked: 0, active_licenses: 0, pending_activation: 0, clients_managed: 0, pending_purchases: 0 });
  const mrr = await safe(one(sql`SELECT coalesce(sum(amount_cents),0)::int AS cents FROM subscriptions WHERE status='active'`), { cents: 0 });
  const overdue = await safe(sql`
    SELECT t.id, t.name, t.email, t.phone, t.status, s.current_period_end, s.billing_type, p.name AS plan_name
    FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN plans p ON p.id=s.plan_id
    WHERE t.is_owner=FALSE AND s.current_period_end IS NOT NULL
      AND s.current_period_end < now() + interval '7 days'
    ORDER BY s.current_period_end ASC LIMIT 50`, []);
  // Distribuicao por modulo + receita ativa por modulo (area negocial).
  const byPlan = await safe(sql`SELECT t.plan_id, p.name, p.tier, count(*)::int AS n,
      coalesce(sum(CASE WHEN sub.status='active' THEN sub.amount_cents ELSE 0 END),0)::int AS revenue
    FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
    LEFT JOIN LATERAL (SELECT amount_cents, status FROM subscriptions s WHERE s.tenant_id=t.id ORDER BY created_at DESC LIMIT 1) sub ON TRUE
    WHERE t.is_owner=FALSE GROUP BY t.plan_id, p.name, p.tier ORDER BY p.tier`, []);
  // Status das licencas (para grafico de rosca/barras em CSS).
  const licStatus = await safe(sql`SELECT status, count(*)::int AS n FROM licenses GROUP BY status`, []);
  // Funil do CRM (resumo).
  const crmFunnel = await safe(sql`SELECT stage, count(*)::int AS n, coalesce(sum(value_cents),0)::int AS value FROM crm_contacts GROUP BY stage`, []);
  // Receita aprovada nos ultimos 6 meses (serie para mini-grafico de barras).
  const revenue = await safe(sql`
    SELECT to_char(date_trunc('month', coalesce(paid_at, created_at)), 'YYYY-MM') AS ym,
           coalesce(sum(amount_cents),0)::int AS cents
    FROM payments WHERE status='approved' AND coalesce(paid_at, created_at) > now() - interval '6 months'
    GROUP BY 1 ORDER BY 1`, []);
  // Atividade recente (trilha de auditoria resumida).
  const recent = await safe(sql`SELECT created_at, action, actor_email, tenant_id FROM audit_log ORDER BY created_at DESC LIMIT 8`, []);
  // Status detalhado da NFS-e (considera banco + env: o que ainda falta configurar).
  const nfseStatus = await safe(nfse.status(), { enabled: false, auto: false, missing: ["token", "cnpj", "im", "municipio"] });
  const missLabel = { token: "Token Focus NFe", cnpj: "CNPJ do emitente", im: "Inscricao Municipal", municipio: "Codigo do Municipio (IBGE)" };
  const nfseMissing = (nfseStatus.missing || []).map((k) => missLabel[k] || k);
  return ok({
    totals, mrrCents: mrr.cents, overdue, byPlan,
    licStatus, crmFunnel, revenue, recent,
    nfseEnabled: nfseStatus.enabled, nfseAuto: nfseStatus.auto, nfseMissing, nfseStatus,
    gateways: billing.availableGateways(),
  });
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

  // ---- SUPORTE (service desk): abrir/listar/responder os proprios chamados ----
  if (head === "support") return appSupportRoutes(req, user, tenant, seg.slice(1), method);

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

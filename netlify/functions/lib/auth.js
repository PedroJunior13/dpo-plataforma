// Autenticacao: senha (scrypt nativo) + JWT (jose, HS256).
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h

function secretKey() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET nao configurado.");
  return new TextEncoder().encode(s);
}

// ---------- Senhas (scrypt) ----------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split("$");
    if (algo !== "scrypt") return false;
    const dk = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const a = Buffer.from(hashHex, "hex");
    return a.length === dk.length && timingSafeEqual(a, dk);
  } catch { return false; }
}

// ---------- Tokens ----------
export async function makeToken(user) {
  return await new SignJWT({
    email: user.email,
    name: user.name,
    role: user.role,
    tenant_id: user.tenant_id,
    is_owner: user.role === "OWNER",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (payload.purpose === "mfa") return null; // token de desafio não vale como sessão
    payload.id = payload.sub;
    return payload;
  } catch { return null; }
}

// ---------- Desafio MFA (token curto entre senha e código) ----------
export async function makeMfaChallenge(user) {
  return await new SignJWT({ purpose: "mfa", email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretKey());
}

export async function verifyMfaChallenge(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (payload.purpose !== "mfa") return null;
    return { id: payload.sub, email: payload.email };
  } catch { return null; }
}

// ---------- Suporte / impersonacao (dono acessa ambiente de um cliente) ----------
// Token curto que carrega o tenant alvo. O dono continua sendo o ator real
// (owner_email), mas opera "como" o tenant do cliente para dar suporte.
const SUPPORT_TTL_SECONDS = 60 * 30; // 30 min
export async function makeSupportToken(owner, tenantId) {
  return await new SignJWT({
    email: owner.email,
    name: owner.name,
    role: "OWNER",
    is_owner: true,
    tenant_id: tenantId,        // passa a operar no tenant do cliente
    support: true,              // marca de sessao de suporte
    act_as_tenant: tenantId,
    owner_email: owner.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(owner.id))
    .setIssuedAt()
    .setExpirationTime(`${SUPPORT_TTL_SECONDS}s`)
    .sign(secretKey());
}

// ---------- Seguranca: bloqueio por tentativas (anti brute-force) ----------
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
// Verdadeiro se a conta esta temporariamente travada.
export function isLocked(user) {
  if (!user || !user.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}
// Minutos restantes de bloqueio (arredonda para cima).
export function lockMinutesLeft(user) {
  if (!isLocked(user)) return 0;
  return Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
}

// Extrai e valida o usuario do header Authorization: Bearer xxx
export async function userFromRequest(req) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  return await verifyToken(h.slice(7));
}

// ---------- Permissoes ----------
export const ROLE_RANK = { COLABORADOR: 1, AUDITOR: 2, DPO: 3, ADMIN: 4, OWNER: 5 };
export function atLeast(user, role) {
  return user && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[role] || 99);
}
export function isOwner(user) { return user && user.role === "OWNER"; }

// ---------- Geradores ----------
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
export function genLicenseKey() {
  const block = () => Array.from({ length: 4 }, () =>
    KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)]).join("");
  return `DPO-${block()}-${block()}-${block()}`;
}
export function genActivationToken() { return randomBytes(24).toString("base64url"); }
export const uuid = randomUUID;

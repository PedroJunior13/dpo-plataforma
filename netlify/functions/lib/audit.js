// Trilhas de auditoria: geral (audit_log) e de licencas (license_events, imutavel).
import { sql } from "./db.js";

// Contexto de origem do request atual (definido 1x por invocacao no handler).
// Permite que TODAS as chamadas audit() herdem ip/user-agent/geo sem editar cada call site.
let _originCtx = { ip: null, userAgent: null, geo: null };
export function setAuditContext(ctx) { _originCtx = ctx || { ip: null, userAgent: null, geo: null }; }

export async function audit({ tenantId = null, actorEmail = null, action, entity = null, entityId = null, detail = null, ip = null, userAgent = null, geo = null }) {
  // Herda do contexto do request quando o call site nao informou explicitamente.
  ip = ip || _originCtx.ip || null;
  userAgent = userAgent || _originCtx.userAgent || null;
  geo = geo || _originCtx.geo || null;
  const geoLabel = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || null : null;
  try {
    // Tentativa rica (colunas user_agent/geo/geo_label). Se a migracao ainda nao
    // adicionou as colunas, cai no INSERT classico — a trilha nunca quebra a operacao.
    await sql`INSERT INTO audit_log (tenant_id, actor_email, action, entity, entity_id, detail, ip, user_agent, geo, geo_label)
              VALUES (${tenantId}, ${actorEmail}, ${action}, ${entity}, ${entityId ? String(entityId) : null},
                      ${detail ? JSON.stringify(detail) : null}, ${ip},
                      ${userAgent ? String(userAgent).slice(0, 256) : null},
                      ${geo ? JSON.stringify(geo) : null}, ${geoLabel})`;
  } catch (e) {
    try {
      await sql`INSERT INTO audit_log (tenant_id, actor_email, action, entity, entity_id, detail, ip)
                VALUES (${tenantId}, ${actorEmail}, ${action}, ${entity}, ${entityId ? String(entityId) : null},
                        ${detail ? JSON.stringify(detail) : null}, ${ip})`;
    } catch (e2) { console.error("[audit]", e2.message); }
  }
}

// Helper que extrai ip + user-agent + geo de um Request e devolve campos prontos
// para o audit(). Centraliza a captura de origem para a trilha de auditoria.
export function auditOrigin(req) {
  try {
    const h = req.headers;
    const ip = (h.get("x-nf-client-connection-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim() || "").slice(0, 64) || null;
    const userAgent = (h.get("user-agent") || "").slice(0, 256) || null;
    let geo = null;
    const raw = h.get("x-nf-geo");
    if (raw) {
      const j = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
      geo = {
        city: j.city || null,
        region: j.subdivision?.name || j.subdivision?.code || null,
        country: j.country?.code || j.country?.name || null,
        lat: j.latitude ?? null, lon: j.longitude ?? null, tz: j.timezone || null,
      };
    } else {
      const country = h.get("x-country") || null;
      if (country) geo = { country, city: null, region: null };
    }
    return { ip, userAgent, geo };
  } catch { return { ip: null, userAgent: null, geo: null }; }
}

export async function licenseEvent({ licenseId, tenantId, event, actorUserId = null, actorEmail = null, before = null, after = null, note = null }) {
  await sql`INSERT INTO license_events (license_id, tenant_id, event, actor_user_id, actor_email, before, after, note)
            VALUES (${licenseId}, ${tenantId}, ${event}, ${actorUserId}, ${actorEmail},
                    ${before ? JSON.stringify(before) : null}, ${after ? JSON.stringify(after) : null}, ${note})`;
}

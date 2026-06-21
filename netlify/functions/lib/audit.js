// Trilhas de auditoria: geral (audit_log) e de licencas (license_events, imutavel).
import { sql } from "./db.js";

export async function audit({ tenantId = null, actorEmail = null, action, entity = null, entityId = null, detail = null, ip = null }) {
  try {
    await sql`INSERT INTO audit_log (tenant_id, actor_email, action, entity, entity_id, detail, ip)
              VALUES (${tenantId}, ${actorEmail}, ${action}, ${entity}, ${entityId ? String(entityId) : null},
                      ${detail ? JSON.stringify(detail) : null}, ${ip})`;
  } catch (e) { console.error("[audit]", e.message); }
}

export async function licenseEvent({ licenseId, tenantId, event, actorUserId = null, actorEmail = null, before = null, after = null, note = null }) {
  await sql`INSERT INTO license_events (license_id, tenant_id, event, actor_user_id, actor_email, before, after, note)
            VALUES (${licenseId}, ${tenantId}, ${event}, ${actorUserId}, ${actorEmail},
                    ${before ? JSON.stringify(before) : null}, ${after ? JSON.stringify(after) : null}, ${note})`;
}

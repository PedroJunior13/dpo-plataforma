// Configuracoes da plataforma (key/value) com PRECEDENCIA sobre variaveis de
// ambiente. O Dono edita pela aba "Integracoes" do painel; se a chave nao
// existir no banco, caimos no env (compatibilidade com a configuracao antiga).
import { sql } from "./db.js";

// Cache curto em memoria (por instancia de funcao) para evitar ida ao banco a
// cada emissao. Invalida em writes via bumpCache().
let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30_000;

export async function allSettings(force = false) {
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < TTL_MS) return _cache;
  const map = {};
  try {
    const rows = await sql`SELECT key, value FROM platform_settings`;
    for (const r of rows) map[r.key] = r.value;
  } catch (e) {
    // Se a tabela ainda nao existir (migracao pendente), seguimos so com env.
    console.warn("[settings] leitura falhou (usando env):", e?.message || e);
  }
  _cache = map; _cacheAt = now;
  return map;
}

// Le uma chave: banco tem precedencia; senao a env informada; senao o default.
export async function getSetting(key, envName, def = undefined) {
  const map = await allSettings();
  if (map[key] != null && map[key] !== "") return map[key];
  if (envName && process.env[envName] != null && process.env[envName] !== "") return process.env[envName];
  return def;
}

// Grava (upsert) varias chaves de uma vez. Valores vazios/null REMOVEM a chave
// (volta a valer a env). Retorna o mapa atualizado.
export async function setSettings(obj, updatedBy = null) {
  for (const [key, value] of Object.entries(obj || {})) {
    const v = (value == null || value === "") ? null : String(value);
    if (v == null) {
      await sql`DELETE FROM platform_settings WHERE key=${key}`;
    } else {
      await sql`INSERT INTO platform_settings (key, value, updated_by, updated_at)
                VALUES (${key}, ${v}, ${updatedBy}, now())
                ON CONFLICT (key) DO UPDATE
                  SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`;
    }
  }
  _cache = null; _cacheAt = 0; // invalida cache
  return allSettings(true);
}

export function bumpCache() { _cache = null; _cacheAt = 0; }

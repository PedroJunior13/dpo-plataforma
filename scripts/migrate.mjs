// Aplica db/schema.sql no Postgres (Neon). Uso: `npm run migrate`
// Requer DATABASE_URL no ambiente (ou .env carregado pelo shell).
//
//   DATABASE_URL="postgres://..." npm run migrate
//
// O schema usa "CREATE TABLE IF NOT EXISTS" e seeds idempotentes (ON CONFLICT),
// portanto pode ser executado novamente com segurança.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(__dirname, "..", "db", "schema.sql");

const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!url) {
  console.error("✗ Defina DATABASE_URL (string de conexao do Neon).");
  process.exit(1);
}

const sql = neon(url);
const ddl = readFileSync(SCHEMA, "utf8");

// Divide em statements respeitando blocos de funcao ($$ ... $$).
function splitStatements(text) {
  const out = [];
  let buf = "", inDollar = false;
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--") && !inDollar) continue; // comentario de linha
    const dollarHits = (line.match(/\$\$/g) || []).length;
    if (dollarHits % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && trimmed.endsWith(";")) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/;/g, "").trim().length);
}

const statements = splitStatements(ddl);
console.log(`→ Aplicando ${statements.length} statements em ${SCHEMA}…`);

// O schema e 100% idempotente (CREATE/ALTER ... IF NOT EXISTS, seeds com
// ON CONFLICT). Por isso NAO abortamos no primeiro erro: aplicamos TODOS os
// statements e so depois relatamos as falhas. Assim, se um statement antigo
// falhar, as tabelas seguintes (ex.: CRM) ainda sao criadas — evitando que o
// painel/CRM quebrem por banco parcialmente migrado.
let okCount = 0;
const failures = [];
for (const [i, stmt] of statements.entries()) {
  try {
    await sql.query(stmt);
    okCount++;
  } catch (e) {
    failures.push({ n: i + 1, stmt: stmt.slice(0, 160), msg: e.message });
    console.error(`✗ Falha no statement #${i + 1}:\n${stmt.slice(0, 160)}…\n  ${e.message}`);
  }
}

console.log(`✓ Migração: ${okCount}/${statements.length} statements aplicados.`);
if (failures.length) {
  console.error(`⚠ ${failures.length} statement(s) falharam (acima). Como o schema e idempotente, os demais foram aplicados; rode a migração de novo apos corrigir.`);
}
console.log("Próximo passo: defina a senha do dono via /api/auth/bootstrap-owner (veja DEPLOY.md).");
// Sai com erro apenas se NADA foi aplicado (banco inacessivel) — assim o build
// da Netlify (npm run migrate || echo ...) continua mesmo com falha parcial.
process.exit(okCount === 0 ? 1 : 0);

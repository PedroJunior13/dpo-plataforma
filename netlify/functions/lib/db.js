// Camada de banco — Neon Postgres (driver HTTP serverless).
// Uso: import { sql } from "./db.js";  const rows = await sql`SELECT 1`;
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  // Nao derruba o modulo no carregamento; erra so quando for usado.
  console.warn("[db] DATABASE_URL nao definido.");
}

export const sql = neon(process.env.DATABASE_URL || "postgres://invalid");

// Helper: primeira linha ou null.
export async function one(promise) {
  const rows = await promise;
  return rows && rows.length ? rows[0] : null;
}

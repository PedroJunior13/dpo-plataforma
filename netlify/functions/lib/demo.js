// Ambiente de DEMONSTRACAO — acesso temporario (7 dias) com dados de exemplo.
// Regras: cada geracao apaga o tenant demo anterior (e todos os dados, via
// cascade) e cria um novo, com clientes/documentos/incidentes/projetos/tarefas
// prontos para o visitante percorrer todo o processo operacional.
import { sql, one } from "./db.js";
import { genActivationToken, hashPassword } from "./auth.js";

const DEMO_DAYS = parseInt(process.env.DEMO_DAYS || "7", 10);
const DEMO_PLAN = "adv"; // modulo mais completo do assinante (tudo destravado)
const APP_BASE_URL = (process.env.APP_BASE_URL || "https://app.dpopjprotection.com.br").replace(/\/+$/, "");

export function demoLink(tenant) {
  return `${APP_BASE_URL}/demo?d=${tenant.demo_token}`;
}

// Remove TODOS os tenants de demonstracao (e seus dados) de forma segura.
async function purgeDemos() {
  const demos = await sql`SELECT id FROM tenants WHERE is_demo = TRUE`;
  for (const d of demos) {
    // audit_log nao tem FK para tenants — limpamos manualmente (cascade nao alcanca).
    await sql`DELETE FROM audit_log WHERE tenant_id = ${d.id}`;
    // O restante (users, clients, documents, projects, tasks, etc.) cai por
    // ON DELETE CASCADE ao remover o tenant.
    await sql`DELETE FROM tenants WHERE id = ${d.id}`;
  }
  return demos.length;
}

// Cria um ambiente de demonstracao novo e popula com dados de exemplo.
export async function resetDemo({ actor } = {}) {
  await purgeDemos();

  const token = genActivationToken();
  const expires = new Date(Date.now() + DEMO_DAYS * 864e5).toISOString();

  const tenant = await one(sql`
    INSERT INTO tenants (name, email, plan_id, status, is_demo, demo_token, demo_expires_at)
    VALUES ('Demonstracao — Consultoria Exemplo', 'demo@dpopjprotection.com.br',
            ${DEMO_PLAN}, 'active', TRUE, ${token}, ${expires})
    RETURNING *`);

  // Usuario da demo: login somente pelo link (sem senha utilizavel).
  const demoEmail = `demo+${tenant.id.slice(0, 8)}@dpopjprotection.com.br`;
  const user = await one(sql`
    INSERT INTO users (tenant_id, email, password_hash, name, role, active)
    VALUES (${tenant.id}, ${demoEmail}, ${hashPassword(genActivationToken())},
            'Visitante (Demonstracao)', 'ADMIN', TRUE)
    RETURNING *`);

  await seedExampleData(tenant.id, user.id);

  return { tenant, user, token, expiresAt: expires, link: demoLink(tenant) };
}

// Status atual da demo (para o painel) — null se nao houver ou estiver expirada.
export async function demoStatus() {
  const t = await one(sql`SELECT * FROM tenants WHERE is_demo = TRUE ORDER BY created_at DESC LIMIT 1`);
  if (!t) return null;
  const expired = t.demo_expires_at && new Date(t.demo_expires_at).getTime() < Date.now();
  const counts = await one(sql`SELECT
    (SELECT count(*)::int FROM clients   WHERE tenant_id=${t.id}) AS clients,
    (SELECT count(*)::int FROM documents WHERE tenant_id=${t.id}) AS documents,
    (SELECT count(*)::int FROM incidents WHERE tenant_id=${t.id}) AS incidents`);
  return { link: demoLink(t), expiresAt: t.demo_expires_at, expired: !!expired, counts };
}

// Resolve o usuario da demo a partir do token do link (valida expiracao).
export async function userFromDemoToken(token) {
  if (!token) return { error: "Link invalido." };
  const t = await one(sql`SELECT * FROM tenants WHERE demo_token=${token} AND is_demo=TRUE`);
  if (!t) return { error: "Link de demonstracao invalido." };
  if (t.demo_expires_at && new Date(t.demo_expires_at).getTime() < Date.now())
    return { error: "Esta demonstracao expirou. Solicite um novo link." };
  const u = await one(sql`SELECT * FROM users WHERE tenant_id=${t.id} ORDER BY created_at ASC LIMIT 1`);
  if (!u) return { error: "Demonstracao indisponivel." };
  return { user: u, tenant: t };
}

// ---------------------------------------------------------------
//  Dados de exemplo (clientes + documentos + titulares + incidentes
//  + projetos + tarefas) para experimentar o processo completo.
// ---------------------------------------------------------------
async function seedExampleData(tenantId, userId) {
  const clientes = [
    { name: "Clinica Vida Saudavel LTDA", cnpj: "12.345.678/0001-90", sector: "Saude",
      contact_name: "Dra. Marina Alves", contact_email: "marina@clinicavida.com.br", phase: "implementacao" },
    { name: "EduMais Cursos Online",     cnpj: "98.765.432/0001-10", sector: "Educacao",
      contact_name: "Rafael Souza",      contact_email: "rafael@edumais.com.br",    phase: "diagnostico" },
    { name: "TechParts Comercio Ltda",   cnpj: "45.678.912/0001-33", sector: "Varejo/E-commerce",
      contact_name: "Juliana Pereira",   contact_email: "juliana@techparts.com.br", phase: "monitoramento" },
  ];

  for (const c of clientes) {
    const cli = await one(sql`
      INSERT INTO clients (tenant_id, name, cnpj, sector, contact_name, contact_email, phase, status)
      VALUES (${tenantId}, ${c.name}, ${c.cnpj}, ${c.sector}, ${c.contact_name}, ${c.contact_email}, ${c.phase}, 'ativo')
      RETURNING *`);

    // Documentos versionados
    const docs = [
      { type: "politica_privacidade", title: "Politica de Privacidade",
        content: "Versao inicial da Politica de Privacidade conforme art. 9 da LGPD." },
      { type: "ropa", title: "Registro das Operacoes de Tratamento (ROPA)",
        content: "Mapeamento das atividades de tratamento de dados pessoais." },
    ];
    for (const d of docs) {
      const doc = await one(sql`
        INSERT INTO documents (tenant_id, client_id, doc_type, title)
        VALUES (${tenantId}, ${cli.id}, ${d.type}, ${d.title}) RETURNING *`);
      await sql`INSERT INTO document_versions (tenant_id, document_id, version, content, created_by)
                VALUES (${tenantId}, ${doc.id}, 1, ${d.content}, ${userId})`;
    }

    // Solicitacao de titular
    await sql`INSERT INTO titular_requests (tenant_id, client_id, kind, requester, status)
              VALUES (${tenantId}, ${cli.id}, 'acesso', 'titular@exemplo.com', 'aberto')`;

    // Incidente
    await sql`INSERT INTO incidents (tenant_id, client_id, title, severity, status)
              VALUES (${tenantId}, ${cli.id}, 'Acesso indevido a planilha de contatos', 'media', 'aberto')`;

    // Projeto + tarefas (recurso do modulo Avancado, destravado na demo)
    const proj = await one(sql`
      INSERT INTO projects (tenant_id, client_id, name, phase, due_date)
      VALUES (${tenantId}, ${cli.id}, ${"Adequacao LGPD — " + c.name}, ${c.phase},
              ${new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)})
      RETURNING *`);
    const tarefas = [
      { title: "Mapear bases legais de tratamento", status: "done" },
      { title: "Elaborar Politica de Privacidade",  status: "doing" },
      { title: "Treinamento da equipe (art. 50 LGPD)", status: "todo" },
    ];
    for (const tk of tarefas) {
      await sql`INSERT INTO tasks (tenant_id, project_id, title, status)
                VALUES (${tenantId}, ${proj.id}, ${tk.title}, ${tk.status})`;
    }
  }
}

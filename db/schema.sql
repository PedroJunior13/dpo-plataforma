-- =====================================================================
--  DPO PJ Protection — PJ Technology Solutions
--  Esquema PostgreSQL (Neon / Netlify DB)
--  Camada SaaS (multi-tenant, licenciamento, cobranca, auditoria)
--  + tabelas operacionais LGPD (multi-tenant).
--  Idempotente: pode rodar varias vezes (IF NOT EXISTS / ON CONFLICT).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- =====================================================================
--  1) PLANOS / MODULOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS plans (
  id                     TEXT PRIMARY KEY,            -- basic | inter | adv | owner
  name                   TEXT NOT NULL,
  tier                   INT  NOT NULL DEFAULT 0,     -- ordem p/ upgrade/downgrade
  client_quota           INT,                         -- NULL = ilimitado
  price_month_cents      INT  NOT NULL DEFAULT 0,     -- mensal avulso (centavos)
  price_recurring_cents  INT  NOT NULL DEFAULT 0,     -- recorrente (5% off)
  features               JSONB NOT NULL DEFAULT '[]',
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  2) TENANTS (assinantes: consultores/empresas). O dono tambem e um tenant.
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  doc           TEXT,                                  -- CNPJ/CPF
  email         TEXT,                                  -- contato/cobranca
  phone         TEXT,
  plan_id       TEXT REFERENCES plans(id),
  status        TEXT NOT NULL DEFAULT 'pending',       -- pending|active|grace|suspended|blocked|canceled
  is_owner      BOOLEAN NOT NULL DEFAULT FALSE,        -- TRUE = ambiente do dono (cota ilimitada)
  client_quota_override INT,                           -- sobrepoe a cota do plano (NULL = usa plano)
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
-- Ambiente de DEMONSTRACAO: acesso temporario (7 dias) com dados de exemplo.
-- Ao gerar um novo link, o tenant demo anterior e apagado (cascade) e recriado.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_demo         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_token      TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tenants_demo ON tenants(is_demo) WHERE is_demo;

-- =====================================================================
--  3) USUARIOS (login). Pertencem a um tenant. OWNER = super-admin global.
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,                                  -- NULL ate definir senha
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'ADMIN',         -- OWNER|ADMIN|DPO|AUDITOR|COLABORADOR
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
-- MFA (TOTP / autenticador). mfa_secret guardado em base32; so vale quando mfa_enabled.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- =====================================================================
--  4) ASSINATURAS (cobranca por tenant)
-- =====================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL REFERENCES plans(id),
  billing_type           TEXT NOT NULL DEFAULT 'monthly',  -- monthly (avulso) | recurring
  gateway                TEXT NOT NULL DEFAULT 'manual',   -- mercadopago|stripe|pagarme|manual
  gateway_subscription_id TEXT,
  amount_cents           INT NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'pending',  -- pending|active|past_due|canceled
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,                      -- pago-ate
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subs_period_end ON subscriptions(current_period_end);

-- =====================================================================
--  5) LICENCAS (uma por compra; chave de ativacao; vinculo ao modulo)
-- =====================================================================
CREATE TABLE IF NOT EXISTS licenses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL REFERENCES plans(id),
  subscription_id    UUID REFERENCES subscriptions(id),
  license_key        TEXT UNIQUE NOT NULL,                 -- DPO-XXXX-XXXX-XXXX
  activation_token   TEXT NOT NULL,                        -- segredo no link de ativacao
  status             TEXT NOT NULL DEFAULT 'issued',       -- issued|active|suspended|revoked|expired
  client_quota       INT,                                  -- snapshot (NULL = ilimitado)
  valid_until        TIMESTAMPTZ,                          -- avulso: data limite; recorrente: segue assinatura
  activated_at       TIMESTAMPTZ,
  activated_by_user_id UUID REFERENCES users(id),
  activation_ip      TEXT,
  version            INT NOT NULL DEFAULT 1,               -- incrementa a cada alteracao (versionamento)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lic_tenant ON licenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lic_status ON licenses(status);

-- =====================================================================
--  6) AUDITORIA DE LICENCAS (append-only, imutavel, versionado)
-- =====================================================================
CREATE TABLE IF NOT EXISTS license_events (
  id            BIGSERIAL PRIMARY KEY,
  license_id    UUID REFERENCES licenses(id) ON DELETE SET NULL,
  tenant_id     UUID,
  event         TEXT NOT NULL,   -- issued|sent|activated|renewed|upgraded|downgraded|suspended|reactivated|revoked|expired|quota_changed
  actor_user_id UUID,
  actor_email   TEXT,
  before        JSONB,
  after         JSONB,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_licev_license ON license_events(license_id);
CREATE INDEX IF NOT EXISTS idx_licev_tenant ON license_events(tenant_id);
-- Bloqueia UPDATE/DELETE (trilha imutavel)
CREATE OR REPLACE FUNCTION trg_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registro de auditoria e imutavel (somente insercao).';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS no_update_license_events ON license_events;
CREATE TRIGGER no_update_license_events BEFORE UPDATE OR DELETE ON license_events
  FOR EACH ROW EXECUTE FUNCTION trg_block_mutation();

-- =====================================================================
--  7) PAGAMENTOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES subscriptions(id),
  gateway           TEXT NOT NULL,
  gateway_payment_id TEXT,
  method            TEXT,                                  -- pix|boleto|credit_card|debit_card
  amount_cents      INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',       -- pending|approved|rejected|refunded|chargeback
  due_date          TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);

-- =====================================================================
--  8) NOTAS FISCAIS (NFS-e)
-- =====================================================================
CREATE TABLE IF NOT EXISTS invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id    UUID REFERENCES payments(id),
  provider      TEXT NOT NULL DEFAULT 'focusnfe',
  provider_ref  TEXT,                                      -- referencia/ref enviada ao provedor
  status        TEXT NOT NULL DEFAULT 'pending',           -- pending|processing|issued|error|canceled
  number        TEXT,
  pdf_url       TEXT,
  xml_url       TEXT,
  amount_cents  INT NOT NULL DEFAULT 0,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_tenant ON invoices(tenant_id);

-- =====================================================================
--  9) NOTIFICACOES (avisos de vencimento/atraso)
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,           -- expiring|overdue|blocked|activated|payment_approved|license_sent
  channel     TEXT NOT NULL DEFAULT 'email',  -- email|whatsapp
  destination TEXT,
  subject     TEXT,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued|sent|error
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_tenant ON notifications(tenant_id);

-- =====================================================================
-- 10) AUDITORIA GERAL (acoes administrativas)
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID,
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id);

-- =====================================================================
-- 11) OPERACIONAL LGPD (multi-tenant) — clientes/empresas geridos
-- =====================================================================
CREATE TABLE IF NOT EXISTS clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  cnpj         TEXT,
  slug         TEXT,                          -- pagina publica do titular
  sector       TEXT,
  contact_name TEXT,
  contact_email TEXT,
  phase        TEXT DEFAULT 'diagnostico',
  status       TEXT DEFAULT 'ativo',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phase       TEXT DEFAULT 'diagnostico',
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT DEFAULT 'todo',
  assignee_id UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS titular_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  kind        TEXT,
  requester   TEXT,
  status      TEXT DEFAULT 'aberto',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT,
  severity    TEXT DEFAULT 'media',
  status      TEXT DEFAULT 'aberto',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INT NOT NULL DEFAULT 1,
  content     TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  SEEDS
-- =====================================================================
-- Planos (preco recorrente = mensal * 0.95, conforme regra de 5% off)
INSERT INTO plans (id, name, tier, client_quota, price_month_cents, price_recurring_cents, features) VALUES
 ('basic', 'Basico',         1, 25,  35000, 33250,
   '["Gestao de ate 25 clientes","Solicitacoes de titulares (art. 18 LGPD)","Registro e tratativa de incidentes","Documentos versionados (LGPD/GDPR)","Selo de compliance & paginas publicas","Bilingue PT/EN · desktop e mobile","Suporte por e-mail"]'),
 ('inter', 'Intermediario',  2, 100, 50000, 47500,
   '["Tudo do modulo Basico","Gestao de ate 100 clientes","Projetos e fases com Gantt","Tarefas por fase do projeto","Treinamentos & certificados verificaveis","Alerta de cronograma (prazos de adequacao)","Suporte prioritario"]'),
 ('adv',   'Avancado',       3, 150, 80000, 76000,
   '["Tudo do modulo Intermediario","Gestao de ate 150 clientes","Equipe com acesso por cliente (menor privilegio)","Marca da consultoria nos relatorios","Suporte dedicado & onboarding assistido"]'),
 ('owner', 'Dono da Plataforma', 99, NULL, 0, 0,
   '["Ambiente administrativo","Cadastro ilimitado de clientes para consultoria","Gestao de licencas e tenants","Auditoria global"]')
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name, tier=EXCLUDED.tier, client_quota=EXCLUDED.client_quota,
  price_month_cents=EXCLUDED.price_month_cents, price_recurring_cents=EXCLUDED.price_recurring_cents,
  features=EXCLUDED.features;

-- Tenant do dono (ambiente administrativo + consultoria ilimitada)
INSERT INTO tenants (id, name, email, plan_id, status, is_owner)
VALUES ('00000000-0000-0000-0000-000000000001', 'PJ Technology Solutions', 'pedrobj@gmail.com', 'owner', 'active', TRUE)
ON CONFLICT (id) DO UPDATE SET status='active', is_owner=TRUE, plan_id='owner';

-- Usuario dono (super-admin). Senha definida via /api/auth/bootstrap-owner.
INSERT INTO users (tenant_id, email, name, role, active)
VALUES ('00000000-0000-0000-0000-000000000001', 'pedrobj@gmail.com', 'Pedro (Dono)', 'OWNER', TRUE)
ON CONFLICT (email) DO UPDATE SET role='OWNER', active=TRUE;

-- =====================================================================
--  SECAO 12 — CRM (area negocial do dono)
--  Funil de vendas + atividades de relacionamento + campanhas de
--  fidelizacao. Tudo idempotente (CREATE TABLE IF NOT EXISTS).
-- =====================================================================
CREATE TABLE IF NOT EXISTS crm_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL, -- vira cliente => liga ao tenant
  name            TEXT NOT NULL,
  company         TEXT,
  doc             TEXT,                  -- CNPJ/CPF (so digitos)
  email           TEXT,
  phone           TEXT,
  source          TEXT DEFAULT 'manual', -- manual|checkout|indicacao|site|importacao
  stage           TEXT NOT NULL DEFAULT 'lead'
                  CHECK (stage IN ('lead','contato','proposta','ganho','perdido','cliente')),
  plan_interest   TEXT REFERENCES plans(id) ON DELETE SET NULL,
  value_cents     INTEGER NOT NULL DEFAULT 0,
  owner_email     TEXT,
  notes           TEXT,
  tags            TEXT,                  -- csv simples
  last_contact_at TIMESTAMPTZ,
  next_action_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_stage   ON crm_contacts(stage);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_tenant  ON crm_contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_next    ON crm_contacts(next_action_at);

CREATE TABLE IF NOT EXISTS crm_activities (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'nota'
              CHECK (type IN ('nota','ligacao','email','whatsapp','reuniao','estagio','campanha')),
  body        TEXT,
  actor_email TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id);

CREATE TABLE IF NOT EXISTS crm_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','email')),
  audience     TEXT NOT NULL DEFAULT 'todos',   -- todos|lead|cliente|<stage>
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','enviada')),
  sent_count   INTEGER NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  SECAO 13 — Seguranca (anti-invasao / brute force) + suporte
--  Bloqueio de login por tentativas e auditoria de acesso de suporte.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;

-- Registro de acessos de suporte do dono ao ambiente de um cliente.
CREATE TABLE IF NOT EXISTS support_sessions (
  id          BIGSERIAL PRIMARY KEY,
  owner_email TEXT NOT NULL,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  reason      TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_sessions_tenant ON support_sessions(tenant_id);

# Deploy — DPO PJ Protection (SaaS)

Plataforma comercial: licenciamento, cobrança multi-gateway, kill-switch por
inadimplência, NFS-e e auditoria. Roda em **Netlify (Functions serverless)** +
**Neon Postgres**. Funções ESM (Node 20) + estático; no deploy via Git o Netlify
**aplica a migração do banco automaticamente** (build command em `netlify.toml`).

---

## 0. Como atualizar a plataforma (passo a passo)

> ⚠️ **São dois sites diferentes na pasta `plataforma-lgpd/`:**
> - `index.html` + `site-institucional/` = **site institucional** (estático). Pode
>   continuar publicando por *arrastar a pasta* no Netlify.
> - **`saas-netlify/`** = **a plataforma** (login, painel, app, API, cobrança). Tem
>   funções serverless + banco — **não** dá para atualizar arrastando arquivo solto
>   (as bibliotecas não são instaladas e a migração não roda).

### Forma recomendada: GitHub → Netlify (sem precisar de Node no seu computador)

**Configuração inicial (uma vez só):**
1. Crie conta no [github.com](https://github.com) e um repositório (ex.: `dpo-plataforma`).
2. Envie o **CONTEÚDO de dentro da pasta `saas-netlify/`** (os arquivos e subpastas:
   `netlify.toml`, `package.json`, `public/`, `netlify/`, `db/`, `scripts/`…) para a
   **raiz** do repositório — **não** a pasta `saas-netlify` em si. Assim a raiz do repo
   já é a raiz do projeto.
3. No Netlify: *Site configuration → Build & deploy → Link repository* → escolha o
   repositório. **Base directory = (deixe vazio)**, **Publish directory = `public`**
   (o `netlify.toml` já define isso).
4. Confira as variáveis de ambiente (seção 2). Deploy.

**A cada atualização (o dia a dia):**
1. O Claude informa **a lista exata de arquivos alterados** (bloco "📤 Arquivos para subir").
2. Abra o repositório no github.com → vá na pasta certa → *Add file → Upload files*
   → arraste o(s) arquivo(s) novo(s) → **Commit changes**.
3. O Netlify detecta e publica em ~1–2 min. **A migração roda sozinha** quando o
   `db/schema.sql` muda — você não precisa mexer no banco.

### O que subir / o que NUNCA subir

No **primeiro envio**, suba a pasta inteira (com subpastas). Depois, só os arquivos
alterados. **Nunca** versione segredos nem lixo local (o `.gitignore` já bloqueia):

| ✅ Subir | 🚫 Nunca subir |
|---|---|
| `.env.example` (modelo, sem segredos) | `.env` (tokens/senhas reais) |
| `.gitignore`, `DEPLOY.md`, `netlify.toml`, `package.json` | `node_modules/` (o Netlify reinstala) |
| `db/`, `scripts/`, `netlify/functions/` (e `lib/`), `public/` (e `app/`, `owner/`) | `.DS_Store`, `*.log`, `.netlify/` |

### Sem GitHub e sem Node (alternativa de emergência)

Para aplicar **só mudanças de banco** sem deploy: no painel do **Neon → SQL Editor**,
cole o conteúdo de `db/schema.sql` e rode (*Run*). É idempotente. Mas o **código +
funções** continuam exigindo GitHub (ou o Netlify CLI, que precisa de Node) — por
isso o caminho GitHub acima é o recomendado.

---

## 1. Banco de dados (Neon)

1. Crie um projeto no [Neon](https://neon.tech) (Postgres serverless).
2. Copie a **connection string** (formato `postgres://user:pass@host/db?sslmode=require`).
3. Rode a migração (cria tabelas + seeds dos planos e do usuário dono):

   ```bash
   cd saas-netlify
   npm install
   DATABASE_URL="postgres://...sua-string..." npm run migrate
   ```

   A migração é **idempotente** (pode rodar de novo sem perder dados).

> **Sem Node no seu computador?** No fluxo GitHub → Netlify (seção 0) a migração
> roda **sozinha** a cada deploy. Para a 1ª carga sem deploy, use o **Neon → SQL
> Editor** e cole o conteúdo de `db/schema.sql`.

> Dica: no Neon você pode usar **Database Branches** para ter um banco de
> homologação separado do de produção.

---

## 2. Variáveis de ambiente (Netlify → Site settings → Environment variables)

Veja `.env.example` para a lista completa. Mínimo para subir:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | ✅ | Conexão Neon |
| `JWT_SECRET` | ✅ | Assinatura dos tokens (string longa aleatória) |
| `BOOTSTRAP_TOKEN` | ✅ (1ª vez) | Definir a senha do dono com segurança |
| `OWNER_EMAIL` | ✅ | `pedrobj@gmail.com` (já no seed) |
| `APP_BASE_URL` | ✅ | Ex.: `https://app.dpopjprotection.com.br` (monta o link de ativação) |
| `GRACE_DAYS` | — | Dias de carência antes do bloqueio (padrão 5) |

**Gateways de pagamento** (configure ao menos um):
- Mercado Pago: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Pagar.me: `PAGARME_SECRET_KEY`, `PAGARME_WEBHOOK_SECRET`
- `DEFAULT_GATEWAY` (ex.: `mercadopago`)

**NFS-e (opcional, Focus NFe):** `FOCUSNFE_TOKEN`, `FOCUSNFE_ENV`, `EMITENTE_*`,
`NFSE_*`. CNPJ emitente já configurado: `36741351000109`.

**Notificações (opcional):** `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`,
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`.

---

## 3. Subir no Netlify

1. Conecte o repositório no Netlify. O `netlify.toml` já define:
   - **Sem `base`** — o conteúdo de `saas-netlify/` vai na **raiz** do repositório, então a
     raiz do repo já é a raiz do projeto. Use `publish = "public"` e funções em `netlify/functions`.
   - Redirects: `/api/*`, `/webhooks/{mercadopago,stripe,pagarme}`, `/painel`, `/ativar`, `/demo`.
2. Deploy. As funções são empacotadas automaticamente (esbuild).

---

## 4. Definir / recuperar a senha do dono

Você define a senha — o sistema nunca a recebe de terceiros. Exige o
`BOOTSTRAP_TOKEN` configurado no Netlify (Environment variables).

**Opção A — pela tela (recomendado).** Acesse **`/owner-setup.html`** (também há o
link _“Recuperar acesso do dono”_ no rodapé da tela de login `/`). Informe o
`BOOTSTRAP_TOKEN` e a nova senha (10+ caracteres). Serve tanto para o **1º acesso**
quanto para **recuperação** caso você perca a senha. A página detecta sozinha se a
recuperação está habilitada (consulta `GET /api/auth/bootstrap-status`).

**Opção B — por linha de comando.**

```bash
curl -X POST https://SEU-SITE/api/auth/bootstrap-owner \
  -H "Content-Type: application/json" \
  -d '{"token":"SEU_BOOTSTRAP_TOKEN","password":"sua-senha-forte-10+"}'
```

Em ambos os casos o backend faz **UPSERT** do dono (cria se o seed ainda não rodou),
vincula o tenant do dono e destrava qualquer bloqueio por tentativas. Depois faça
login em `/` → você cai no painel `/painel` e ativa o 2FA na aba **Conta**.

> **Mantenha o `BOOTSTRAP_TOKEN` definido** se quiser poder recuperar o acesso do dono
> pela tela no futuro. Se preferir blindar ao máximo, remova-o após o 1º acesso e
> redefina temporariamente quando precisar recuperar.

**Recuperar a senha de um cliente:** no painel, **Licenças → Gerenciar →
“Resetar senha”** gera uma senha temporária forte (exibida uma vez, com envio por
WhatsApp). O 2FA do cliente continua valendo. Registrado na Auditoria.

---

## 5. Webhooks dos gateways

Aponte os webhooks de cada gateway para:

- Mercado Pago → `https://SEU-SITE/webhooks/mercadopago`
- Stripe → `https://SEU-SITE/webhooks/stripe`
- Pagar.me → `https://SEU-SITE/webhooks/pagarme`

O pagamento aprovado ativa o tenant, estende o período, emite NFS-e (se ativa)
e dispara as notificações.

---

## 6. Cobrança automática (cron)

A função `cron-billing` roda **diariamente às 09:00 UTC** (`schedule` no código):
avisa 3 dias antes do vencimento → entra em carência → **bloqueia (kill-switch)**
após `GRACE_DAYS` → atualiza NFS-e pendentes. Nada a configurar manualmente.

---

## 7. Páginas

| URL | O quê |
|---|---|
| `/` | Login (com etapa de MFA quando ativado) |
| `/painel` | Painel do dono (licenças, assinantes, financeiro, consultoria, auditoria) |
| `/app/` | App operacional LGPD (assinantes **e** consultoria completa do dono) |
| `/checkout.html` | Contratação pública (planos + pagamento) |
| `/ativar` | Ativação do cliente (cria usuário + destrava o módulo) |
| `/demo` | Auto-login do ambiente de demonstração (`?d=<token>`) |
| `/bloqueado.html` | Aviso de acesso suspenso por pendência (kill-switch) |

Veja `TUTORIAL.html` para o passo a passo operacional de vendas e gestão.

---

## 8. Segurança: MFA (2FA) e arquitetura de domínio

### Multifator (TOTP)
- O MFA é **TOTP** (RFC 6238) compatível com Google Authenticator, Authy,
  1Password e Microsoft Authenticator — implementado com `crypto` nativo, **sem
  dependências novas** e **sem chamadas a terceiros** (o QR é gerado no navegador;
  o segredo nunca sai para serviços externos).
- Não há variável de ambiente nova: o desafio curto entre senha e código é
  assinado com o mesmo `JWT_SECRET`.
- Fluxo de login: senha → se `mfa_enabled`, a API responde `{mfaRequired,mfaToken}`
  (token de 5 min) → o usuário informa o código de 6 dígitos em `/api/auth/mfa-verify`
  → recebe o token de sessão (12 h).
- O usuário ativa/desativa o 2FA na aba **Conta** do app (`/app/`).
- **Recomendação:** ative o 2FA na sua conta de dono logo após o bootstrap — é a
  real barreira de segurança da plataforma.

### Domínio: mesmo host para todos (recomendado)
Seu acesso continua em `https://app.dpopjprotection.com.br/` e **o mesmo host
serve todas as contas**. O roteamento é por **papel**, não por URL:
- `app.dpopjprotection.com.br/` → login único.
- Dono (`OWNER`) cai em `/painel` e tem o botão **“Consultoria completa ↗”** para o
  `/app/` (ambiente ilimitado, todos os recursos).
- Assinantes caem em `/app/` limitados ao módulo que compraram.

Esconder a área admin atrás de outro host **não é segurança real** (URL não é
segredo). A barreira de verdade já está no backend: senha forte + **MFA** +
autorização por papel no servidor (`isOwner`, `assertFeature`, kill-switch).
Por isso o mesmo domínio é seguro.

**Defesa em profundidade (opcional):** se quiser, aponte um alias separado
(ex.: `admin.dpopjprotection.com.br`) para o mesmo site no Netlify — o `/painel`
continua protegido por papel + MFA de qualquer forma.

---

## 9. Link de demonstração (prospects)

No painel do dono (`/painel`), o botão **“Link de demonstração”** gera um
ambiente de teste completo para enviar a interessados:

- Cria um **tenant isolado** (`is_demo`) no módulo **Avançado** (todos os
  recursos liberados), já populado com **clientes de exemplo** (clientes,
  documentos versionados, solicitações de titulares, incidentes, projetos e
  tarefas). O prospect faz **todo o processo operacional** durante o período.
- O link (`/demo?d=<token>`) faz **login automático** sem senha — basta copiar
  e enviar. A página é `noindex` (fora dos buscadores).
- **Validade de 7 dias** (configurável por `DEMO_DAYS`). Após expirar, o acesso
  é bloqueado e o link pede uma nova demonstração.
- **Cada nova geração apaga a demo anterior** (tenant + todos os dados, em
  cascata, incluindo limpeza do `audit_log`) e **recria** um ambiente novo do
  zero. Existe sempre **no máximo uma** demo ativa.

Variável de ambiente opcional:

| Variável | Padrão | O quê |
|---|---|---|
| `DEMO_DAYS` | `7` | Dias de validade do ambiente de demonstração |

Uso: abra `/painel` → **Link de demonstração** → **Gerar novo link** → copie e
envie ao prospect. Para renovar, basta gerar de novo (a anterior é descartada).

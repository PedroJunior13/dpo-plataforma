/* Painel do Dono — DPO PJ Protection (v2)
   Área negocial: dashboard interativo, Compras (gera licença do módulo em 1 clique),
   Licenças & assinantes (status, upgrade/downgrade, suporte/acesso ao ambiente),
   CRM (funil + campanhas) e auditoria completa. */
(function () {
  "use strict";

  const PLATFORM_VERSION = "2.8.4";
  const API = "/api";
  const TOKEN = localStorage.getItem("dpo_token");
  const USER = JSON.parse(localStorage.getItem("dpo_user") || "null");

  if (!TOKEN || !USER || USER.role !== "OWNER") { location.replace("/?next=/painel"); return; }

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const brl = (cents) => "R$ " + ((cents || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  const dt = (s) => s ? new Date(s).toLocaleDateString("pt-BR") : "—";
  const dtt = (s) => s ? new Date(s).toLocaleString("pt-BR") : "—";
  const digits = (s) => String(s || "").replace(/\D/g, "");
  // Le um arquivo e devolve so o base64 (sem o prefixo data:...;base64,).
  const fileToB64 = (file) => new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => { try { const s = String(rd.result || ""); const i = s.indexOf(","); res(i >= 0 ? s.slice(i + 1) : s); } catch (e) { rej(e); } };
    rd.onerror = () => rej(new Error("Falha ao ler o arquivo selecionado."));
    rd.readAsDataURL(file);
  });

  let TOAST_T;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(TOAST_T); TOAST_T = setTimeout(() => t.classList.remove("show"), 2400);
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, ...(opts.headers || {}) },
    });
    if (res.status === 401) { logout(); throw new Error("Sessão expirada."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Erro na requisição.");
    return data;
  }
  function logout() { localStorage.removeItem("dpo_token"); localStorage.removeItem("dpo_user"); location.replace("/"); }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copiado!"); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Copiado!"); }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) { const el = $("#" + b.getAttribute("data-copy")); if (el) copy(el.textContent); }
    const c = e.target.closest("[data-close]");
    if (c) c.closest(".modal-bg").classList.remove("show");
    const g = e.target.closest("[data-goto]");
    if (g) navTo(g.getAttribute("data-goto"));
    // Bloco informativo clicável → janela pop com o contexto (ou ir ao local certo).
    const inf = e.target.closest("[data-info]");
    if (inf) {
      const onCtrl = e.target.closest("button,a,input,select,textarea");
      const onDot = e.target.closest(".info-dot");
      if (onDot || !onCtrl) openInfo(inf.getAttribute("data-info"));
    }
  });
  $$(".modal-bg").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));
  function openModal(id) { $("#" + id).classList.add("show"); }
  function closeModal(id) { $("#" + id).classList.remove("show"); }

  // ---------- contexto dos blocos (janela pop "Entenda este bloco") ----------
  // Cada bloco informativo do painel tem data-info="chave". Clicar abre um popup
  // com a explicação inerente e, quando faz sentido, um botão que leva ao local certo.
  const INFO = {
    sec_dashboard: { t: "Painel de gestão", b: "Visão geral do negócio: indicadores, receita, funil de vendas, vencimentos e atividade recente. Os 5 cartões do topo são clicáveis e levam direto à área correspondente." },
    sec_purchases: { t: "Compras", b: "Toda transação do checkout chega aqui. Confira os dados e clique em “Gerar licença” para criar a chave do módulo comprado, já no perfil correto e pronta para enviar.", goto: "purchases", gl: "Abrir Compras" },
    sec_licenses: { t: "Licenças & assinantes", b: "Status de cada cliente (módulo + ativo/inativo), upgrade/downgrade sem perder dados, suporte e acesso ao ambiente do cliente. Use “Gerenciar” na linha do cliente.", goto: "licenses", gl: "Abrir Licenças" },
    sec_crm: { t: "CRM — vendas & fidelização", b: "Funil de oportunidades, histórico de relacionamento e campanhas de retenção. Clique num cartão para mover de estágio, registrar atividade e agendar o próximo follow-up.", goto: "crm", gl: "Abrir CRM" },
    sec_payments: { t: "Financeiro", b: "Pagamentos recebidos. Em pagamentos aprovados, use “Emitir NFS-e” para disparar a nota fiscal (integração Focus NFe).", goto: "payments", gl: "Abrir Financeiro" },
    sec_support: { t: "Suporte — Service Desk", b: "Central de chamados dos consultores e clientes, em fila por ordem de abertura. Acompanhe SLA de 1ª resposta por prioridade, mude o status e responda direto ao solicitante (a resposta vai por e-mail e fica no histórico do chamado).", goto: "support", gl: "Abrir Suporte" },
    sup_status: { t: "Chamados por status", b: "Distribuição da fila por situação: aberto, em andamento, aguardando cliente, resolvido e fechado. Use o filtro do topo para focar numa situação." },
    sup_priority: { t: "Chamados por prioridade", b: "Quantidade de chamados em cada nível de prioridade. O SLA de 1ª resposta é: urgente 4h, alta 8h, normal 24h, baixa 48h." },
    sec_audit: { t: "Auditoria", b: "Trilha completa e imutável: licenças, suporte, segurança e ações administrativas. Mostra os 15 registros mais recentes (role para ver todos), incluindo a ORIGEM de cada ação — local aproximado (cidade/UF/país), IP e dispositivo/navegador.", b2: "Cada licença também tem um número de versão que incrementa a cada mudança de estado." },
    dash_revenue: { t: "Receita aprovada", b: "Soma dos pagamentos aprovados nos últimos 6 meses, mês a mês. Use para acompanhar a evolução do faturamento.", goto: "payments", gl: "Ver Financeiro" },
    dash_licstatus: { t: "Status das licenças", b: "Distribuição das licenças por situação (ativa, emitida, suspensa, etc.). Verde indica saudável; vermelho indica que exige atenção.", goto: "licenses", gl: "Ver Licenças" },
    dash_funnel: { t: "Funil de vendas (CRM)", b: "Quantidade e valor de oportunidades em cada estágio do funil. Trabalhe os estágios no CRM para aumentar a conversão.", goto: "crm", gl: "Abrir CRM" },
    dash_modules: { t: "Distribuição por módulo & integrações", b: "Quantos assinantes e quanta receita cada módulo gera, além do status das integrações de pagamento e de NFS-e.", goto: "licenses", gl: "Ver Licenças" },
    dash_overdue: { t: "Vencimentos & atrasos", b: "Clientes vencendo nos próximos 7 dias ou já atrasados. Use o botão “Cobrar” para abrir o WhatsApp com a mensagem pronta. Bloqueios por inadimplência são automáticos.", goto: "licenses", gl: "Ver Licenças" },
    dash_recent: { t: "Atividade recente", b: "Últimos eventos do sistema. O registro completo e imutável fica na aba Auditoria.", goto: "audit", gl: "Ver Auditoria" },
    // --- CRM (4 cartões do topo) ---
    crm_contacts: { t: "Contatos", b: "Total de pessoas/empresas no seu funil — somando todos os estágios (lead, contato, proposta, ganho, perdido e cliente). É a sua base de relacionamento. Cadastre novos contatos pelo botão “Novo contato” e arraste/clique nos cartões do funil para movê-los de estágio." },
    crm_clients: { t: "Clientes (ganhos)", b: "Oportunidades que viraram cliente (estágio “Ganho”/“Cliente”). É o resultado concreto do seu funil. Cada cliente ganho deve ter uma licença correspondente na aba Licenças — se faltar, gere a licença pela aba Compras." },
    crm_conversion: { t: "Conversão", b: "Percentual de contatos que viraram cliente (ganhos ÷ total de contatos). Mede a eficiência do seu funil de vendas. Para subir esse número, trabalhe os follow-ups em dia e mova as propostas paradas." },
    crm_followups: { t: "Follow-ups (3 dias)", b: "Contatos com follow-up agendado para os próximos 3 dias. São os retornos que você prometeu dar — abra cada cartão do funil para registrar a atividade e agendar o próximo passo. Não deixar follow-up vencer é o que mantém a conversão alta." },
    // --- Suporte (5 cartões do topo) ---
    sup_needs: { t: "Aguardando sua resposta", b: "Chamados em que a última mensagem foi do cliente/consultor e ainda não houve resposta sua. São a sua fila de prioridade imediata. Abra o chamado, responda (a resposta vai por e-mail e fica no histórico) e o contador zera." },
    sup_open: { t: "Em aberto (fila)", b: "Chamados que ainda não foram resolvidos nem fechados — incluindo os que estão em andamento ou aguardando o cliente. É o tamanho atual da sua fila de atendimento." },
    sup_sla: { t: "SLA estourado", b: "Chamados que passaram do prazo de 1ª resposta sem serem respondidos. SLA por prioridade: urgente 4h, alta 8h, normal 24h, baixa 48h. Priorize zerar esse número — ele indica clientes esperando além do combinado." },
    sup_avg: { t: "Tempo médio de 1ª resposta", b: "Média de horas entre a abertura do chamado e a sua primeira resposta, considerando os chamados já respondidos. Quanto menor, melhor a percepção de atendimento. Compare com as metas de SLA por prioridade." },
    sup_total: { t: "Total de chamados", b: "Volume total de chamados já registrados (todas as situações), com o destaque de quantos foram abertos nos últimos 7 dias. Serve para dimensionar a demanda de suporte ao longo do tempo." },
    // --- Integrações ---
    sec_integrations: { t: "Integrações", b: "Conexões externas da plataforma: emissão de NFS-e (Focus NFe), gateways de pagamento e canais de aviso (e-mail/WhatsApp). Os parâmetros salvos aqui têm precedência sobre as variáveis de ambiente — você ajusta tudo pelo painel, sem mexer no servidor." },
    integ_nfse: { t: "NFS-e (Focus NFe)", b: "Emissão automática da nota fiscal de serviço a cada pagamento aprovado, via Focus NFe (que abstrai o padrão de cada prefeitura). Obrigatórios: token, CNPJ do emitente, Inscrição Municipal e Código do Município (IBGE). Use o ambiente de Homologação para testar antes de ligar a Produção.", b2: "Dica: o item da lista de serviço 1.07 e a alíquota de ISS 2% são os padrões para licenciamento/suporte em TI no Simples Nacional — confirme com a sua contabilidade." },
    integ_others: { t: "Pagamentos & avisos", b: "Gateways de pagamento (PIX/boleto/cartão) e canais de notificação (e-mail via Resend, WhatsApp via Meta) são configurados por variável de ambiente no servidor. Aqui você vê o status de cada um — verde indica configurado e pronto." },
  };
  function openInfo(key) {
    const i = INFO[key]; if (!i) return;
    $("#g_title").textContent = i.t;
    // Janela puramente informativa (contexto inerente do bloco). NÃO redireciona:
    // por decisão de UX, clicar num bloco explica o bloco — não tira o dono da tela atual.
    const extra = i.b2 ? `<p class="muted" style="line-height:1.65;font-size:13px;margin-top:10px">${esc(i.b2)}</p>` : "";
    $("#g_body").innerHTML =
      `<p class="muted" style="line-height:1.65;font-size:14px">${esc(i.b)}</p>` + extra;
    openModal("modalGeneric");
  }

  // ---------- status helpers ----------
  let PLANS = [];
  const tag = (status) => `<span class="tag ${esc(status)}">${esc(statusLabel(status))}</span>`;
  function statusLabel(s) {
    return ({ active: "Ativo", issued: "Emitida", pending: "Pendente", grace: "Carência",
      suspended: "Suspenso", blocked: "Bloqueado", revoked: "Revogada", canceled: "Cancelado", expired: "Expirada" }[s]) || s;
  }
  // Ativo/Inativo consolidado (módulo + situação do cliente).
  function isActive(l) {
    return l.tenant_status === "active" && ["active", "issued"].includes(l.status);
  }
  function activeTag(l) {
    return isActive(l)
      ? `<span class="tag active">Ativo</span>`
      : `<span class="tag suspended">Inativo</span>`;
  }

  // ---------- navegação ----------
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;
    navTo(b.getAttribute("data-view"));
  });
  $("#btnLogout").addEventListener("click", logout);
  function navTo(view) {
    $$("#nav button[data-view]").forEach((x) => x.classList.toggle("active", x.getAttribute("data-view") === view));
    show(view);
  }
  function show(view) {
    $$(".view").forEach((v) => v.classList.add("hide"));
    const sec = $("#view-" + view); if (sec) sec.classList.remove("hide");
    ({ dashboard: loadDashboard, purchases: loadPurchases, licenses: loadLicenses,
      crm: loadCrm, payments: loadPayments, support: loadSupport,
      integrations: loadIntegrations }[view] || (() => {}))();
  }

  // ===================================================================
  //  DASHBOARD (interativo)
  // ===================================================================
  // goto = navega para outra aba ao clicar; info = abre popup "Entenda este bloco".
  // Ambos deixam o cartão clicável (classe "click"); info tem precedência visual de cursor.
  const kpi = (v, l, cls = "", sub = "", goto = "", info = "") =>
    `<div class="kpi ${(goto || info) ? "click" : ""}" ${goto ? `data-goto="${goto}"` : ""} ${info ? `data-info="${info}"` : ""}>
       <div class="v ${cls}">${v ?? 0}</div><div class="l">${esc(l)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${info ? `<span class="info-dot" title="Entenda este bloco">i</span>` : ""}</div>`;

  async function loadDashboard() {
    try {
      const d = await api("/owner/dashboard");
      const t = d.totals || {};
      $("#kpis").innerHTML = [
        kpi(t.tenants, "Assinantes", "", `${t.active || 0} ativos`, "licenses"),
        kpi(t.pending_purchases, "Compras a liberar", t.pending_purchases ? "gold" : "", "gerar licença", "purchases"),
        kpi(t.active_licenses, "Licenças ativas", "green", `${t.pending_activation || 0} a ativar`, "licenses"),
        kpi(t.clients_managed, "Clientes na operação", "", "todos os assinantes", ""),
        kpi(brl(d.mrrCents), "Receita recorrente", "gold", "MRR ativo", "payments"),
      ].join("");

      // Gráfico de receita (CSS bars)
      const rev = d.revenue || [];
      const maxRev = Math.max(1, ...rev.map((r) => r.cents));
      $("#revChart").innerHTML = rev.length ? rev.map((r) => {
        const h = Math.round((r.cents / maxRev) * 100);
        const m = r.ym.slice(5) + "/" + r.ym.slice(2, 4);
        return `<div class="barcol"><div class="bv">${(r.cents / 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}</div><div class="bar" style="height:${h}%"></div><div class="bl">${esc(m)}</div></div>`;
      }).join("") : `<span class="muted small">Sem pagamentos aprovados ainda.</span>`;

      // Status das licenças (barras horizontais)
      const ls = d.licStatus || [];
      const totLs = Math.max(1, ls.reduce((a, b) => a + b.n, 0));
      const cls = (s) => (["active"].includes(s) ? "g" : ["suspended", "revoked", "expired"].includes(s) ? "r" : "");
      $("#licStatusBox").innerHTML = ls.length ? ls.map((s) =>
        `<div class="hbar"><div class="lbl"><span>${esc(statusLabel(s.status))}</span><b>${s.n}</b></div>
         <div class="track"><div class="fill ${cls(s.status)}" style="width:${Math.round((s.n / totLs) * 100)}%"></div></div></div>`).join("")
        : `<p class="muted">Nenhuma licença emitida.</p>`;

      // Funil do CRM
      const order = ["lead", "contato", "proposta", "ganho", "perdido", "cliente"];
      const fmap = {}; (d.crmFunnel || []).forEach((f) => fmap[f.stage] = f);
      const maxF = Math.max(1, ...order.map((s) => (fmap[s]?.n || 0)));
      $("#funnelBox").innerHTML = order.map((s) => {
        const n = fmap[s]?.n || 0, val = fmap[s]?.value || 0;
        return `<div class="stg"><span class="nm">${esc(s)}</span>
          <div class="bar" style="width:${Math.max(10, Math.round((n / maxF) * 100))}%">${n}</div>
          <span class="vl">${val ? brl(val) : ""}</span></div>`;
      }).join("");

      // Distribuição por módulo (com receita)
      $("#byPlanBox").innerHTML = (d.byPlan || []).map((p) =>
        `<div class="flex between" style="padding:7px 0;border-bottom:1px solid var(--line)">
          <span>${esc(p.name || p.plan_id)}</span>
          <span><b>${p.n}</b> <span class="small muted">· ${brl(p.revenue)}</span></span></div>`).join("") || `<p class="muted">Sem assinantes ainda.</p>`;

      // Integrações
      const gws = d.gateways || [];
      let nfseLine;
      if (d.nfseEnabled) {
        nfseLine = `<span class="tag active">ativa</span>` +
          (d.nfseAuto ? ` <span class="tag active">emissão automática</span>` : ` <span class="tag pending">automática desligada</span>`);
      } else {
        const miss = (d.nfseMissing || []);
        nfseLine = `<span class="tag pending">não configurada</span>` +
          (miss.length ? `<div class="small muted" style="margin-top:4px">Falta definir: ${miss.map(esc).join(", ")}</div>` : "");
      }
      $("#integ").innerHTML =
        `<div>Pagamento: ${gws.length ? gws.map((g) => `<span class="tag active" style="text-transform:capitalize">${esc(g)}</span>`).join(" ") : '<span class="tag grace">manual (sem gateway)</span>'}</div>` +
        `<div style="margin-top:8px">NFS-e: ${nfseLine}</div>`;

      // Vencimentos
      const ov = d.overdue || [];
      $("#overdueBox").innerHTML = ov.length ? `<table><thead><tr><th>Cliente</th><th>Vence</th><th>Status</th><th></th></tr></thead><tbody>${
        ov.map((o) => {
          const days = Math.ceil((new Date(o.current_period_end) - Date.now()) / 864e5);
          const lbl = days < 0 ? `<span style="color:#ff9aa8">${Math.abs(days)}d atrasado</span>` : `em ${days}d`;
          const wa = o.phone ? `<a class="btn sm green" target="_blank" rel="noopener" href="https://wa.me/${digits(o.phone)}?text=${encodeURIComponent("Ola " + o.name + ", sobre sua assinatura DPO PJ Protection: identificamos um vencimento proximo. Vamos regularizar?")}">Cobrar</a>` : "";
          return `<tr><td>${esc(o.name)}<div class="small muted">${esc(o.plan_name || "")}</div></td><td>${dt(o.current_period_end)}<div class="small muted">${lbl}</div></td><td>${tag(o.status)}</td><td style="text-align:right">${wa}</td></tr>`;
        }).join("")
      }</tbody></table>` : `<p class="muted">Nenhum vencimento nos próximos 7 dias. 🎉</p>`;

      // Atividade recente
      const rec = d.recent || [];
      $("#recentBox").innerHTML = rec.length ? rec.map((r) =>
        `<div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <span>${esc(actionLabel(r.action))}</span><span class="small muted">${esc(r.actor_email || "system")} · ${dtt(r.created_at)}</span></div>`).join("")
        : `<p class="muted">Sem atividade recente.</p>`;

      // Painel de auditoria (rodapé do Painel) — últimos 15 registros com origem.
      loadAudit();
    } catch (e) { $("#kpis").innerHTML = `<div class="card" style="color:#ff9aa8">${esc(e.message)}</div>`; }
  }

  // ===================================================================
  //  DEMONSTRAÇÃO
  // ===================================================================
  function renderDemo(demo) {
    if (demo && demo.link && !demo.expired) {
      $("#d_link").textContent = demo.link;
      const c = demo.counts || {};
      $("#d_expires").textContent = `Expira em ${dtt(demo.expiresAt)} · ${c.clients ?? 0} clientes de exemplo.`;
      $("#demoBox").innerHTML = `<span class="tag active">demonstração ativa</span>`;
      $("#demoResult").classList.remove("hide");
    } else {
      $("#demoBox").innerHTML = demo && demo.expired
        ? `<span class="tag suspended">demonstração expirada</span> — gere um novo link.`
        : `<span class="muted">Nenhum link de demonstração ativo. Gere o primeiro abaixo.</span>`;
      $("#d_link").textContent = demo && demo.link ? demo.link : "";
      $("#d_expires").textContent = "";
      $("#demoResult").classList.toggle("hide", !(demo && demo.link));
    }
  }
  async function openDemo() {
    openModal("modalDemo"); $("#demoBox").innerHTML = "Carregando…";
    try { const d = await api("/owner/demo"); renderDemo(d.demo); }
    catch (e) { $("#demoBox").innerHTML = `<span style="color:#ff9aa8">${esc(e.message)}</span>`; }
  }
  async function generateDemo() {
    if (!confirm("Gerar um novo link de demonstração? O ambiente atual será APAGADO e recriado.")) return;
    const btn = $("#btnDemoGen"); if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
    try { const r = await api("/owner/demo", { method: "POST" }); renderDemo({ link: r.link, expiresAt: r.expiresAt, expired: false, counts: { clients: 3 } }); toast("Demonstração recriada!"); }
    catch (e) { toast(e.message); } finally { if (btn) { btn.disabled = false; btn.textContent = "Gerar novo link (apaga e recria)"; } }
  }
  $("#btnDemo").addEventListener("click", openDemo);
  $("#btnDemoGen").addEventListener("click", generateDemo);

  // ===================================================================
  //  EMITIR LICENÇA
  // ===================================================================
  async function ensurePlans() {
    if (PLANS.length) return PLANS;
    const d = await api("/owner/plans");
    PLANS = (d.plans || []).filter((p) => p.id !== "owner");
    return PLANS;
  }
  // Preço de referência por módulo — garante valores corretos no seletor mesmo que
  // o banco ainda não tenha aplicado a migração de preços (evita "R$ 0,00/mês").
  const FALLBACK_PRICE = { basic: 35000, inter: 50000, adv: 80000 };
  async function openEmitir() {
    await ensurePlans();
    $("#e_plan").innerHTML = PLANS.map((p) => {
      const q = p.client_quota == null ? "ilimitado" : p.client_quota + " clientes";
      const cents = p.price_month_cents || FALLBACK_PRICE[p.id] || 0;
      return `<option value="${esc(p.id)}">${esc(p.name)} — ${q} — ${brl(cents)}/mês</option>`;
    }).join("");
    ["e_name", "e_doc", "e_email", "e_phone", "e_reason"].forEach((id) => { $("#" + id).value = ""; });
    if ($("#e_validdays")) $("#e_validdays").value = "";
    if ($("#e_pricing")) $("#e_pricing").value = "paid";
    syncPricingFields();
    $("#emitForm").classList.remove("hide");
    $("#emitResult").classList.add("hide");
    openModal("modalEmitir");
  }
  // Alterna campos conforme o tipo: cortesia esconde "Cobrança" e mostra validade + motivo.
  function syncPricingFields() {
    const free = $("#e_pricing") && $("#e_pricing").value === "free";
    const t = (id, on) => { const el = $("#" + id); if (el) el.classList.toggle("hide", !on); };
    t("e_billing_wrap", !free);
    t("e_validdays_wrap", free);
    t("e_reason_wrap", free);
  }
  { const ep = $("#e_pricing"); if (ep) ep.addEventListener("change", syncPricingFields); }
  $("#btnEmitir").addEventListener("click", openEmitir);
  $("#btnEmitirTop").addEventListener("click", openEmitir);
  $("#btnEmitOutra").addEventListener("click", openEmitir);

  // Auto-preenchimento por CNPJ/CPF (bases públicas via backend, com timeout/reserva).
  // Aceita CNPJ (14 dígitos) e CPF (11). CPF não tem base pública: apenas valida e
  // pede preenchimento manual (sem erro). CNPJ preenche nome/e-mail/telefone.
  $("#e_cnpj").addEventListener("click", async () => {
    const doc = digits($("#e_doc").value);
    if (doc.length !== 14 && doc.length !== 11) { toast("Informe um CNPJ (14 dígitos) ou CPF (11 dígitos)."); return; }
    const b = $("#e_cnpj"); b.disabled = true; b.textContent = "…";
    try {
      const r = await api(`/owner/crm/cnpj/${doc}`);
      if (r.manual) { toast(r.message || "CPF aceito — preencha os dados manualmente."); return; }
      const c = r.company || {};
      let filled = 0;
      if (c.name && !$("#e_name").value) { $("#e_name").value = c.name; filled++; }
      if (c.email && !$("#e_email").value) { $("#e_email").value = c.email; filled++; }
      if (c.phone && !$("#e_phone").value) { $("#e_phone").value = c.phone; filled++; }
      toast(filled ? "Dados do CNPJ preenchidos." : "Consulta concluída — confira/complete os dados.");
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = "Buscar"; }
  });

  $("#btnDoEmit").addEventListener("click", async () => {
    const name = $("#e_name").value.trim();
    if (!name) { toast("Informe o nome do cliente."); return; }
    const btn = $("#btnDoEmit"); btn.disabled = true; btn.textContent = "Gerando…";
    try {
      const pricing = $("#e_pricing") ? $("#e_pricing").value : "paid";
      const free = pricing === "free";
      if (free && !$("#e_reason").value.trim()) { toast("Informe o motivo da cortesia (controle)."); btn.disabled = false; btn.textContent = "Gerar licença e link"; return; }
      const body = {
        tenant: { name, doc: $("#e_doc").value.trim(), email: $("#e_email").value.trim(), phone: $("#e_phone").value.trim() },
        planId: $("#e_plan").value,
        pricing,
        billingType: free ? "monthly" : $("#e_billing").value,
        reason: free ? $("#e_reason").value.trim() : null,
        validDays: free ? (parseInt($("#e_validdays").value, 10) || null) : null,
      };
      const r = await api("/owner/licenses", { method: "POST", body: JSON.stringify(body) });
      showEmitResult(r);
      toast("Licença emitida!");
    } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = "Gerar licença e link"; }
  });
  function showEmitResult(r) {
    $("#r_link").textContent = r.link || "";
    $("#r_key").textContent = r.license?.license_key || "";
    $("#r_msg").textContent = r.message || "";
    // Nº/código da licença (versionado).
    const no = r.license?.license_no || "";
    $("#r_no").textContent = no;
    $("#r_nobox").classList.toggle("hide", !no);
    // Selo do tipo comercial (paga / cortesia sem custo).
    const pb = $("#r_pricing");
    if (pb) {
      const free = (r.license?.pricing || "paid") === "free";
      pb.textContent = free ? "Cortesia (sem custo)" : "Paga";
      pb.className = "tag " + (free ? "issued" : "active");
      pb.style.marginLeft = "6px";
    }
    // Confirmação de envio automático ao comprador (quando emitido pela aba Compras).
    // Reflete o status REAL do e-mail: enviado, provedor não configurado, ou erro.
    const em = $("#r_emailed");
    if (r.emailedTo) {
      em.textContent = `Licença + credenciais enviadas automaticamente para ${r.emailedTo}.`;
      em.style.color = "";
    } else if (r.emailStatus === "queued") {
      em.textContent = "E-mail automático não configurado (defina RESEND_API_KEY no Netlify). Copie o link e a chave abaixo e envie ao cliente.";
      em.style.color = "#e6b800";
    } else if (r.emailStatus === "error") {
      em.textContent = "Falha no envio automático do e-mail. Copie o link e a chave abaixo e envie ao cliente.";
      em.style.color = "#ff9aa8";
    } else {
      em.textContent = "Copie e envie ao cliente.";
      em.style.color = "";
    }
    const wa = $("#r_wa");
    if (r.whatsapp) { wa.href = r.whatsapp; wa.classList.remove("hide"); } else wa.classList.add("hide");
    $("#emitForm").classList.add("hide");
    $("#emitResult").classList.remove("hide");
    openModal("modalEmitir");
  }

  // ===================================================================
  //  COMPRAS — transações do checkout + gerar licença em 1 clique
  // ===================================================================
  async function loadPurchases() {
    const tb = $("#purchRows");
    try {
      const d = await api("/owner/purchases");
      const rows = d.purchases || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="7" class="muted">Nenhuma compra registrada ainda.</td></tr>`; return; }
      tb.innerHTML = rows.map((p) => {
        const sit = p.has_license
          ? `<span class="tag active">Licença gerada</span>`
          : (p.sub_status === "active" ? `<span class="tag active">Pago</span>` : `<span class="tag grace">Aguardando liberação</span>`);
        const act = p.has_license
          ? `<button class="btn sm ghost" data-goto-lic="${esc(p.tenant_id)}">Ver licença</button>`
          : `<button class="btn sm gold" data-issue="${esc(p.subscription_id)}">Gerar licença</button>`;
        return `<tr>
          <td class="small">${dtt(p.created_at)}</td>
          <td>${esc(p.tenant_name)}<div class="small muted">${esc(p.tenant_email || "")}${p.tenant_phone ? " · " + esc(p.tenant_phone) : ""}</div></td>
          <td>${esc(p.plan_name || p.plan_id)}<div class="small muted">${p.client_quota == null ? "ilimitado" : p.client_quota + " clientes"}</div></td>
          <td>${brl(p.amount_cents)}<div class="small muted">${esc(p.billing_type === "recurring" ? "recorrente" : "avulsa")}</div></td>
          <td class="small">${esc(p.method || "—")}<div class="small muted">${esc(p.gateway || "")}</div></td>
          <td>${sit}</td>
          <td style="text-align:right">${act}</td>
        </tr>`;
      }).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="7" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#btnReloadPurch").addEventListener("click", loadPurchases);
  { const ar = $("#btnAuditReload"); if (ar) ar.addEventListener("click", loadAudit); }
  $("#purchRows").addEventListener("click", async (e) => {
    const issue = e.target.closest("button[data-issue]");
    const goLic = e.target.closest("button[data-goto-lic]");
    if (goLic) { navTo("licenses"); return; }
    if (!issue) return;
    if (!confirm("Gerar a licença do módulo comprado para este cliente? A chave será criada no perfil correto, pronta para enviar.")) return;
    issue.disabled = true; issue.textContent = "Gerando…";
    try {
      const r = await api(`/owner/purchases/${issue.dataset.issue}/issue`, { method: "POST" });
      showEmitResult(r);
      toast("Licença gerada no perfil do cliente!");
      loadPurchases();
    } catch (err) { toast(err.message); issue.disabled = false; issue.textContent = "Gerar licença"; }
  });

  // ===================================================================
  //  LICENÇAS & ASSINANTES (unificado) + drawer de gestão/suporte
  // ===================================================================
  let LIC_ROWS = [];
  async function loadLicenses() {
    const tb = $("#licRows");
    try {
      await ensurePlans();
      const d = await api("/owner/licenses");
      LIC_ROWS = d.licenses || [];
      if (d.plans) PLANS = d.plans;
      renderLicenses();
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  function renderLicenses() {
    const tb = $("#licRows");
    const q = digits ? ($("#licSearch").value || "").toLowerCase() : "";
    const rows = LIC_ROWS.filter((l) => !q || (l.tenant_name || "").toLowerCase().includes(q) || (l.tenant_email || "").toLowerCase().includes(q) || (l.license_key || "").toLowerCase().includes(q) || (l.license_no || "").toLowerCase().includes(q));
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">Nenhuma licença encontrada.</td></tr>`; return; }
    tb.innerHTML = rows.map((l) => {
      const quota = l.client_quota_override != null ? l.client_quota_override : l.client_quota;
      const noLine = l.license_no ? `<div class="small muted mono">${esc(l.license_no)} · v${l.version}</div>` : `<div class="small muted mono">v${l.version}</div>`;
      const free = (l.pricing || "paid") === "free";
      const priceBadge = free ? ` <span class="tag issued" title="${esc(l.issue_reason || "Cortesia — sem custo")}">Cortesia</span>` : ` <span class="tag active">Paga</span>`;
      return `<tr>
        <td>${esc(l.tenant_name)}${noLine}<div class="small muted mono">${esc(l.license_key)}</div></td>
        <td>${esc(l.plan_name || l.plan_id)}${priceBadge}</td>
        <td>${activeTag(l)} <span class="small muted">${esc(statusLabel(l.status))}</span></td>
        <td>${l.clients_count ?? 0}${quota != null ? " / " + quota : ""}</td>
        <td>${dt(l.valid_until)}</td>
        <td style="text-align:right"><button class="btn sm gold" data-manage="${esc(l.id)}">Gerenciar</button></td>
      </tr>`;
    }).join("");
  }
  $("#licSearch").addEventListener("input", renderLicenses);
  $("#licRows").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-manage]"); if (!b) return;
    const l = LIC_ROWS.find((x) => x.id === b.dataset.manage); if (l) openManage(l);
  });

  function openManage(l) {
    const tid = l.tenant_id, lid = l.id;
    const quota = l.client_quota_override != null ? l.client_quota_override : l.client_quota;
    $("#m_title").textContent = "Gerenciar — " + (l.tenant_name || "cliente");
    $("#m_body").innerHTML = `
      <div class="statline">
        <div class="it"><div class="k">Módulo atual</div><div class="v">${esc(l.plan_name || l.plan_id)}</div></div>
        <div class="it"><div class="k">Situação</div><div class="v">${activeTag(l)}</div></div>
        <div class="it"><div class="k">Licença</div><div class="v">${tag(l.status)} <span class="small muted">${l.license_no ? esc(l.license_no) + " · " : ""}v${l.version}</span></div></div>
        <div class="it"><div class="k">Tipo</div><div class="v">${(l.pricing || "paid") === "free" ? `<span class="tag issued">Cortesia</span>${l.issue_reason ? ` <span class="small muted">${esc(l.issue_reason)}</span>` : ""}` : `<span class="tag active">Paga</span>`}</div></div>
        <div class="it"><div class="k">Clientes</div><div class="v">${l.clients_count ?? 0}${quota != null ? " / " + quota : " / ∞"}</div></div>
        <div class="it"><div class="k">Validade</div><div class="v">${dt(l.valid_until)}</div></div>
      </div>

      <h3 style="margin-top:14px">Suporte — acessar e resolver no perfil do cliente</h3>
      <p class="small muted">Acesse o ambiente do cliente para dar suporte, regenere o acesso ou redefina o 2FA quando necessário.</p>
      <div class="actrow">
        <button class="btn sm gold" id="mb_support">Acessar ambiente (suporte)</button>
        <button class="btn sm ghost" id="mb_send">Enviar/Copiar link</button>
        <button class="btn sm ghost" id="mb_regen">Regenerar acesso</button>
        <button class="btn sm ghost" id="mb_resetmfa">Resetar 2FA</button>
        <button class="btn sm ghost" id="mb_resetpass">Resetar senha</button>
      </div>

      <h3 style="margin-top:14px">Módulo & cota</h3>
      <div class="row c2">
        <div class="field"><label>Mudar módulo (upgrade/downgrade — sem perder dados)</label>
          <select id="mb_plan">${PLANS.map((p) => `<option value="${esc(p.id)}" ${p.id === l.plan_id ? "selected" : ""}>${esc(p.name)} — ${p.client_quota == null ? "ilimitado" : p.client_quota + " clientes"}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Cota personalizada (vazio = padrão do módulo)</label>
          <input id="mb_quota" type="number" min="0" value="${l.client_quota_override != null ? esc(l.client_quota_override) : ""}" placeholder="ex.: 200">
        </div>
      </div>
      <div class="actrow">
        <button class="btn sm gold" id="mb_saveplan">Aplicar módulo</button>
        <button class="btn sm ghost" id="mb_savequota">Salvar cota</button>
      </div>

      <h3 style="margin-top:14px">Situação do acesso</h3>
      <div class="actrow">
        ${isActive(l)
          ? `<button class="btn sm danger" id="mb_inactivate">Inativar (inadimplência/manual)</button>`
          : `<button class="btn sm green" id="mb_activate">Ativar acesso</button>`}
        ${l.status === "active" ? `<button class="btn sm danger" id="mb_suspend">Suspender licença</button>` : ""}
        ${l.status === "suspended" ? `<button class="btn sm green" id="mb_reactivate">Reativar licença</button>` : ""}
        ${l.status !== "revoked" ? `<button class="btn sm danger" id="mb_revoke">Revogar licença</button>` : ""}
      </div>

      <h3 style="margin-top:16px;color:#ff9aa8">Exclusão definitiva (limpeza de infraestrutura)</h3>
      <p class="small muted">Para remover licenças avulsas/de teste sem acumular ambientes. <b>Ação irreversível.</b>
        Suspender/Revogar apenas bloqueia o acesso — para apagar de vez, use abaixo.</p>
      <div class="actrow">
        <button class="btn sm danger" id="mb_dellic">Excluir só a licença</button>
        <button class="btn sm danger" id="mb_deltenant">Excluir cliente e ambiente (tudo)</button>
      </div>
      <div id="mb_out" class="small" style="margin-top:8px"></div>`;
    openModal("modalManage");

    const out = (html) => { $("#mb_out").innerHTML = html; };
    const refresh = () => { closeModal("modalManage"); loadLicenses(); };

    $("#mb_support").onclick = async () => {
      try {
        const r = await api(`/owner/tenants/${tid}/support`, { method: "POST", body: JSON.stringify({ reason: "Suporte pelo painel" }) });
        const url = r.link || `/app/?support=${encodeURIComponent(r.token)}`;
        window.open(url, "_blank", "noopener");
        out(`<span class="tag active">acesso de suporte aberto</span> em nova aba. Tudo fica registrado na auditoria.`);
      } catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_send").onclick = async () => {
      try {
        const r = await api(`/owner/licenses/${lid}/send`, { method: "POST", body: JSON.stringify({ email: false }) });
        $("#s_link").textContent = r.link || ""; $("#s_key").textContent = l.license_key; $("#s_msg").textContent = r.message || "";
        const wa = $("#s_wa"); if (r.whatsapp) { wa.href = r.whatsapp; wa.classList.remove("hide"); } else wa.classList.add("hide");
        openModal("modalSend");
      } catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_regen").onclick = async () => {
      if (!confirm("Regenerar o acesso? Um novo token de ativação será criado (o link antigo deixa de valer).")) return;
      try {
        const r = await api(`/owner/tenants/${tid}/regen`, { method: "POST" });
        $("#s_link").textContent = r.link || ""; $("#s_key").textContent = l.license_key; $("#s_msg").textContent = r.message || "";
        const wa = $("#s_wa"); if (r.whatsapp) { wa.href = r.whatsapp; wa.classList.remove("hide"); } else wa.classList.add("hide");
        openModal("modalSend"); toast("Acesso regenerado.");
      } catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_resetmfa").onclick = async () => {
      if (!confirm("Resetar o 2FA (MFA) deste cliente? Ele poderá reconfigurar no próximo login.")) return;
      try { await api(`/owner/tenants/${tid}/reset-mfa`, { method: "POST" }); out(`<span class="tag active">2FA resetado</span>`); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_resetpass").onclick = async () => {
      if (!confirm("Gerar uma senha temporária para este cliente? A senha atual deixa de valer (o 2FA continua valendo).")) return;
      try {
        const r = await api(`/owner/tenants/${tid}/reset-password`, { method: "POST" });
        const wa = r.whatsapp ? ` &nbsp;·&nbsp; <a href="${esc(r.whatsapp)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : "";
        out(`<span class="tag active">Senha redefinida</span><br>
             <div style="margin-top:6px">E-mail: <strong>${esc(r.email)}</strong><br>
             Senha temporária: <code style="font-size:14px;user-select:all">${esc(r.tempPassword)}</code></div>
             <p class="small muted" style="margin-top:6px">Anote e repasse agora — não será exibida de novo.${wa}</p>`);
      } catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_saveplan").onclick = async () => {
      try { await api(`/owner/tenants/${tid}/plan`, { method: "POST", body: JSON.stringify({ planId: $("#mb_plan").value }) }); toast("Módulo alterado."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    $("#mb_savequota").onclick = async () => {
      const v = $("#mb_quota").value.trim();
      try { await api(`/owner/tenants/${tid}/quota`, { method: "POST", body: JSON.stringify({ quota: v === "" ? null : parseInt(v, 10) }) }); toast("Cota atualizada."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    const setActive = async (active) => {
      const reason = active ? "Reativação manual pelo dono" : (prompt("Motivo da inativação (ex.: inadimplência):", "Inadimplência") || "Inativado pelo dono");
      try { await api(`/owner/tenants/${tid}/active`, { method: "POST", body: JSON.stringify({ active, reason }) }); toast(active ? "Acesso ativado." : "Acesso inativado."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    if ($("#mb_activate")) $("#mb_activate").onclick = () => setActive(true);
    if ($("#mb_inactivate")) $("#mb_inactivate").onclick = () => setActive(false);
    const licAct = async (act, msg) => {
      if (msg && !confirm(msg)) return;
      try { await api(`/owner/licenses/${lid}/${act}`, { method: "POST" }); toast("Feito."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    if ($("#mb_suspend")) $("#mb_suspend").onclick = () => licAct("suspend", "Suspender o acesso (kill-switch)?");
    if ($("#mb_reactivate")) $("#mb_reactivate").onclick = () => licAct("reactivate");
    if ($("#mb_revoke")) $("#mb_revoke").onclick = () => licAct("revoke", "Revogar definitivamente esta licença?");
    // Exclusão definitiva (limpeza). Confirmações fortes — ação irreversível.
    if ($("#mb_dellic")) $("#mb_dellic").onclick = async () => {
      if (!confirm("Excluir DEFINITIVAMENTE apenas esta licença?\n\nO cliente/ambiente é mantido. Esta ação não pode ser desfeita.")) return;
      try { await api(`/owner/licenses/${lid}/delete`, { method: "POST" }); toast("Licença excluída."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
    if ($("#mb_deltenant")) $("#mb_deltenant").onclick = async () => {
      const nm = l.tenant_name || "este cliente";
      if (!confirm(`EXCLUIR DEFINITIVAMENTE "${nm}" e TODO o ambiente?\n\nRemove licenças, clientes, documentos, chamados, assinaturas e usuários. Esta ação é IRREVERSÍVEL.`)) return;
      const typed = prompt('Para confirmar a exclusão total, digite EXCLUIR:');
      if ((typed || "").trim().toUpperCase() !== "EXCLUIR") { toast("Exclusão cancelada."); return; }
      try { await api(`/owner/tenants/${tid}/delete`, { method: "POST" }); toast("Cliente e ambiente excluídos."); refresh(); }
      catch (e) { out(`<span style="color:#ff9aa8">${esc(e.message)}</span>`); }
    };
  }

  // ===================================================================
  //  CRM — funil + contatos + campanhas
  // ===================================================================
  const CRM_STAGES = ["lead", "contato", "proposta", "ganho", "perdido", "cliente"];
  const stageLabel = { lead: "Lead", contato: "Contato", proposta: "Proposta", ganho: "Ganho", perdido: "Perdido", cliente: "Cliente" };

  async function loadCrm() {
    try {
      const [stats, contacts] = await Promise.all([api("/owner/crm/stats"), api("/owner/crm/contacts")]);
      const t = stats.totals || {};
      $("#crmKpis").innerHTML = [
        kpi(t.contacts, "Contatos", "", "", "", "crm_contacts"),
        kpi(t.clients, "Clientes (ganhos)", "green", "", "", "crm_clients"),
        kpi(stats.conversion + "%", "Conversão", "gold", "", "", "crm_conversion"),
        kpi(t.due_soon, "Follow-ups (3d)", t.due_soon ? "gold" : "", "", "", "crm_followups"),
      ].join("");
      const byStage = {}; CRM_STAGES.forEach((s) => byStage[s] = []);
      (contacts.contacts || []).forEach((c) => { (byStage[c.stage] || (byStage[c.stage] = [])).push(c); });
      $("#crmPipe").innerHTML = CRM_STAGES.map((s) => `
        <div class="pipe-col" data-stage="${s}">
          <h4>${esc(stageLabel[s])} <span class="muted">${byStage[s].length}</span></h4>
          ${byStage[s].map((c) => `
            <div class="pipe-card" data-contact="${esc(c.id)}">
              <div class="nm">${esc(c.name)}</div>
              <div class="mt">${esc(c.company || "")}${c.value_cents ? " · " + brl(c.value_cents) : ""}</div>
            </div>`).join("") || `<div class="small muted">—</div>`}
        </div>`).join("");
    } catch (e) { $("#crmPipe").innerHTML = `<div class="card" style="color:#ff9aa8">${esc(e.message)}</div>`; }
  }
  $("#crmPipe").addEventListener("click", (e) => {
    const c = e.target.closest("[data-contact]"); if (c) openContact(c.dataset.contact);
  });

  async function openContact(id) {
    $("#c_title").textContent = "Contato"; $("#c_body").innerHTML = "Carregando…"; openModal("modalCrm");
    try {
      const d = await api(`/owner/crm/contacts/${id}`);
      const c = d.contact; const acts = d.activities || [];
      $("#c_title").textContent = c.name;
      const wa = c.phone ? `https://wa.me/${digits(c.phone)}` : null;
      $("#c_body").innerHTML = `
        <div class="statline">
          <div class="it"><div class="k">Empresa</div><div class="v">${esc(c.company || "—")}</div></div>
          <div class="it"><div class="k">Estágio</div><div class="v">${esc(stageLabel[c.stage] || c.stage)}</div></div>
          <div class="it"><div class="k">Valor</div><div class="v">${c.value_cents ? brl(c.value_cents) : "—"}</div></div>
          <div class="it"><div class="k">Origem</div><div class="v">${esc(c.source || "—")}</div></div>
        </div>
        <div class="small muted">${esc(c.email || "")}${c.phone ? " · " + esc(c.phone) : ""}${c.doc ? " · " + esc(c.doc) : ""}</div>
        <div class="actrow" style="margin-top:8px">
          ${wa ? `<a class="btn sm green" target="_blank" rel="noopener" href="${wa}">WhatsApp</a>` : ""}
          ${c.email ? `<a class="btn sm ghost" href="mailto:${esc(c.email)}">E-mail</a>` : ""}
        </div>

        <h3 style="margin-top:12px">Mover no funil</h3>
        <div class="actrow">${CRM_STAGES.map((s) => `<button class="btn sm ${s === c.stage ? "gold" : "ghost"}" data-stage="${s}">${esc(stageLabel[s])}</button>`).join("")}</div>

        <h3 style="margin-top:12px">Registrar atividade</h3>
        <div class="row c2">
          <div class="field"><label>Tipo</label><select id="ca_type"><option value="nota">Nota</option><option value="ligacao">Ligação</option><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option><option value="reuniao">Reunião</option></select></div>
          <div class="field"><label>Próximo follow-up</label><input id="ca_next" type="date"></div>
        </div>
        <div class="field"><label>Descrição</label><textarea id="ca_body" rows="2" placeholder="O que foi tratado?"></textarea></div>
        <button class="btn sm gold" id="ca_add">Adicionar atividade</button>

        <h3 style="margin-top:14px">Histórico</h3>
        <div id="ca_list">${acts.map((a) => `<div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span><span class="chip">${esc(a.type)}</span> ${esc(a.body || "")}</span><span class="small muted">${dtt(a.created_at)}</span></div>`).join("") || `<p class="muted">Sem atividades.</p>`}</div>`;

      $$('#c_body [data-stage]').forEach((btn) => btn.addEventListener("click", async () => {
        try { await api(`/owner/crm/contacts/${id}/stage`, { method: "POST", body: JSON.stringify({ stage: btn.dataset.stage }) }); toast("Estágio atualizado."); openContact(id); loadCrm(); }
        catch (e) { toast(e.message); }
      }));
      $("#ca_add").onclick = async () => {
        try {
          await api(`/owner/crm/contacts/${id}/activity`, { method: "POST", body: JSON.stringify({ type: $("#ca_type").value, body: $("#ca_body").value.trim(), nextActionAt: $("#ca_next").value || null }) });
          toast("Atividade registrada."); openContact(id);
        } catch (e) { toast(e.message); }
      };
    } catch (e) { $("#c_body").innerHTML = `<span style="color:#ff9aa8">${esc(e.message)}</span>`; }
  }

  $("#btnNewContact").addEventListener("click", async () => {
    await ensurePlans();
    $("#g_title").textContent = "Novo contato (CRM)";
    $("#g_body").innerHTML = `
      <div class="row c2">
        <div class="field"><label>Nome *</label><input id="g_name"></div>
        <div class="field"><label>Empresa</label><input id="g_company"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>E-mail</label><input id="g_email" type="email"></div>
        <div class="field"><label>WhatsApp</label><input id="g_phone"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Estágio</label><select id="g_stage">${CRM_STAGES.map((s) => `<option value="${s}">${esc(stageLabel[s])}</option>`).join("")}</select></div>
        <div class="field"><label>Módulo de interesse</label><select id="g_plan"><option value="">—</option>${PLANS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label>Observações</label><textarea id="g_notes" rows="2"></textarea></div>
      <button class="btn gold block" id="g_save">Adicionar ao funil</button>`;
    openModal("modalGeneric");
    $("#g_save").onclick = async () => {
      const name = $("#g_name").value.trim(); if (!name) { toast("Informe o nome."); return; }
      try {
        await api("/owner/crm/contacts", { method: "POST", body: JSON.stringify({
          name, company: $("#g_company").value.trim(), email: $("#g_email").value.trim(), phone: $("#g_phone").value.trim(),
          stage: $("#g_stage").value, planInterest: $("#g_plan").value || null, notes: $("#g_notes").value.trim() }) });
        toast("Contato adicionado."); closeModal("modalGeneric"); loadCrm();
      } catch (e) { toast(e.message); }
    };
  });

  // Campanhas
  $("#btnCampaigns").addEventListener("click", openCampaigns);
  async function openCampaigns() {
    $("#camp_body").innerHTML = "Carregando…"; openModal("modalCamp");
    try {
      const d = await api("/owner/crm/campaigns");
      const list = (d.campaigns || []).map((c) => `<div class="flex between" style="padding:8px 0;border-bottom:1px solid var(--line)">
        <span><b>${esc(c.name)}</b> <span class="chip">${esc(c.channel)}</span> <span class="chip">${esc(c.audience)}</span></span>
        <span>${c.status === "enviada" ? `<span class="tag active">enviada · ${c.sent_count}</span>` : `<button class="btn sm gold" data-send="${esc(c.id)}">Disparar</button>`}</span>
      </div>`).join("") || `<p class="muted">Nenhuma campanha ainda.</p>`;
      $("#camp_body").innerHTML = `
        <h3>Nova campanha</h3>
        <div class="row c2">
          <div class="field"><label>Nome *</label><input id="cp_name" placeholder="Renovação trimestral"></div>
          <div class="field"><label>Canal</label><select id="cp_channel"><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></select></div>
        </div>
        <div class="field"><label>Público</label><select id="cp_aud"><option value="todos">Todos os contatos</option>${CRM_STAGES.map((s) => `<option value="${s}">${esc(stageLabel[s])}</option>`).join("")}</select></div>
        <div class="field"><label>Mensagem (use {nome} e {empresa})</label><textarea id="cp_msg" rows="3" placeholder="Olá {nome}, temos uma novidade para a {empresa}…"></textarea></div>
        <button class="btn gold block" id="cp_create">Criar campanha</button>
        <h3 style="margin-top:16px">Campanhas</h3>
        <div id="cp_list">${list}</div>
        <div id="cp_recipients"></div>`;
      $("#cp_create").onclick = async () => {
        const name = $("#cp_name").value.trim(), msg = $("#cp_msg").value.trim();
        if (!name || !msg) { toast("Informe nome e mensagem."); return; }
        try { await api("/owner/crm/campaigns", { method: "POST", body: JSON.stringify({ name, channel: $("#cp_channel").value, audience: $("#cp_aud").value, message: msg }) }); toast("Campanha criada."); openCampaigns(); }
        catch (e) { toast(e.message); }
      };
      $$('#cp_list [data-send]').forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("Disparar a campanha? Serão gerados os links de envio para cada contato.")) return;
        try {
          const r = await api(`/owner/crm/campaigns/${b.dataset.send}/send`, { method: "POST" });
          const recs = r.recipients || [];
          $("#cp_recipients").innerHTML = `<h3 style="margin-top:14px">Enviar (${recs.length})</h3>` + (recs.map((x) =>
            `<div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(x.name)}</span><span class="actrow" style="margin:0">${x.whatsapp ? `<a class="btn sm green" target="_blank" rel="noopener" href="${esc(x.whatsapp)}">WhatsApp</a>` : ""}${x.mailto ? `<a class="btn sm ghost" href="${esc(x.mailto)}">E-mail</a>` : ""}</span></div>`).join("") || `<p class="muted">Nenhum contato elegível.</p>`);
          toast("Campanha pronta para envio.");
        } catch (e) { toast(e.message); }
      }));
    } catch (e) { $("#camp_body").innerHTML = `<span style="color:#ff9aa8">${esc(e.message)}</span>`; }
  }

  // ===================================================================
  //  FINANCEIRO
  // ===================================================================
  async function loadPayments() {
    const tb = $("#payRows");
    try {
      const d = await api("/owner/payments");
      const rows = d.payments || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">Sem pagamentos.</td></tr>`; return; }
      tb.innerHTML = rows.map((p) => `<tr>
        <td>${dt(p.created_at)}</td>
        <td>${esc(p.tenant_name)}</td>
        <td>${esc(p.method || "—")}</td>
        <td>${brl(p.amount_cents)}</td>
        <td>${tag(p.status === "approved" || p.status === "paid" ? "active" : p.status)}</td>
        <td style="text-align:right">${(p.status === "approved" || p.status === "paid") ? `<button class="btn sm ghost" data-inv="${p.id}">Emitir NFS-e</button>` : "—"}</td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#payRows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-inv]"); if (!b) return;
    try { await api(`/owner/payments/${b.dataset.inv}/invoice`, { method: "POST" }); toast("NFS-e em emissão."); }
    catch (err) { toast(err.message); }
  });

  // ===================================================================
  //  SUPORTE — Service Desk (fila + SLA + status + resposta + dashboards)
  // ===================================================================
  const SUP_CAT = { acesso: "Acesso / login / senha", licenca: "Licença / cobrança / upgrade",
    clientes: "Cadastro de clientes / cota", documentos: "Documentos / modelos / relatórios",
    questionario: "Assistente de adequação / questionários", incidentes: "Incidentes / titulares",
    treinamento: "Treinamentos / cursos", bug: "Erro / comportamento inesperado",
    duvida: "Dúvida de uso", sugestao: "Sugestão / melhoria", outro: "Outro" };
  const SUP_ST = { aberto: "Aberto", em_andamento: "Em andamento", aguardando_cliente: "Aguardando cliente",
    resolvido: "Resolvido", fechado: "Fechado" };
  const SUP_ST_TAG = { aberto: "suspended", em_andamento: "pending", aguardando_cliente: "grace",
    resolvido: "active", fechado: "active" };
  const SUP_PR = { baixa: "Baixa", normal: "Normal", alta: "Alta", urgente: "Urgente" };
  const SUP_PR_TAG = { baixa: "grace", normal: "pending", alta: "pending", urgente: "suspended" };
  const SUP_SLA = { urgente: 4, alta: 8, normal: 24, baixa: 48 };
  const supCat = (id) => SUP_CAT[id] || id || "Outro";
  function supSla(t) {
    // Retorna {txt, cls} do SLA de 1ª resposta. Respondido → ok; senão prazo restante/estouro.
    if (t.first_response_at) return { txt: "1ª resp. OK", cls: "ok" };
    if (["resolvido", "fechado"].includes(t.status)) return { txt: "—", cls: "" };
    const hours = SUP_SLA[t.priority] != null ? SUP_SLA[t.priority] : 24;
    const due = new Date(t.created_at).getTime() + hours * 3600 * 1000;
    const diffMs = due - Date.now();
    const h = Math.floor(Math.abs(diffMs) / 3600000), m = Math.floor((Math.abs(diffMs) % 3600000) / 60000);
    const hm = (h ? h + "h" : "") + m + "min";
    return diffMs < 0 ? { txt: "estourado há " + hm, cls: "bad" } : { txt: "faltam " + hm, cls: "warn" };
  }
  const slaPill = (s) => {
    const color = s.cls === "bad" ? "#ff6b81" : s.cls === "warn" ? "#f0b429" : s.cls === "ok" ? "#37b24d" : "#8a93a3";
    const bg = s.cls === "bad" ? "rgba(255,107,129,.14)" : s.cls === "warn" ? "rgba(240,180,41,.14)" : s.cls === "ok" ? "rgba(55,178,77,.14)" : "rgba(138,147,163,.12)";
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:${color};background:${bg}">${esc(s.txt)}</span>`;
  };
  // Um chamado "aguarda o suporte" quando a última ação foi do cliente e ele não
  // está resolvido/fechado (novo chamado ou nova resposta do cliente).
  function supNeedsReply(t) {
    return t.last_actor === "cliente" && !["resolvido", "fechado"].includes(t.status);
  }
  // ---- Alerta de novos chamados (badge no menu + som + toast) ----
  let SUP_BADGE_N = -1;        // último valor conhecido (para detectar aumento)
  let SUP_ALERT_READY = false; // evita tocar som/toast no 1º carregamento da sessão
  function supSetBadge(n) {
    const b = $("#supNavBadge"); if (!b) return;
    n = +n || 0;
    if (n > 0) { b.textContent = n > 99 ? "99+" : String(n); b.hidden = false; b.classList.add("pulse"); }
    else { b.hidden = true; b.classList.remove("pulse"); }
    SUP_BADGE_N = n;
  }
  function supBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      o.start(); o.stop(ctx.currentTime + 0.33);
      o.onended = () => { try { ctx.close(); } catch (_) {} };
    } catch (_) {}
  }
  // Notifica o sistema operacional (se o dono autorizar) — best-practice de service desk.
  function supNotifyOS(n) {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") {
        new Notification("Novo chamado de suporte", { body: n + " chamado(s) aguardando sua resposta.", tag: "dpo-support" });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().catch(() => {});
      }
    } catch (_) {}
  }
  async function supPoll() {
    try {
      const s = await api("/owner/support/stats");
      const t = s.totals || {};
      const needs = t.needs_reply != null ? t.needs_reply : t.unanswered || 0;
      const prev = SUP_BADGE_N;
      supSetBadge(needs);
      if (SUP_ALERT_READY && needs > prev && prev >= 0) {
        toast("🛟 Novo chamado de suporte na fila (" + needs + " a responder).");
        supBeep(); supNotifyOS(needs);
      }
      SUP_ALERT_READY = true;
    } catch (_) { /* silencioso: alerta nunca derruba o painel */ }
  }
  let SUP_LAST_FILTER = "abertos";
  async function loadSupport() {
    const tb = $("#supRows");
    const sel = $("#supFilter"); if (sel) sel.value = SUP_LAST_FILTER;
    // --- Dashboards (stats) ---
    try {
      const s = await api("/owner/support/stats");
      const t = s.totals || {};
      const needs = t.needs_reply != null ? t.needs_reply : t.unanswered || 0;
      $("#supKpis").innerHTML = [
        kpi(needs, "Aguardando sua resposta", needs ? "gold" : "green", "chamados a responder", "", "sup_needs"),
        kpi(t.open, "Em aberto (fila)", t.open ? "" : "green", "em atendimento", "", "sup_open"),
        kpi(s.breaching, "SLA estourado", s.breaching ? "r" : "green", "fora do prazo de 1ª resp.", "", "sup_sla"),
        kpi((s.avgFirstResponseHours || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "h", "Tempo médio 1ª resp.", "", "chamados respondidos", "", "sup_avg"),
        kpi(t.total, "Total de chamados", "", `${t.last7 || 0} nos últimos 7 dias`, "", "sup_total"),
      ].join("");
      supSetBadge(needs);
      const bs = s.byStatus || {};
      const totS = Math.max(1, Object.values(bs).reduce((a, b) => a + b, 0));
      $("#supByStatus").innerHTML = Object.keys(SUP_ST).map((k) =>
        `<div class="hbar"><div class="lbl"><span>${esc(SUP_ST[k])}</span><b>${bs[k] || 0}</b></div>
         <div class="track"><div class="fill ${["resolvido", "fechado"].includes(k) ? "g" : k === "aberto" ? "r" : ""}" style="width:${Math.round(((bs[k] || 0) / totS) * 100)}%"></div></div></div>`).join("");
      const bp = s.byPriority || {};
      const totP = Math.max(1, Object.values(bp).reduce((a, b) => a + b, 0));
      $("#supByPriority").innerHTML = ["urgente", "alta", "normal", "baixa"].map((k) =>
        `<div class="hbar"><div class="lbl"><span>${esc(SUP_PR[k])} <span class="muted">(SLA ${SUP_SLA[k]}h)</span></span><b>${bp[k] || 0}</b></div>
         <div class="track"><div class="fill ${k === "urgente" ? "r" : ""}" style="width:${Math.round(((bp[k] || 0) / totP) * 100)}%"></div></div></div>`).join("");
    } catch (e) {
      $("#supKpis").innerHTML = `<div style="color:#ff9aa8">${esc(e.message)}</div>`;
    }
    // --- Fila de chamados ---
    try {
      const f = SUP_LAST_FILTER;
      const q = f === "abertos" ? "?open=1" : f === "todos" ? "" : "?status=" + encodeURIComponent(f);
      const d = await api("/owner/support/tickets" + q);
      const rows = d.tickets || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="9" class="muted">Nenhum chamado nesta visão.</td></tr>`; return; }
      tb.innerHTML = rows.map((t) => {
        const sla = supSla(t);
        const need = supNeedsReply(t);
        const flag = need
          ? ` <span class="sup-pill-new">● Novo / responder</span>`
          : (t.status === "aguardando_cliente" ? ` <span class="sup-pill-wait">aguardando cliente</span>` : "");
        // Identificação de ORIGEM: consultoria (licença) + cliente atendido (se houver).
        const origin = t.origin === "cliente" && (t.client_name || t.client_ref)
          ? `<div class="small" style="color:#c9a227">🏢 Cliente: ${esc(t.client_name || t.client_ref)}${t.client_cnpj ? ` · ${esc(t.client_cnpj)}` : ""}</div>`
          : `<div class="small muted">Assunto da consultoria</div>`;
        return `<tr class="${need ? "sup-need" : ""}">
          <td><b>#${esc(t.ticket_no)}</b></td>
          <td class="small">${dtt(t.created_at)}</td>
          <td>${slaPill(sla)}</td>
          <td class="small">${esc(t.opener_name || t.opener_email || "—")}
            <div class="small muted">${esc(t.tenant_name || "Consultoria")}</div>${origin}</td>
          <td>${esc(t.subject)}${t.has_attachment ? ' <span title="tem anexo">📎</span>' : ""}${flag}</td>
          <td class="small muted">${esc(supCat(t.category))}</td>
          <td><span class="tag ${SUP_PR_TAG[t.priority] || "grace"}">${esc(SUP_PR[t.priority] || t.priority)}</span></td>
          <td><span class="tag ${SUP_ST_TAG[t.status] || "grace"}">${esc(SUP_ST[t.status] || t.status)}</span></td>
          <td style="text-align:right"><button class="btn sm gold" data-tk="${esc(t.id)}">Abrir / responder</button></td>
        </tr>`;
      }).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="9" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  const _supFilterEl = $("#supFilter");
  if (_supFilterEl) _supFilterEl.addEventListener("change", () => { SUP_LAST_FILTER = _supFilterEl.value; loadSupport(); });
  const _supRefresh = $("#btnSupRefresh");
  if (_supRefresh) _supRefresh.addEventListener("click", loadSupport);
  $("#supRows").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tk]"); if (!b) return;
    openTicket(b.getAttribute("data-tk"));
  });

  async function openTicket(id) {
    openModal("modalTicket");
    $("#tk_title").textContent = "Chamado";
    $("#tk_body").innerHTML = `<p class="muted">Carregando…</p>`;
    let d;
    try { d = await api("/owner/support/tickets/" + encodeURIComponent(id)); }
    catch (e) { $("#tk_body").innerHTML = `<p style="color:#ff9aa8">${esc(e.message)}</p>`; return; }
    const t = d.ticket || {}, msgs = d.messages || [];
    $("#tk_title").textContent = "Chamado #" + (t.ticket_no || "") + " — " + (t.subject || "");
    const sla = supSla(t);
    const thread = msgs.map((m) => {
      const sup = m.author_role === "suporte";
      const attBtn = m.has_attachment
        ? `<div style="margin-top:7px"><button class="btn sm ghost" data-matt="${esc(m.id)}">📎 Baixar anexo (${esc(m.attachment_name || "arquivo")})</button></div>`
        : "";
      return `<div style="display:flex;${sup ? "justify-content:flex-end" : ""};margin:8px 0">
        <div style="max-width:80%;background:${sup ? "rgba(212,160,23,.12)" : "rgba(255,255,255,.04)"};border:1px solid ${sup ? "rgba(212,160,23,.35)" : "rgba(255,255,255,.10)"};border-radius:12px;padding:10px 12px">
          <div class="small muted" style="margin-bottom:3px">${sup ? "Suporte" : "Cliente"} · ${esc(m.author_name || m.author_email || "")} · ${dtt(m.created_at)}</div>
          <div style="white-space:pre-wrap;line-height:1.5">${esc(m.body || "")}</div>
          ${attBtn}
        </div></div>`;
    }).join("");
    const stOpts = Object.keys(SUP_ST).map((k) => `<option value="${k}"${t.status === k ? " selected" : ""}>${esc(SUP_ST[k])}</option>`).join("");
    const prOpts = Object.keys(SUP_PR).map((k) => `<option value="${k}"${t.priority === k ? " selected" : ""}>${esc(SUP_PR[k])}</option>`).join("");
    $("#tk_body").innerHTML = `
      <div class="row c2" style="gap:10px;margin-bottom:6px">
        <div class="card" style="margin:0">
          <div class="small muted">Solicitante</div><div><b>${esc(t.opener_name || "—")}</b></div>
          <div class="small">${esc(t.opener_email || "—")}</div>
          <div class="small muted" style="margin-top:6px">Consultoria (licença)</div><div class="small">${esc(t.tenant_name || "—")}</div>
          <div class="small muted" style="margin-top:6px">Origem do chamado</div>
          <div class="small">${t.origin === "cliente" && (t.client_name || t.client_ref)
            ? `<span style="color:#c9a227">🏢 Cliente: <b>${esc(t.client_name || t.client_ref)}</b></span>${t.client_cnpj ? `<br><span class="muted">CNPJ ${esc(t.client_cnpj)}</span>` : ""}`
            : "Assunto da própria consultoria / plataforma"}</div>
          <div class="small muted" style="margin-top:6px">Categoria</div><div class="small">${esc(supCat(t.category))}</div>
        </div>
        <div class="card" style="margin:0">
          <div class="small muted">Aberto em</div><div class="small">${dtt(t.created_at)}</div>
          <div class="small muted" style="margin-top:6px">SLA de 1ª resposta</div><div>${slaPill(sla)}</div>
          ${t.has_attachment ? `<div style="margin-top:8px"><button class="btn sm ghost" id="tk_att">📎 Baixar anexo (${esc(t.attachment_name || "arquivo")})</button></div>` : ""}
        </div>
      </div>
      <h3 style="margin:14px 0 4px">Conversa</h3>
      <div id="tk_thread" style="max-height:300px;overflow:auto;padding:2px;background:rgba(0,0,0,.12);border-radius:10px">${thread || '<p class="muted" style="padding:10px">Sem mensagens.</p>'}</div>
      <h3 style="margin:14px 0 4px">Responder ao cliente</h3>
      <textarea id="tk_reply" rows="4" placeholder="Escreva a resposta enviada ao solicitante (vai por e-mail e fica no histórico)…"></textarea>
      <div class="field" style="margin-top:8px"><label>Anexo (opcional · até 2 MB)</label><input type="file" id="tk_file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.log"></div>
      <div class="row c2" style="gap:10px;margin-top:8px">
        <div class="field"><label>Status após resposta</label><select id="tk_repst">${Object.keys(SUP_ST).map((k) => `<option value="${k}"${k === "aguardando_cliente" ? " selected" : ""}>${esc(SUP_ST[k])}</option>`).join("")}</select></div>
        <div class="field" style="display:flex;align-items:flex-end"><button class="btn gold block" id="tk_send">Enviar resposta</button></div>
      </div>
      <hr style="border-color:rgba(255,255,255,.08);margin:14px 0">
      <div class="row c2" style="gap:10px">
        <div class="field"><label>Status</label><select id="tk_status">${stOpts}</select></div>
        <div class="field"><label>Prioridade</label><select id="tk_prio">${prOpts}</select></div>
      </div>
      <button class="btn ghost sm" id="tk_save" style="margin-top:6px">Salvar status/prioridade</button>`;
    const th = $("#tk_thread"); if (th) th.scrollTop = th.scrollHeight;
    // Baixar anexo via data-URL (helper compartilhado p/ chamado e mensagens).
    const dlAttachment = async (a) => {
      const link = document.createElement("a");
      link.href = "data:" + (a.type || "application/octet-stream") + ";base64," + a.data;
      link.download = a.name || "anexo"; document.body.appendChild(link); link.click(); link.remove();
    };
    const att = $("#tk_att");
    if (att) att.onclick = async () => {
      try { await dlAttachment(await api("/owner/support/tickets/" + encodeURIComponent(id) + "/attachment")); }
      catch (e) { toast(e.message); }
    };
    // Anexos individuais de cada mensagem da conversa.
    ($("#tk_thread") || document).querySelectorAll("[data-matt]").forEach((b) => {
      b.onclick = async () => {
        try { await dlAttachment(await api("/owner/support/tickets/" + encodeURIComponent(id) + "/messages/" + encodeURIComponent(b.getAttribute("data-matt")) + "/attachment")); }
        catch (e) { toast(e.message); }
      };
    });
    $("#tk_send").onclick = async () => {
      const body = ($("#tk_reply").value || "").trim();
      if (!body) return toast("Escreva a resposta.");
      const btn = $("#tk_send"); btn.disabled = true;
      try {
        let attachment = null;
        const fEl = $("#tk_file"); const f = fEl && fEl.files && fEl.files[0];
        if (f) {
          if (f.size > 2 * 1024 * 1024) { btn.disabled = false; return toast("Anexo acima de 2 MB. Escolha um arquivo menor."); }
          attachment = { name: f.name, type: f.type || "application/octet-stream", data: await fileToB64(f) };
        }
        await api("/owner/support/tickets/" + encodeURIComponent(id) + "/reply", { method: "POST", body: JSON.stringify({ body, status: $("#tk_repst").value, attachment }) });
        toast("Resposta enviada ao cliente."); openTicket(id); loadSupport();
      } catch (e) { btn.disabled = false; toast(e.message); }
    };
    $("#tk_save").onclick = async () => {
      const btn = $("#tk_save"); btn.disabled = true;
      try {
        await api("/owner/support/tickets/" + encodeURIComponent(id) + "/status", { method: "POST", body: JSON.stringify({ status: $("#tk_status").value, priority: $("#tk_prio").value }) });
        toast("Chamado atualizado."); openTicket(id); loadSupport();
      } catch (e) { btn.disabled = false; toast(e.message); }
    };
  }

  // ===================================================================
  //  INTEGRAÇÕES (NFS-e + status de pagamentos/avisos)
  // ===================================================================
  let NFSE_HAS_TOKEN = false;
  async function loadIntegrations() {
    try {
      const d = await api("/owner/integrations");
      const n = d.nfse || {};
      NFSE_HAS_TOKEN = !!n.enabled;
      const f = n.fields || {};
      // Badge de status
      const badge = $("#nfseBadge");
      if (badge) {
        if (n.ready) { badge.className = "tag active"; badge.textContent = `Pronta · ${n.env === "producao" ? "Produção" : "Homologação"}${n.auto ? " · auto" : ""}`; }
        else if (n.enabled) { badge.className = "tag pending"; badge.textContent = "Falta configurar dados"; }
        else { badge.className = "tag grace"; badge.textContent = "Não configurada"; }
      }
      // Preenche os campos
      const set = (id, v) => { const el = $("#" + id); if (el != null && v != null) el.value = v; };
      set("nf_env", n.env || "homologacao");
      set("nf_cnpj", f.cnpj || "");
      set("nf_im", f.im || "");
      set("nf_municipio", f.municipio || "");
      set("nf_item", f.item || "1.07");
      set("nf_codtrib", f.codigoTributario || "");
      set("nf_aliquota", f.aliquota != null ? f.aliquota : "0.02");
      set("nf_regime", f.regimeEspecial || "");
      set("nf_simples", String(f.optanteSimples) === "false" ? "false" : "true");
      set("nf_auto", n.auto ? "true" : "false");
      const hint = $("#nf_token_hint");
      if (hint) hint.textContent = n.tokenMasked ? `Token atual: ${n.tokenMasked} (deixe em branco para manter)` : "Nenhum token salvo.";
      const tok = $("#nf_token"); if (tok) tok.value = "";
      // Bloco de demais integrações (somente leitura, vem do dashboard)
      try {
        const dash = await api("/owner/dashboard");
        const gws = (dash.gateways || []);
        const chip = (label, on) => `<span class="tag ${on ? "active" : "grace"}" style="margin:2px 4px 2px 0">${esc(label)}: ${on ? "ativo" : "—"}</span>`;
        const names = { mercadopago: "Mercado Pago", stripe: "Stripe", pagarme: "Pagar.me" };
        const all = ["mercadopago", "stripe", "pagarme"];
        $("#integOthers").innerHTML =
          `<div style="margin-bottom:6px"><b>Gateways de pagamento</b></div>` +
          all.map((g) => chip(names[g] || g, gws.includes(g))).join("") +
          `<div class="small muted" style="margin-top:10px">Os gateways e os canais de aviso (e-mail/WhatsApp) são definidos por variável de ambiente no servidor. A NFS-e acima pode ser ajustada direto por aqui.</div>`;
      } catch (_) { $("#integOthers").innerHTML = `<span class="muted">—</span>`; }
    } catch (e) {
      const m = $("#nfseMsg"); if (m) { m.style.color = "#ff9aa8"; m.textContent = e.message; }
    }
  }
  function nfsePayload() {
    const v = (id) => { const el = $("#" + id); return el ? el.value.trim() : ""; };
    const p = {
      env: v("nf_env"), cnpj: v("nf_cnpj"), im: v("nf_im"), municipio: v("nf_municipio"),
      item: v("nf_item"), codigoTributario: v("nf_codtrib"), aliquota: v("nf_aliquota"),
      regimeEspecial: v("nf_regime"), optanteSimples: v("nf_simples") === "true", auto: v("nf_auto") === "true",
    };
    const tk = v("nf_token"); if (tk) p.token = tk;   // só envia se preenchido
    return p;
  }
  function nfseMsg(text, ok) { const m = $("#nfseMsg"); if (!m) return; m.style.color = ok ? "#8fe6a0" : "#ff9aa8"; m.textContent = text || ""; }
  (function wireIntegrations() {
    const save = $("#btnNfseSave");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true; nfseMsg("Salvando…", true);
      try { await api("/owner/integrations/nfse", { method: "POST", body: JSON.stringify(nfsePayload()) }); nfseMsg("Configuração salva.", true); toast("NFS-e salva."); await loadIntegrations(); }
      catch (e) { nfseMsg(e.message, false); }
      finally { save.disabled = false; }
    });
    const test = $("#btnNfseTest");
    if (test) test.addEventListener("click", async () => {
      test.disabled = true; nfseMsg("Validando…", true);
      try { const r = await api("/owner/integrations/nfse/test", { method: "POST", body: JSON.stringify({}) }); nfseMsg(r.message || "Configuração válida.", true); }
      catch (e) { nfseMsg(e.message, false); }
      finally { test.disabled = false; }
    });
    const clr = $("#btnNfseClearToken");
    if (clr) clr.addEventListener("click", async () => {
      if (!confirm("Remover o token salvo? A emissão volta a usar a variável de ambiente (se houver).")) return;
      clr.disabled = true;
      try { await api("/owner/integrations/nfse", { method: "POST", body: JSON.stringify({ token: "", clearToken: true }) }); toast("Token removido."); await loadIntegrations(); }
      catch (e) { nfseMsg(e.message, false); }
      finally { clr.disabled = false; }
    });
  })();

  // ===================================================================
  //  AUDITORIA (trilha completa)
  // ===================================================================
  const ACTION_LABELS = {
    login: "Login", login_locked: "Conta bloqueada (tentativas)", owner_bootstrap: "Senha do dono definida",
    owner_bootstrap_denied: "Recuperação do dono negada (token inválido)", password_reset_by_support: "Senha redefinida (suporte)",
    checkout_created: "Compra (checkout)", license_issued: "Licença emitida", license_issued_from_purchase: "Licença gerada da compra",
    license_activated: "Licença ativada", plan_changed: "Módulo alterado", tenant_created: "Assinante criado",
    tenant_inactivated: "Cliente inativado", tenant_reactivated: "Cliente reativado",
    support_access: "Acesso de suporte", access_regenerated: "Acesso regenerado", mfa_reset_by_support: "2FA resetado (suporte)",
    mfa_enabled: "2FA ativado", mfa_disabled: "2FA desativado", demo_generated: "Demo recriada",
    crm_contact_created: "Contato criado (CRM)", crm_stage_changed: "Estágio movido (CRM)",
    crm_campaign_created: "Campanha criada", crm_campaign_sent: "Campanha disparada", client_created: "Cliente cadastrado",
  };
  function actionLabel(a) { return ACTION_LABELS[a] || a; }
  function evTag(e) {
    if (["activated", "reactivated", "issued", "login", "tenant_reactivated"].includes(e)) return "active";
    if (["suspended", "revoked", "expired", "login_locked", "tenant_inactivated"].includes(e)) return "suspended";
    if (["upgraded", "downgraded", "quota_changed", "sent", "support_access"].includes(e)) return "pending";
    return "grace";
  }
  // Resumo "humano" do dispositivo a partir do user-agent (para a coluna Origem).
  function deviceLabel(ua) {
    if (!ua) return "";
    let os = /Windows/i.test(ua) ? "Windows" : /Macintosh|Mac OS/i.test(ua) ? "macOS" :
      /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Linux/i.test(ua) ? "Linux" : "";
    let br = /Edg\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /Chrome/i.test(ua) ? "Chrome" :
      /Safari/i.test(ua) ? "Safari" : /Firefox/i.test(ua) ? "Firefox" : "";
    return [br, os].filter(Boolean).join(" · ");
  }
  // Coluna Origem: local (cidade/UF/país) + IP + dispositivo.
  function originCell(ev) {
    const local = ev.geo_label ? `<div>📍 ${esc(ev.geo_label)}</div>` : "";
    const ip = ev.ip ? `<div class="muted">IP ${esc(ev.ip)}</div>` : "";
    const dev = ev.user_agent ? `<div class="muted">${esc(deviceLabel(ev.user_agent))}</div>` : "";
    const out = local + ip + dev;
    return out || `<span class="muted">—</span>`;
  }
  // Renderiza os últimos 15 registros no painel de Auditoria (rodapé do Painel).
  async function loadAudit() {
    const tb = $("#auditRows");
    if (!tb) return;
    try {
      const d = await api("/owner/audit?limit=15");
      const rows = (d.events || []).slice(0, 15);
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">Sem eventos.</td></tr>`; return; }
      tb.innerHTML = rows.map((ev) => `<tr>
        <td class="small">${dtt(ev.created_at)}</td>
        <td><span class="tag ${evTag(ev.action)}">${esc(actionLabel(ev.action))}</span><div class="small muted">${esc(ev.kind === "license" ? "licença" : "admin")}</div></td>
        <td class="small">${esc(ev.actor_email || "system")}</td>
        <td class="small">${originCell(ev)}</td>
        <td class="small muted">${esc(ev.detail || "")}</td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }

  // ---------- boot ----------
  $("#verBadge").textContent = "v" + PLATFORM_VERSION;
  show("dashboard");
  // Service desk: alerta de novos chamados em qualquer aba (badge no menu + som).
  supPoll();
  setInterval(() => { if (!document.hidden) supPoll(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) supPoll(); });

  // ---------- trava por inatividade (re-login) — desktop + mobile ----------
  // Apos um periodo parado, encerra a sessao do dono e bloqueia a tela pedindo
  // novo login. Comparacao por timestamp (robusto a suspensao do aparelho).
  (function idleGuard() {
    const IDLE_MS = 20 * 60 * 1000; // 20 minutos parado
    let last = Date.now(), fired = false;
    const bump = () => { last = Date.now(); };
    ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click", "wheel"]
      .forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    function expire() {
      if (fired) return; fired = true;
      try { localStorage.removeItem("dpo_token"); localStorage.removeItem("dpo_user"); } catch (_) {}
      const ov = document.createElement("div");
      ov.id = "idle-lock";
      ov.setAttribute("style", "position:fixed;inset:0;z-index:100000;background:rgba(4,8,16,.92);display:flex;align-items:center;justify-content:center;padding:18px");
      ov.innerHTML = '<div style="max-width:430px;text-align:center;background:#0c1c34;border:1px solid rgba(217,164,65,.4);border-radius:16px;padding:30px 26px;font-family:inherit">'
        + '<div style="font-size:42px;line-height:1">🔒</div>'
        + '<h2 style="margin:10px 0 6px;color:#fff;font-size:20px">Sessão encerrada por inatividade</h2>'
        + '<p style="margin:0 0 18px;color:#9fb2cc;font-size:14px;line-height:1.6">Por segurança, você ficou muito tempo parado. Faça login novamente para continuar.</p>'
        + '<a href="/?next=/painel" style="display:inline-block;background:linear-gradient(135deg,#d9a441,#e9c46a);color:#1a1205;font-weight:800;border-radius:10px;padding:11px 24px;text-decoration:none;font-size:14px">Entrar novamente</a>'
        + '</div>';
      document.body.appendChild(ov);
    }
    setInterval(() => { if (Date.now() - last > IDLE_MS) expire(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - last > IDLE_MS) expire(); });
  })();
})();

/* Painel do Dono — DPO PJ Protection (v2)
   Área negocial: dashboard interativo, Compras (gera licença do módulo em 1 clique),
   Licenças & assinantes (status, upgrade/downgrade, suporte/acesso ao ambiente),
   CRM (funil + campanhas) e auditoria completa. */
(function () {
  "use strict";

  const PLATFORM_VERSION = "2.2.0";
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
    sec_audit: { t: "Auditoria", b: "Trilha completa e imutável: licenças, suporte, segurança e ações administrativas. Cada licença tem um número de versão que incrementa a cada mudança de estado.", goto: "audit", gl: "Abrir Auditoria" },
    dash_revenue: { t: "Receita aprovada", b: "Soma dos pagamentos aprovados nos últimos 6 meses, mês a mês. Use para acompanhar a evolução do faturamento.", goto: "payments", gl: "Ver Financeiro" },
    dash_licstatus: { t: "Status das licenças", b: "Distribuição das licenças por situação (ativa, emitida, suspensa, etc.). Verde indica saudável; vermelho indica que exige atenção.", goto: "licenses", gl: "Ver Licenças" },
    dash_funnel: { t: "Funil de vendas (CRM)", b: "Quantidade e valor de oportunidades em cada estágio do funil. Trabalhe os estágios no CRM para aumentar a conversão.", goto: "crm", gl: "Abrir CRM" },
    dash_modules: { t: "Distribuição por módulo & integrações", b: "Quantos assinantes e quanta receita cada módulo gera, além do status das integrações de pagamento e de NFS-e.", goto: "licenses", gl: "Ver Licenças" },
    dash_overdue: { t: "Vencimentos & atrasos", b: "Clientes vencendo nos próximos 7 dias ou já atrasados. Use o botão “Cobrar” para abrir o WhatsApp com a mensagem pronta. Bloqueios por inadimplência são automáticos.", goto: "licenses", gl: "Ver Licenças" },
    dash_recent: { t: "Atividade recente", b: "Últimos eventos do sistema. O registro completo e imutável fica na aba Auditoria.", goto: "audit", gl: "Ver Auditoria" },
  };
  function openInfo(key) {
    const i = INFO[key]; if (!i) return;
    $("#g_title").textContent = i.t;
    $("#g_body").innerHTML =
      `<p class="muted" style="line-height:1.65;font-size:14px">${esc(i.b)}</p>` +
      (i.goto ? `<button class="btn gold block" id="g_goto" style="margin-top:16px">${esc(i.gl || "Ir para a área")} →</button>` : "");
    openModal("modalGeneric");
    const g = $("#g_goto");
    if (g) g.onclick = () => { closeModal("modalGeneric"); navTo(i.goto); };
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
      crm: loadCrm, payments: loadPayments, audit: loadAudit }[view] || (() => {}))();
  }

  // ===================================================================
  //  DASHBOARD (interativo)
  // ===================================================================
  const kpi = (v, l, cls = "", sub = "", goto = "") =>
    `<div class="kpi ${goto ? "click" : ""}" ${goto ? `data-goto="${goto}"` : ""}>
       <div class="v ${cls}">${v ?? 0}</div><div class="l">${esc(l)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;

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
      $("#integ").innerHTML =
        `<div>Pagamento: ${gws.length ? gws.map((g) => `<span class="tag active" style="text-transform:capitalize">${esc(g)}</span>`).join(" ") : '<span class="tag grace">manual (sem gateway)</span>'}</div>` +
        `<div style="margin-top:8px">NFS-e: ${d.nfseEnabled ? '<span class="tag active">ativa</span>' : '<span class="tag pending">não configurada</span>'}</div>`;

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
  async function openEmitir() {
    await ensurePlans();
    $("#e_plan").innerHTML = PLANS.map((p) => {
      const q = p.client_quota == null ? "ilimitado" : p.client_quota + " clientes";
      return `<option value="${esc(p.id)}">${esc(p.name)} — ${q} — ${brl(p.price_month_cents)}/mês</option>`;
    }).join("");
    ["e_name", "e_doc", "e_email", "e_phone"].forEach((id) => { $("#" + id).value = ""; });
    $("#emitForm").classList.remove("hide");
    $("#emitResult").classList.add("hide");
    openModal("modalEmitir");
  }
  $("#btnEmitir").addEventListener("click", openEmitir);
  $("#btnEmitirTop").addEventListener("click", openEmitir);
  $("#btnEmitOutra").addEventListener("click", openEmitir);

  // Auto-preenchimento por CNPJ (BrasilAPI via backend)
  $("#e_cnpj").addEventListener("click", async () => {
    const doc = digits($("#e_doc").value); if (doc.length !== 14) { toast("Informe um CNPJ com 14 dígitos."); return; }
    const b = $("#e_cnpj"); b.disabled = true; b.textContent = "…";
    try {
      const r = await api(`/owner/crm/cnpj/${doc}`);
      const c = r.company || {};
      if (c.name && !$("#e_name").value) $("#e_name").value = c.name;
      if (c.email && !$("#e_email").value) $("#e_email").value = c.email;
      if (c.phone && !$("#e_phone").value) $("#e_phone").value = c.phone;
      toast("Dados do CNPJ preenchidos.");
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = "Buscar"; }
  });

  $("#btnDoEmit").addEventListener("click", async () => {
    const name = $("#e_name").value.trim();
    if (!name) { toast("Informe o nome do cliente."); return; }
    const btn = $("#btnDoEmit"); btn.disabled = true; btn.textContent = "Gerando…";
    try {
      const body = {
        tenant: { name, doc: $("#e_doc").value.trim(), email: $("#e_email").value.trim(), phone: $("#e_phone").value.trim() },
        planId: $("#e_plan").value, billingType: $("#e_billing").value,
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
    const rows = LIC_ROWS.filter((l) => !q || (l.tenant_name || "").toLowerCase().includes(q) || (l.tenant_email || "").toLowerCase().includes(q) || (l.license_key || "").toLowerCase().includes(q));
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">Nenhuma licença encontrada.</td></tr>`; return; }
    tb.innerHTML = rows.map((l) => {
      const quota = l.client_quota_override != null ? l.client_quota_override : l.client_quota;
      return `<tr>
        <td>${esc(l.tenant_name)}<div class="small muted mono">${esc(l.license_key)}</div></td>
        <td>${esc(l.plan_name || l.plan_id)}</td>
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
        <div class="it"><div class="k">Licença</div><div class="v">${tag(l.status)} <span class="small muted">v${l.version}</span></div></div>
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
        kpi(t.contacts, "Contatos"),
        kpi(t.clients, "Clientes (ganhos)", "green"),
        kpi(stats.conversion + "%", "Conversão", "gold"),
        kpi(t.due_soon, "Follow-ups (3d)", t.due_soon ? "gold" : ""),
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
  //  AUDITORIA (trilha completa)
  // ===================================================================
  const ACTION_LABELS = {
    login: "Login", login_locked: "Conta bloqueada (tentativas)", owner_bootstrap: "Senha do dono definida",
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
  async function loadAudit() {
    const tb = $("#auditRows");
    try {
      const d = await api("/owner/audit");
      const rows = d.events || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">Sem eventos.</td></tr>`; return; }
      tb.innerHTML = rows.map((ev) => `<tr>
        <td class="small">${dtt(ev.created_at)}</td>
        <td><span class="tag ${evTag(ev.action)}">${esc(actionLabel(ev.action))}</span></td>
        <td class="small">${esc(ev.actor_email || "system")}</td>
        <td class="small muted">${esc(ev.kind === "license" ? "licença" : "admin")}</td>
        <td class="small muted">${esc(ev.detail || "")}</td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }

  // ---------- boot ----------
  $("#verBadge").textContent = "v" + PLATFORM_VERSION;
  show("dashboard");
})();

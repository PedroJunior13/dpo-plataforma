/* App operacional LGPD — DPO PJ Protection
   Assinantes (gating por módulo) e ambiente de consultoria do dono (completo). */
(function () {
  "use strict";
  const API = "/api/app";
  const TOKEN = localStorage.getItem("dpo_token");
  const USER = JSON.parse(localStorage.getItem("dpo_user") || "null");

  if (!TOKEN || !USER) { location.replace("/?next=/app/"); return; }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dt = (s) => s ? new Date(s).toLocaleDateString("pt-BR") : "—";
  const dtt = (s) => s ? new Date(s).toLocaleString("pt-BR") : "—";
  const brl = (c) => "R$ " + ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

  let TOAST_T;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(TOAST_T); TOAST_T = setTimeout(() => t.classList.remove("show"), 2200); }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, ...(opts.headers || {}) } });
    if (res.status === 401) { logout(); throw new Error("Sessão expirada."); }
    if (res.status === 402) { const d = await res.json().catch(() => ({})); location.replace("/bloqueado.html?msg=" + encodeURIComponent(d.error || "")); throw new Error(d.error || "Acesso bloqueado."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Erro na requisição.");
    return data;
  }
  // chamadas a endpoints fora de /api/app (auth/mfa)
  async function apiRoot(path, opts = {}) {
    const res = await fetch("/api" + path, { ...opts, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Erro.");
    return data;
  }

  function logout() { localStorage.removeItem("dpo_token"); localStorage.removeItem("dpo_user"); location.replace("/"); }
  $("#btnLogout").addEventListener("click", logout);

  function openModal(title, body) { $("#m_title").textContent = title; $("#m_body").innerHTML = body; $("#modal").classList.add("show"); }
  function closeModal() { $("#modal").classList.remove("show"); }
  document.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target.id === "modal") closeModal(); });

  let CAPS = { features: [], isOwner: false, tier: 1, planId: "basic" };
  const can = (f) => CAPS.features.includes("all") || CAPS.features.includes(f);

  // ---------------- navegação ----------------
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;
    if (b.dataset.feat && !can(b.dataset.feat)) { toast("Recurso do módulo superior. Faça upgrade."); return; }
    $$("#nav button").forEach((x) => x.classList.remove("active")); b.classList.add("active");
    showView(b.dataset.view);
  });
  function showView(v) {
    $$(".view").forEach((s) => s.classList.add("hide")); $("#view-" + v).classList.remove("hide");
    ({ dashboard: loadDashboard, clients: loadClients, documents: loadDocuments, requests: loadRequests,
       incidents: loadIncidents, projects: loadProjects, team: loadTeam, account: loadAccount }[v] || (() => {}))();
  }

  // ---------------- bootstrap ----------------
  async function boot() {
    try {
      const d = await api("/bootstrap");
      CAPS = d.capabilities || CAPS;
      $("#hello").textContent = "Olá, " + (d.user?.name || d.user?.email || "");
      const planName = { basic: "Básico", inter: "Intermediário", adv: "Avançado", owner: "Consultoria (completo)" }[CAPS.planId] || CAPS.planId;
      $("#planLine").textContent = "Módulo: " + planName + (CAPS.isOwner ? " · clientes ilimitados" : "");
      if (CAPS.isOwner) $("#ownerBanner").classList.remove("hide");
      if (d.tenant?.is_demo) {
        const exp = d.tenant.demo_expires_at;
        const days = exp ? Math.max(0, Math.ceil((new Date(exp) - Date.now()) / 864e5)) : null;
        $("#demoBannerMsg").textContent = "— dados de exemplo. " + (days != null ? `Expira em ${days} dia(s).` : "Explore livremente.");
        $("#demoBanner").classList.remove("hide");
      }

      // esconde abas sem permissão
      $$("#nav button[data-feat]").forEach((b) => { if (!can(b.dataset.feat)) b.classList.add("hide"); });
      if (!can("projects")) $("#hintProjects")?.classList.add("hide");

      const c = d.counts || {};
      $("#kpis").innerHTML = [
        kpi(c.clients, "Clientes"),
        kpi(c.open_requests, "Titulares em aberto"),
        kpi(c.open_incidents, "Incidentes abertos", c.open_incidents ? "red" : ""),
        kpi(c.documents, "Documentos"),
        can("projects") ? kpi(c.projects, "Projetos") : "",
      ].join("");
    } catch (e) { $("#kpis").innerHTML = `<div class="card" style="color:#ff9aa8">${esc(e.message)}</div>`; }
  }
  const kpi = (v, l, cls = "") => `<div class="kpi"><div class="v ${cls}">${v ?? 0}</div><div class="l">${l}</div></div>`;
  function loadDashboard() { boot(); }

  // ---------------- CLIENTES ----------------
  let CLIENTS = [];
  async function loadClients() {
    const tb = $("#clientRows");
    try {
      const d = await api("/clients"); CLIENTS = d.clients || [];
      $("#quotaLine").textContent = d.quota == null ? "Clientes ilimitados" : `${d.used} de ${d.quota} clientes`;
      tb.innerHTML = CLIENTS.length ? CLIENTS.map((c) => `<tr>
        <td><a href="#" data-open="${c.id}">${esc(c.name)}</a></td>
        <td>${esc(c.cnpj || "—")}</td><td>${esc(c.sector || "—")}</td>
        <td>${esc(c.phase || "—")}</td><td><span class="tag ${c.status === "ativo" ? "active" : "pending"}">${esc(c.status || "—")}</span></td>
        <td style="text-align:right"><button class="btn sm ghost" data-open="${c.id}">Abrir</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="muted">Nenhum cliente. Clique em “Novo cliente”.</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#clientRows").addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]"); if (a) { e.preventDefault(); openClient(a.dataset.open); }
  });
  $("#btnNovoClient").addEventListener("click", () => {
    openModal("Novo cliente", `
      <div class="row c2"><div class="field"><label>Nome *</label><input id="f_name"></div>
      <div class="field"><label>CNPJ</label><input id="f_cnpj"></div></div>
      <div class="row c2"><div class="field"><label>Setor</label><input id="f_sector"></div>
      <div class="field"><label>Fase</label><select id="f_phase">
        <option value="diagnostico">Diagnóstico</option><option value="adequacao">Adequação</option>
        <option value="implementacao">Implementação</option><option value="monitoramento">Monitoramento</option></select></div></div>
      <div class="row c2"><div class="field"><label>Contato</label><input id="f_contact"></div>
      <div class="field"><label>E-mail do contato</label><input id="f_cemail" type="email"></div></div>
      <button class="btn gold block" id="f_save">Cadastrar</button>`);
    $("#f_save").onclick = async () => {
      const name = $("#f_name").value.trim(); if (!name) { toast("Informe o nome."); return; }
      try {
        await api("/clients", { method: "POST", body: JSON.stringify({
          name, cnpj: $("#f_cnpj").value.trim(), sector: $("#f_sector").value.trim(), phase: $("#f_phase").value,
          contactName: $("#f_contact").value.trim(), contactEmail: $("#f_cemail").value.trim() }) });
        toast("Cliente cadastrado."); closeModal(); loadClients();
      } catch (e) { toast(e.message); }
    };
  });

  // ---------------- DETALHE DO CLIENTE ----------------
  let CURRENT_CLIENT = null;
  $("#backClients").addEventListener("click", () => { showNav("clients"); });
  function showNav(v) { $$("#nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === v)); showView(v); }

  async function openClient(id) {
    try {
      const d = await api("/clients/" + id); CURRENT_CLIENT = d.client;
      $$(".view").forEach((s) => s.classList.add("hide")); $("#view-client").classList.remove("hide");
      $("#cl_name").textContent = d.client.name;
      $("#cl_meta").textContent = [d.client.cnpj, d.client.sector, "Fase: " + (d.client.phase || "—")].filter(Boolean).join(" · ");
      $("#cl_docs").innerHTML = listOr(d.documents, (x) => `${esc(x.title || x.doc_type)} <span class="small muted">(${esc(x.doc_type)})</span>`);
      $("#cl_reqs").innerHTML = listOr(d.requests, (x) => `${esc(x.kind)} — ${esc(x.requester || "—")} <span class="tag ${x.status === "concluido" ? "active" : "pending"}">${esc(x.status)}</span>`);
      $("#cl_incs").innerHTML = listOr(d.incidents, (x) => `${esc(x.title)} <span class="tag ${x.status === "fechado" ? "active" : "suspended"}">${esc(x.severity)}</span>`);
      if (can("projects")) { $("#cl_projWrap").classList.remove("hide"); $("#cl_projs").innerHTML = listOr(d.projects, (x) => `${esc(x.name)} <span class="small muted">${esc(x.phase)}</span>`); }
      else $("#cl_projWrap").classList.add("hide");
    } catch (e) { toast(e.message); }
  }
  const listOr = (arr, fn) => (arr && arr.length) ? `<ul style="margin:8px 0 0;padding-left:18px">${arr.map((x) => `<li style="margin:5px 0">${fn(x)}</li>`).join("")}</ul>` : `<p class="muted">Nada por aqui ainda.</p>`;

  $("#cl_addDoc").addEventListener("click", () => docModal(CURRENT_CLIENT?.id, () => openClient(CURRENT_CLIENT.id)));
  $("#cl_addReq").addEventListener("click", () => reqModal(CURRENT_CLIENT?.id, () => openClient(CURRENT_CLIENT.id)));
  $("#cl_addInc").addEventListener("click", () => incModal(CURRENT_CLIENT?.id, () => openClient(CURRENT_CLIENT.id)));
  $("#cl_addProj").addEventListener("click", () => projModal(CURRENT_CLIENT?.id, () => openClient(CURRENT_CLIENT.id)));

  // ---------------- DOCUMENTOS ----------------
  async function loadDocuments() {
    const tb = $("#docRows");
    try {
      const d = await api("/documents");
      tb.innerHTML = (d.documents || []).length ? d.documents.map((x) => `<tr>
        <td>${esc(x.title || "—")}</td><td>${esc(x.doc_type)}</td><td>v${x.last_version || 1}</td><td>${dt(x.created_at)}</td>
        <td style="text-align:right"><button class="btn sm ghost" data-doc="${x.id}">Versões</button></td></tr>`).join("")
        : `<tr><td colspan="5" class="muted">Nenhum documento.</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#docRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-doc]"); if (!b) return;
    try {
      const d = await api("/documents/" + b.dataset.doc);
      openModal("Versões — " + (d.document.title || d.document.doc_type), `
        <div class="field"><label>Nova versão (conteúdo)</label><textarea id="v_content" rows="5" placeholder="Cole/edite o conteúdo desta versão…"></textarea></div>
        <button class="btn gold block" id="v_save">Salvar nova versão</button>
        <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
        <h3>Histórico</h3>
        ${(d.versions || []).map((v) => `<div class="copybox" style="align-items:flex-start"><span class="val">v${v.version} · ${dtt(v.created_at)} · ${esc(v.author || "")}<br>${esc((v.content || "").slice(0, 200))}</span></div>`).join("") || '<p class="muted">Sem versões.</p>'}`);
      $("#v_save").onclick = async () => {
        try { await api(`/documents/${b.dataset.doc}/version`, { method: "POST", body: JSON.stringify({ content: $("#v_content").value }) });
          toast("Versão salva."); closeModal(); loadDocuments(); } catch (err) { toast(err.message); }
      };
    } catch (err) { toast(err.message); }
  });
  $("#btnNovoDoc").addEventListener("click", () => docModal(null, loadDocuments));
  function docModal(clientId, after) {
    const opts = CLIENTS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    openModal("Novo documento", `
      ${clientId ? "" : `<div class="field"><label>Cliente</label><select id="d_client"><option value="">(sem vínculo)</option>${opts}</select></div>`}
      <div class="row c2"><div class="field"><label>Tipo</label><select id="d_type">
        <option value="politica_privacidade">Política de Privacidade</option><option value="ropa">Registro de Tratamento (ROPA)</option>
        <option value="contrato">Contrato / DPA</option><option value="termo">Termo de Consentimento</option>
        <option value="relatorio">Relatório de Impacto (RIPD)</option><option value="documento">Outro</option></select></div>
      <div class="field"><label>Título</label><input id="d_title"></div></div>
      <div class="field"><label>Conteúdo (v1)</label><textarea id="d_content" rows="4"></textarea></div>
      <button class="btn gold block" id="d_save">Criar documento</button>`);
    $("#d_save").onclick = async () => {
      try { await api("/documents", { method: "POST", body: JSON.stringify({
        clientId: clientId || ($("#d_client") ? $("#d_client").value : "") || null,
        docType: $("#d_type").value, title: $("#d_title").value.trim(), content: $("#d_content").value }) });
        toast("Documento criado."); closeModal(); after && after(); } catch (e) { toast(e.message); }
    };
  }

  // ---------------- TITULARES ----------------
  async function loadRequests() {
    const tb = $("#reqRows");
    try {
      const d = await api("/requests");
      tb.innerHTML = (d.requests || []).length ? d.requests.map((r) => `<tr>
        <td>${esc(r.kind)}</td><td>${esc(r.requester || "—")}</td><td>${esc(r.client_name || "—")}</td>
        <td>${statusSel(r.id, r.status, "req", ["aberto", "em_analise", "concluido"])}</td>
        <td>${dt(r.created_at)}</td><td></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Nenhuma solicitação.</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#btnNovaReq").addEventListener("click", () => reqModal(null, loadRequests));
  function reqModal(clientId, after) {
    const opts = CLIENTS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    openModal("Nova solicitação de titular", `
      ${clientId ? "" : `<div class="field"><label>Cliente</label><select id="r_client"><option value="">(sem vínculo)</option>${opts}</select></div>`}
      <div class="row c2"><div class="field"><label>Tipo</label><select id="r_kind">
        <option value="acesso">Acesso</option><option value="correcao">Correção</option><option value="exclusao">Exclusão</option>
        <option value="portabilidade">Portabilidade</option><option value="revogacao">Revogação de consentimento</option></select></div>
      <div class="field"><label>Solicitante</label><input id="r_req" placeholder="Nome/e-mail do titular"></div></div>
      <button class="btn gold block" id="r_save">Registrar</button>`);
    $("#r_save").onclick = async () => {
      try { await api("/requests", { method: "POST", body: JSON.stringify({
        clientId: clientId || ($("#r_client") ? $("#r_client").value : "") || null,
        kind: $("#r_kind").value, requester: $("#r_req").value.trim() }) });
        toast("Solicitação registrada."); closeModal(); after && after(); } catch (e) { toast(e.message); }
    };
  }

  // ---------------- INCIDENTES ----------------
  async function loadIncidents() {
    const tb = $("#incRows");
    try {
      const d = await api("/incidents");
      tb.innerHTML = (d.incidents || []).length ? d.incidents.map((i) => `<tr>
        <td>${esc(i.title)}</td><td>${esc(i.client_name || "—")}</td>
        <td><span class="tag ${i.severity === "alta" ? "suspended" : i.severity === "baixa" ? "active" : "grace"}">${esc(i.severity)}</span></td>
        <td>${statusSel(i.id, i.status, "inc", ["aberto", "em_tratamento", "fechado"])}</td>
        <td>${dt(i.created_at)}</td><td></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Nenhum incidente.</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#btnNovoInc").addEventListener("click", () => incModal(null, loadIncidents));
  function incModal(clientId, after) {
    const opts = CLIENTS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    openModal("Novo incidente", `
      ${clientId ? "" : `<div class="field"><label>Cliente</label><select id="i_client"><option value="">(sem vínculo)</option>${opts}</select></div>`}
      <div class="field"><label>Título</label><input id="i_title"></div>
      <div class="field"><label>Severidade</label><select id="i_sev"><option value="baixa">Baixa</option><option value="media" selected>Média</option><option value="alta">Alta</option></select></div>
      <button class="btn gold block" id="i_save">Registrar</button>`);
    $("#i_save").onclick = async () => {
      const title = $("#i_title").value.trim(); if (!title) { toast("Informe o título."); return; }
      try { await api("/incidents", { method: "POST", body: JSON.stringify({
        clientId: clientId || ($("#i_client") ? $("#i_client").value : "") || null,
        title, severity: $("#i_sev").value }) });
        toast("Incidente registrado."); closeModal(); after && after(); } catch (e) { toast(e.message); }
    };
  }

  // status inline (titulares/incidentes)
  function statusSel(id, status, kind, opts) {
    return `<select data-status="${kind}" data-id="${id}" class="small" style="padding:5px 8px">${opts.map((o) => `<option value="${o}" ${o === status ? "selected" : ""}>${o.replace(/_/g, " ")}</option>`).join("")}</select>`;
  }
  document.addEventListener("change", async (e) => {
    const s = e.target.closest("select[data-status]"); if (!s) return;
    const kind = s.dataset.status, id = s.dataset.id, status = s.value;
    try { await api(`/${kind === "req" ? "requests" : "incidents"}/${id}`, { method: "POST", body: JSON.stringify({ status }) }); toast("Atualizado."); }
    catch (err) { toast(err.message); }
  });

  // ---------------- PROJETOS ----------------
  async function loadProjects() {
    if (!can("projects")) return;
    const tb = $("#projRows");
    try {
      const d = await api("/projects");
      tb.innerHTML = (d.projects || []).length ? d.projects.map((p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.client_name || "—")}</td><td>${esc(p.phase)}</td><td>${dt(p.due_date)}</td>
        <td style="text-align:right"><button class="btn sm ghost" data-tasks="${p.id}" data-name="${esc(p.name)}">Tarefas</button></td></tr>`).join("")
        : `<tr><td colspan="5" class="muted">Nenhum projeto.</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#btnNovoProj").addEventListener("click", () => projModal(null, loadProjects));
  function projModal(clientId, after) {
    if (!can("projects")) { toast("Recurso do módulo Intermediário+."); return; }
    const opts = CLIENTS.map((c) => `<option value="${c.id}" ${c.id === clientId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    openModal("Novo projeto", `
      <div class="field"><label>Cliente *</label><select id="p_client">${opts}</select></div>
      <div class="field"><label>Nome do projeto *</label><input id="p_name" value="Adequação LGPD"></div>
      <div class="row c2"><div class="field"><label>Fase</label><select id="p_phase">
        <option value="diagnostico">Diagnóstico</option><option value="adequacao">Adequação</option>
        <option value="implementacao">Implementação</option><option value="monitoramento">Monitoramento</option></select></div>
      <div class="field"><label>Prazo</label><input id="p_due" type="date"></div></div>
      <button class="btn gold block" id="p_save">Criar projeto</button>`);
    $("#p_save").onclick = async () => {
      const cid = $("#p_client").value, name = $("#p_name").value.trim();
      if (!cid || !name) { toast("Informe cliente e nome."); return; }
      try { await api("/projects", { method: "POST", body: JSON.stringify({ clientId: cid, name, phase: $("#p_phase").value, dueDate: $("#p_due").value || null }) });
        toast("Projeto criado."); closeModal(); after && after(); } catch (e) { toast(e.message); }
    };
  }
  $("#projRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tasks]"); if (!b) return;
    try {
      const d = await api("/tasks?projectId=" + b.dataset.tasks);
      openModal("Tarefas — " + b.dataset.name, `
        <div class="flex" style="gap:8px"><input id="t_title" placeholder="Nova tarefa…" style="flex:1"><button class="btn gold" id="t_add">+</button></div>
        <div id="t_list" style="margin-top:12px">${tasksHtml(d.tasks)}</div>`);
      const pid = b.dataset.tasks;
      $("#t_add").onclick = async () => {
        const title = $("#t_title").value.trim(); if (!title) return;
        try { await api("/tasks", { method: "POST", body: JSON.stringify({ projectId: pid, title }) });
          const dd = await api("/tasks?projectId=" + pid); $("#t_list").innerHTML = tasksHtml(dd.tasks); $("#t_title").value = ""; } catch (err) { toast(err.message); }
      };
    } catch (err) { toast(err.message); }
  });
  function tasksHtml(tasks) {
    return (tasks && tasks.length) ? tasks.map((t) => `<div class="flex between" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <span>${esc(t.title)}</span>${statusSel(t.id, t.status, "task", ["todo", "doing", "done"])}</div>`).join("")
      : '<p class="muted">Sem tarefas.</p>';
  }
  // status de tarefa (delegação separada pois rota é /tasks)
  document.addEventListener("change", async (e) => {
    const s = e.target.closest('select[data-status="task"]'); if (!s) return;
    try { await api(`/tasks/${s.dataset.id}`, { method: "POST", body: JSON.stringify({ status: s.value }) }); toast("Tarefa atualizada."); }
    catch (err) { toast(err.message); }
  });

  // ---------------- EQUIPE ----------------
  async function loadTeam() {
    if (!can("team")) return;
    const tb = $("#teamRows");
    try {
      const d = await api("/team");
      tb.innerHTML = (d.team || []).map((m) => `<tr>
        <td>${esc(m.name || "—")}</td><td>${esc(m.email)}</td><td>${esc(m.role)}</td>
        <td>${m.mfa_enabled ? '<span class="tag active">on</span>' : '<span class="tag pending">off</span>'}</td>
        <td>${m.active ? '<span class="tag active">ativo</span>' : '<span class="tag suspended">inativo</span>'}</td>
        <td style="text-align:right">${m.role === "OWNER" ? "" : `<button class="btn sm ghost" data-toggle="${m.id}" data-active="${m.active}">${m.active ? "Desativar" : "Ativar"}</button>`}</td></tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#teamRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-toggle]"); if (!b) return;
    try { await api("/team/" + b.dataset.toggle, { method: "POST", body: JSON.stringify({ active: b.dataset.active !== "true" }) }); toast("Atualizado."); loadTeam(); }
    catch (err) { toast(err.message); }
  });
  $("#btnNovoMembro").addEventListener("click", () => {
    if (!can("team")) { toast("Recurso do módulo Avançado."); return; }
    openModal("Adicionar membro", `
      <div class="row c2"><div class="field"><label>Nome</label><input id="tm_name"></div>
      <div class="field"><label>Papel</label><select id="tm_role"><option value="COLABORADOR">Colaborador</option><option value="DPO">DPO</option><option value="AUDITOR">Auditor</option></select></div></div>
      <div class="field"><label>E-mail *</label><input id="tm_email" type="email"></div>
      <div class="field"><label>Senha inicial * (o membro poderá trocar)</label><input id="tm_pass" type="text" placeholder="mín. 8 caracteres"></div>
      <button class="btn gold block" id="tm_save">Adicionar</button>`);
    $("#tm_save").onclick = async () => {
      try { await api("/team", { method: "POST", body: JSON.stringify({
        name: $("#tm_name").value.trim(), role: $("#tm_role").value, email: $("#tm_email").value.trim(), password: $("#tm_pass").value }) });
        toast("Membro adicionado."); closeModal(); loadTeam(); } catch (e) { toast(e.message); }
    };
  });

  // ---------------- CONTA / MFA ----------------
  let MFA_ENABLED = !!(USER && USER.mfa_enabled);
  async function loadAccount() {
    // status atual
    try { const me = await apiRoot("/auth/me"); MFA_ENABLED = !!me.user?.mfa_enabled; } catch {}
    renderMfa();
    try {
      const d = await api("/subscription");
      const p = d.plan, s = d.subscription;
      $("#subBox").innerHTML = `
        <div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>Módulo</span><b>${esc(p?.name || CAPS.planId)}</b></div>
        <div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>Status</span><span class="tag ${d.tenant?.status === "active" ? "active" : "pending"}">${esc(d.tenant?.status || "—")}</span></div>
        <div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>Cobrança</span><span>${esc(s?.billing_type || "—")}</span></div>
        <div class="flex between" style="padding:6px 0"><span>Pago até</span><span>${dt(s?.current_period_end)}</span></div>`;
    } catch (e) { $("#subBox").innerHTML = `<span style="color:#ff9aa8">${esc(e.message)}</span>`; }
  }
  function renderMfa() {
    $("#mfaStatus").innerHTML = MFA_ENABLED ? '<span class="tag active">2FA ativo</span>' : '<span class="tag pending">2FA desativado</span> <span class="muted">(recomendado ativar)</span>';
    $("#btnStartMfa").classList.toggle("hide", MFA_ENABLED);
    $("#mfaSetup").classList.add("hide");
    $("#mfaDisableWrap").classList.toggle("hide", !MFA_ENABLED);
  }
  $("#btnStartMfa").addEventListener("click", async () => {
    try {
      const d = await apiRoot("/auth/mfa/setup", { method: "POST" });
      $("#mfaSecret").textContent = d.secret;
      $("#qr").innerHTML = "";
      if (window.QRCode) { new window.QRCode($("#qr"), { text: d.otpauth, width: 168, height: 168 }); }
      else { $("#qr").innerHTML = `<a href="${esc(d.otpauth)}" class="small">Abrir no autenticador</a>`; }
      $("#mfaSetup").classList.remove("hide"); $("#btnStartMfa").classList.add("hide");
    } catch (e) { toast(e.message); }
  });
  $("#copySecret").addEventListener("click", () => { navigator.clipboard.writeText($("#mfaSecret").textContent).then(() => toast("Copiado!")); });
  $("#btnEnableMfa").addEventListener("click", async () => {
    try { await apiRoot("/auth/mfa/enable", { method: "POST", body: JSON.stringify({ code: $("#mfaCode").value.trim() }) });
      MFA_ENABLED = true; USER.mfa_enabled = true; localStorage.setItem("dpo_user", JSON.stringify(USER));
      toast("2FA ativado!"); renderMfa(); } catch (e) { toast(e.message); }
  });
  $("#btnDisableMfa").addEventListener("click", async () => {
    try { await apiRoot("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ code: $("#mfaDisableCode").value.trim() }) });
      MFA_ENABLED = false; USER.mfa_enabled = false; localStorage.setItem("dpo_user", JSON.stringify(USER));
      toast("2FA desativado."); renderMfa(); } catch (e) { toast(e.message); }
  });

  // ---------------- boot ----------------
  boot();
})();

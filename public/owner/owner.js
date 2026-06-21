/* Painel do Dono — DPO PJ Protection
   Área administrativa: emissão de licença com link/licença/mensagem prontos
   para copiar e enviar; gestão de assinantes, financeiro, consultoria e auditoria. */
(function () {
  "use strict";

  const API = "/api";
  const TOKEN = localStorage.getItem("dpo_token");
  const USER = JSON.parse(localStorage.getItem("dpo_user") || "null");

  // Guarda de rota: só o dono entra aqui.
  if (!TOKEN || !USER || USER.role !== "OWNER") {
    location.replace("/?next=/painel");
    return;
  }

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const brl = (cents) => "R$ " + ((cents || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  const dt = (s) => s ? new Date(s).toLocaleDateString("pt-BR") : "—";
  const dtt = (s) => s ? new Date(s).toLocaleString("pt-BR") : "—";

  let TOAST_T;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(TOAST_T); TOAST_T = setTimeout(() => t.classList.remove("show"), 2200);
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

  function logout() {
    localStorage.removeItem("dpo_token"); localStorage.removeItem("dpo_user");
    location.replace("/");
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copiado!"); }
    catch { // fallback
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove(); toast("Copiado!");
    }
  }

  // Copia por atributo data-copy (id do elemento cujo textContent será copiado)
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) { const el = $("#" + b.getAttribute("data-copy")); if (el) copy(el.textContent); }
    const c = e.target.closest("[data-close]");
    if (c) c.closest(".modal-bg").classList.remove("show");
  });
  $$(".modal-bg").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));

  function openModal(id) { $("#" + id).classList.add("show"); }
  function closeModal(id) { $("#" + id).classList.remove("show"); }

  // ---------- navegação ----------
  let PLANS = [];
  const tag = (status) => `<span class="tag ${esc(status)}">${esc(statusLabel(status))}</span>`;
  function statusLabel(s) {
    return ({ active: "Ativo", issued: "Emitida", pending: "Pendente", grace: "Carência",
      suspended: "Suspenso", blocked: "Bloqueado", revoked: "Revogada", canceled: "Cancelado", expired: "Expirada" }[s]) || s;
  }

  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;
    $$("#nav button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    show(b.getAttribute("data-view"));
  });
  $("#btnLogout").addEventListener("click", logout);

  function show(view) {
    $$(".view").forEach((v) => v.classList.add("hide"));
    $("#view-" + view).classList.remove("hide");
    ({ dashboard: loadDashboard, licenses: loadLicenses, tenants: loadTenants,
      payments: loadPayments, clients: loadClients, audit: loadAudit }[view] || (() => {}))();
  }

  // ===================================================================
  //  DASHBOARD
  // ===================================================================
  async function loadDashboard() {
    try {
      const d = await api("/owner/dashboard");
      const t = d.totals || {};
      $("#kpis").innerHTML = [
        kpi(t.tenants, "Assinantes"),
        kpi(t.active, "Ativos", "green"),
        kpi(t.blocked, "Bloqueados", "red"),
        kpi(t.active_licenses, "Licenças ativas"),
        kpi(brl(d.mrrCents), "Receita recorrente", "gold"),
      ].join("");

      // vencimentos
      const ov = d.overdue || [];
      $("#overdueBox").innerHTML = ov.length ? `<table><thead><tr><th>Cliente</th><th>Vence</th><th>Status</th><th></th></tr></thead><tbody>${
        ov.map((o) => {
          const days = Math.ceil((new Date(o.current_period_end) - Date.now()) / 864e5);
          const lbl = days < 0 ? `<span style="color:#ff9aa8">${Math.abs(days)}d atrasado</span>` : `em ${days}d`;
          const wa = o.phone ? `<a class="btn sm green" target="_blank" rel="noopener" href="https://wa.me/${o.phone.replace(/\D/g, "")}?text=${encodeURIComponent("Ola " + o.name + ", sobre sua assinatura DPO PJ Protection: identificamos um vencimento proximo. Vamos regularizar?")}">Cobrar</a>` : "";
          return `<tr><td>${esc(o.name)}<div class="small muted">${esc(o.plan_name || "")}</div></td><td>${dt(o.current_period_end)}<div class="small muted">${lbl}</div></td><td>${tag(o.status)}</td><td style="text-align:right">${wa}</td></tr>`;
        }).join("")
      }</tbody></table>` : `<p class="muted">Nenhum vencimento nos próximos 7 dias. 🎉</p>`;

      // distribuição por plano
      $("#byPlanBox").innerHTML = (d.byPlan || []).map((p) =>
        `<div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(p.name || p.plan_id)}</span><b>${p.n}</b></div>`).join("") || `<p class="muted">Sem assinantes ainda.</p>`;

      // integrações
      const gws = d.gateways || [];
      $("#integ").innerHTML =
        `<div>Gateways: ${gws.length ? gws.map((g) => `<span class="tag active" style="text-transform:capitalize">${esc(g)}</span>`).join(" ") : '<span class="tag suspended">nenhum configurado</span>'}</div>` +
        `<div style="margin-top:8px">NFS-e: ${d.nfseEnabled ? '<span class="tag active">ativa</span>' : '<span class="tag pending">não configurada</span>'}</div>`;
    } catch (e) { $("#kpis").innerHTML = `<div class="card" style="color:#ff9aa8">${esc(e.message)}</div>`; }
  }
  const kpi = (v, l, cls = "") => `<div class="kpi"><div class="v ${cls}">${v ?? 0}</div><div class="l">${l}</div></div>`;

  // ===================================================================
  //  LINK DE DEMONSTRAÇÃO (7 dias, dados de exemplo, recriado a cada geração)
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
      $("#d_link").textContent = "";
      $("#d_expires").textContent = "";
      $("#demoResult").classList.toggle("hide", !(demo && demo.link));
      if (demo && demo.link) { $("#d_link").textContent = demo.link; } // mostra mesmo expirado p/ referência
    }
  }
  async function openDemo() {
    openModal("modalDemo");
    $("#demoBox").innerHTML = "Carregando…";
    try { const d = await api("/owner/demo"); renderDemo(d.demo); }
    catch (e) { $("#demoBox").innerHTML = `<span style="color:#ff9aa8">${esc(e.message)}</span>`; }
  }
  async function generateDemo() {
    if (!confirm("Gerar um novo link de demonstração? O ambiente atual (com todos os dados) será APAGADO e recriado.")) return;
    const btn = $("#btnDemoGen"); if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
    try {
      const r = await api("/owner/demo", { method: "POST" });
      renderDemo({ link: r.link, expiresAt: r.expiresAt, expired: false, counts: { clients: 3 } });
      toast("Demonstração recriada!");
    } catch (e) { toast(e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Gerar novo link (apaga e recria)"; } }
  }
  $("#btnDemo").addEventListener("click", openDemo);
  $("#btnDemoGen").addEventListener("click", generateDemo);

  // ===================================================================
  //  EMITIR LICENÇA  (link + licença + mensagem prontos p/ copiar)
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

  $("#btnDoEmit").addEventListener("click", async () => {
    const name = $("#e_name").value.trim();
    if (!name) { toast("Informe o nome do cliente."); return; }
    const btn = $("#btnDoEmit"); btn.disabled = true; btn.textContent = "Gerando…";
    try {
      const body = {
        tenant: { name, doc: $("#e_doc").value.trim(), email: $("#e_email").value.trim(), phone: $("#e_phone").value.trim() },
        planId: $("#e_plan").value,
        billingType: $("#e_billing").value,
      };
      const r = await api("/owner/licenses", { method: "POST", body: JSON.stringify(body) });
      $("#r_link").textContent = r.link || "";
      $("#r_key").textContent = r.license?.license_key || "";
      $("#r_msg").textContent = r.message || "";
      const wa = $("#r_wa");
      if (r.whatsapp) { wa.href = r.whatsapp; wa.classList.remove("hide"); } else wa.classList.add("hide");
      $("#emitForm").classList.add("hide");
      $("#emitResult").classList.remove("hide");
      toast("Licença emitida!");
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; btn.textContent = "Gerar licença e link"; }
  });

  // ===================================================================
  //  LICENÇAS
  // ===================================================================
  async function loadLicenses() {
    const tb = $("#licRows");
    try {
      const d = await api("/owner/licenses");
      const rows = d.licenses || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">Nenhuma licença emitida. Clique em “Emitir licença”.</td></tr>`; return; }
      tb.innerHTML = rows.map((l) => {
        const acts = [`<button class="btn sm gold" data-act="send" data-id="${l.id}">Enviar/Copiar</button>`];
        if (l.status === "active") acts.push(`<button class="btn sm danger" data-act="suspend" data-id="${l.id}">Suspender</button>`);
        if (l.status === "suspended") acts.push(`<button class="btn sm green" data-act="reactivate" data-id="${l.id}">Reativar</button>`);
        if (l.status !== "revoked") acts.push(`<button class="btn sm danger" data-act="revoke" data-id="${l.id}">Revogar</button>`);
        return `<tr>
          <td>${esc(l.tenant_name)}<div class="small muted">${esc(l.tenant_email || "")}</div></td>
          <td>${esc(l.plan_name || l.plan_id)}</td>
          <td class="mono small">${esc(l.license_key)}</td>
          <td>${tag(l.status)}<div class="small muted">v${l.version}</div></td>
          <td>${dt(l.valid_until)}</td>
          <td style="text-align:right"><div class="flex wrap-actions" style="justify-content:flex-end;gap:6px">${acts.join("")}</div></td>
        </tr>`;
      }).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }

  // ações de licença (delegação)
  $("#licRows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
    try {
      if (act === "send") {
        const r = await api(`/owner/licenses/${id}/send`, { method: "POST", body: JSON.stringify({ email: false }) });
        $("#s_link").textContent = r.link || "";
        // pega a key da linha
        const key = b.closest("tr").querySelector(".mono").textContent;
        $("#s_key").textContent = key;
        $("#s_msg").textContent = r.message || "";
        const wa = $("#s_wa");
        if (r.whatsapp) { wa.href = r.whatsapp; wa.classList.remove("hide"); } else wa.classList.add("hide");
        openModal("modalSend");
        return;
      }
      if (act === "revoke" && !confirm("Revogar definitivamente esta licença? O acesso do cliente será cortado.")) return;
      if (act === "suspend" && !confirm("Suspender o acesso deste cliente (kill-switch)?")) return;
      await api(`/owner/licenses/${id}/${act}`, { method: "POST" });
      toast("Feito.");
      loadLicenses();
    } catch (err) { toast(err.message); }
  });

  // ===================================================================
  //  ASSINANTES
  // ===================================================================
  async function loadTenants() {
    const tb = $("#tenantRows");
    try {
      await ensurePlans();
      const d = await api("/owner/tenants");
      const rows = d.tenants || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">Nenhum assinante ainda.</td></tr>`; return; }
      tb.innerHTML = rows.map((t) => `<tr>
        <td>${esc(t.name)}<div class="small muted">${esc(t.email || "")}</div></td>
        <td>${esc(t.plan_name || t.plan_id)}</td>
        <td>${tag(t.status)}</td>
        <td>${t.clients_count ?? 0}</td>
        <td>${dt(t.paid_until)}</td>
        <td style="text-align:right"><div class="flex wrap-actions" style="justify-content:flex-end;gap:6px">
          <button class="btn sm ghost" data-act="plan" data-id="${t.id}" data-plan="${esc(t.plan_id)}" data-name="${esc(t.name)}">Módulo</button>
          <button class="btn sm ghost" data-act="quota" data-id="${t.id}" data-name="${esc(t.name)}" data-q="${t.client_quota_override ?? ""}">Cota</button>
        </div></td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }

  $("#tenantRows").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const id = b.dataset.id, name = b.dataset.name;
    if (b.dataset.act === "plan") {
      $("#g_title").textContent = "Mudar módulo — " + name;
      $("#g_body").innerHTML = `
        <p class="muted small">Upgrade/downgrade sem perder dados do cliente. A cota é ajustada automaticamente.</p>
        <div class="field"><label>Novo módulo</label><select id="g_plan">${
          PLANS.map((p) => `<option value="${esc(p.id)}" ${p.id === b.dataset.plan ? "selected" : ""}>${esc(p.name)} — ${p.client_quota == null ? "ilimitado" : p.client_quota + " clientes"}</option>`).join("")
        }</select></div>
        <button class="btn gold block" id="g_save">Aplicar mudança</button>`;
      openModal("modalGeneric");
      $("#g_save").onclick = async () => {
        try { await api(`/owner/tenants/${id}/plan`, { method: "POST", body: JSON.stringify({ planId: $("#g_plan").value }) });
          toast("Módulo alterado."); closeModal("modalGeneric"); loadTenants(); } catch (err) { toast(err.message); }
      };
    } else if (b.dataset.act === "quota") {
      $("#g_title").textContent = "Ajustar cota — " + name;
      $("#g_body").innerHTML = `
        <p class="muted small">Defina um limite de clientes sob medida (vazio = usar a cota do módulo).</p>
        <div class="field"><label>Cota personalizada</label><input id="g_quota" type="number" min="0" value="${esc(b.dataset.q)}" placeholder="ex.: 200"></div>
        <button class="btn gold block" id="g_save">Salvar cota</button>`;
      openModal("modalGeneric");
      $("#g_save").onclick = async () => {
        const v = $("#g_quota").value.trim();
        try { await api(`/owner/tenants/${id}/quota`, { method: "POST", body: JSON.stringify({ quota: v === "" ? null : parseInt(v, 10) }) });
          toast("Cota atualizada."); closeModal("modalGeneric"); loadTenants(); } catch (err) { toast(err.message); }
      };
    }
  });

  $("#btnNovoTenant").addEventListener("click", async () => {
    await ensurePlans();
    $("#g_title").textContent = "Novo assinante";
    $("#g_body").innerHTML = `
      <div class="row c2">
        <div class="field"><label>Nome *</label><input id="g_name"></div>
        <div class="field"><label>CNPJ/CPF</label><input id="g_doc"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>E-mail</label><input id="g_email" type="email"></div>
        <div class="field"><label>WhatsApp</label><input id="g_phone"></div>
      </div>
      <div class="field"><label>Módulo</label><select id="g_plan">${PLANS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div>
      <button class="btn gold block" id="g_save">Criar assinante</button>`;
    openModal("modalGeneric");
    $("#g_save").onclick = async () => {
      const name = $("#g_name").value.trim(); if (!name) { toast("Informe o nome."); return; }
      try {
        await api("/owner/tenants", { method: "POST", body: JSON.stringify({
          name, doc: $("#g_doc").value.trim(), email: $("#g_email").value.trim(), phone: $("#g_phone").value.trim(), planId: $("#g_plan").value }) });
        toast("Assinante criado. Emita uma licença para liberar o acesso."); closeModal("modalGeneric"); loadTenants();
      } catch (err) { toast(err.message); }
    };
  });

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
        <td>${tag(p.status === "paid" ? "active" : p.status)}</td>
        <td style="text-align:right">${p.status === "paid" ? `<button class="btn sm ghost" data-inv="${p.id}">Emitir NFS-e</button>` : "—"}</td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#payRows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-inv]"); if (!b) return;
    try { await api(`/owner/payments/${b.dataset.inv}/invoice`, { method: "POST" }); toast("NFS-e em emissão."); }
    catch (err) { toast(err.message); }
  });

  // ===================================================================
  //  MEUS CLIENTES (consultoria, ilimitado)
  // ===================================================================
  async function loadClients() {
    const tb = $("#clientRows");
    try {
      const d = await api("/owner/clients");
      const rows = d.clients || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">Nenhum cliente cadastrado.</td></tr>`; return; }
      tb.innerHTML = rows.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.cnpj || "—")}</td><td>${esc(c.sector || "—")}</td>
        <td>${esc(c.contact_name || "—")}<div class="small muted">${esc(c.contact_email || "")}</div></td>
        <td>${dt(c.created_at)}</td></tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  $("#btnNovoCliente").addEventListener("click", () => {
    $("#g_title").textContent = "Novo cliente de consultoria";
    $("#g_body").innerHTML = `
      <div class="row c2">
        <div class="field"><label>Nome *</label><input id="g_name"></div>
        <div class="field"><label>CNPJ</label><input id="g_cnpj"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Setor</label><input id="g_sector"></div>
        <div class="field"><label>Contato</label><input id="g_contact"></div>
      </div>
      <div class="field"><label>E-mail do contato</label><input id="g_cemail" type="email"></div>
      <button class="btn gold block" id="g_save">Cadastrar cliente</button>`;
    openModal("modalGeneric");
    $("#g_save").onclick = async () => {
      const name = $("#g_name").value.trim(); if (!name) { toast("Informe o nome."); return; }
      try {
        await api("/owner/clients", { method: "POST", body: JSON.stringify({
          name, cnpj: $("#g_cnpj").value.trim(), sector: $("#g_sector").value.trim(),
          contactName: $("#g_contact").value.trim(), contactEmail: $("#g_cemail").value.trim() }) });
        toast("Cliente cadastrado."); closeModal("modalGeneric"); loadClients();
      } catch (err) { toast(err.message); }
    };
  });

  // ===================================================================
  //  AUDITORIA
  // ===================================================================
  async function loadAudit() {
    const tb = $("#auditRows");
    try {
      const d = await api("/owner/audit");
      const rows = d.events || [];
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">Sem eventos.</td></tr>`; return; }
      tb.innerHTML = rows.map((ev) => `<tr>
        <td class="small">${dtt(ev.created_at)}</td>
        <td><span class="tag ${evTag(ev.event)}">${esc(ev.event)}</span></td>
        <td class="small">${esc(ev.actor_email || "system")}</td>
        <td class="mono small">${esc((ev.license_id || "").toString().slice(0, 8))}</td>
        <td class="small muted">${esc(ev.note || "")}</td>
      </tr>`).join("");
    } catch (e) { tb.innerHTML = `<tr><td colspan="5" style="color:#ff9aa8">${esc(e.message)}</td></tr>`; }
  }
  function evTag(e) {
    if (["activated", "reactivated", "issued"].includes(e)) return "active";
    if (["suspended", "revoked", "expired"].includes(e)) return "suspended";
    if (["upgraded", "downgraded", "quota_changed", "sent"].includes(e)) return "pending";
    return "grace";
  }

  // ---------- boot ----------
  show("dashboard");
})();

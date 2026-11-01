(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const { sb, api, esc, signInEmail, signInProvider, here } = window.KLCore;
  let agents = [], current = null, detail = null;
  const views = ["#empty", "#connect", "#agent", "#newagent"];
  const view = (id) => views.forEach((v) => ($(v).hidden = v !== id));
  const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const when = (t) => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const setS = (sel, t, kind) => { const e = $(sel); e.textContent = t || ""; e.className = "status" + (kind ? " " + kind : ""); };

  /* ---------- sign in ---------- */
  const LABEL = { google: "Continue with Google", azure: "Continue with Microsoft", github: "Continue with GitHub" };
  const prov = window.KL.providers.filter((p) => LABEL[p]);
  $("#provider-btns").innerHTML = prov.map((p) => `<button class="btn block" type="button" data-p="${p}">${LABEL[p]}</button>`).join("");
  $("#or").hidden = !prov.length;
  $("#provider-btns").onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) signInProvider(b.dataset.p, here()).catch((x) => setS("#signin-status", x.message, "err")); };
  $("#email-form").onsubmit = async (e) => {
    e.preventDefault(); const email = $("#email").value.trim();
    try { await signInEmail(email, here()); setS("#signin-status", `Check ${email} for a sign-in link.`, "ok"); }
    catch (x) { setS("#signin-status", x.message, "err"); }
  };
  $("#btn-signout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

  /* ---------- copy buttons ---------- */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    const text = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = "Selected"; }
    setTimeout(() => (b.textContent = "Copy"), 1800);
  });

  /* ---------- agents ---------- */
  async function loadAgents(select) {
    agents = (await api("owner_agents")).agents;
    $("#agentlist").innerHTML = agents.map((a) => `<button data-slug="${esc(a.slug)}" aria-current="${a.slug === select}"><b>${esc(a.name)}</b><small>/${esc(a.slug)} · ${esc(a.status)}</small></button>`).join("") || '<p class="small muted" style="margin:6px 0">No agents yet.</p>';
    if (select) await openAgent(select); else if (!agents.length) view("#empty");
  }
  $("#agentlist").onclick = (e) => { const b = e.target.closest("[data-slug]"); if (b) { history.replaceState(null, "", "?a=" + b.dataset.slug); openAgent(b.dataset.slug); } };
  $$("#agentlist button").forEach(() => {});

  async function openAgent(slug) {
    current = slug;
    $$("#agentlist button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.slug === slug)));
    view("#agent");
    try { detail = await api("owner_agent", { slug }); }
    catch (x) { view("#empty"); $("#empty").innerHTML = `<h2>${esc(x.message)}</h2>`; return; }
    const a = detail.agent, u = detail.usage;
    $("#a-name").textContent = a.name;
    $("#a-status").textContent = a.status; $("#a-status").className = "pill " + a.status;
    $("#a-version").textContent = `v${a.version} · updated ${when(a.updated_at)}`;
    $("#a-url").textContent = detail.url; $("#a-open").href = detail.url; $("#a-admin").textContent = detail.admin_url;
    $("#a-stats").innerHTML = stats([[u.members.filter((m) => m.status !== "revoked").length, "people approved"], [u.members.filter((m) => m.status === "active").length, "have signed in"], [u.replies, "replies, 30 days"], [a.payer_mode === "byok" ? "Own key" : "Platform key", "who pays"]]);
    // settings
    $("#s-name").value = a.name || ""; $("#s-model").value = a.model || ""; $("#s-description").value = a.description || "";
    $("#s-notice").value = a.notice || ""; $("#s-greeting").value = a.greeting || ""; $("#s-instructions").value = a.instructions || "";
    $("#s-access").value = a.access_mode; $("#s-domain").value = a.allowed_domain || ""; $("#s-daily").value = a.daily_replies_per_user;
    $("#s-budget").value = a.monthly_token_budget ?? ""; $("#s-status").value = a.status; setS("#s-msg", "");
    // people
    renderPeople(u.members);
    // key
    $("#k-mode").innerHTML = a.payer_mode === "byok"
      ? "This agent uses <b>its own Anthropic key</b>. Usage bills to that key's account."
      : "This agent uses the <b>platform key</b>. You pay; KarmanLang enforces the per-person and monthly limits in Settings.";
    $("#btn-key-clear").hidden = a.payer_mode !== "byok"; setS("#k-msg", "");
    // usage
    $("#u-stats").innerHTML = stats([[u.replies, "replies"], [fmtN(u.input_tokens), "input tokens"], [fmtN(u.output_tokens), "output tokens"],
      [u.estimated_cost_usd == null ? "—" : "$" + u.estimated_cost_usd.toFixed(2), "estimated cost"],
      [a.monthly_token_budget ? `${Math.round((u.tokens_this_month / a.monthly_token_budget) * 100)}%` : "No cap", "of monthly budget"]]);
    $("#u-note").textContent = `Last ${u.days} days.` + (u.cost_note ? " " + u.cost_note : "");
    $("#u-table").innerHTML = u.by_user.length ? `<thead><tr><th>Person</th><th>Replies</th><th>Tokens</th></tr></thead><tbody>${u.by_user.map((r) => `<tr><td>${esc(r.email)}</td><td>${r.replies}</td><td>${fmtN(r.tokens)}</td></tr>`).join("")}</tbody>` : `<tbody><tr><td class="muted">No usage yet.</td></tr></tbody>`;
    loadConvos();
  }
  const stats = (list) => list.map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");

  function renderPeople(members) {
    $("#people").innerHTML = members.length ? `<thead><tr><th>Email</th><th>Status</th><th>Role</th><th>First sign-in</th><th></th></tr></thead><tbody>${members.map((m) => `<tr>
      <td>${esc(m.email)}</td><td><span class="pill ${esc(m.status)}">${esc(m.status)}</span></td><td>${m.role === "admin" ? "Sees usage" : "User"}</td><td>${when(m.first_login_at)}</td>
      <td>${m.status === "revoked" ? `<button class="btn" data-restore="${esc(m.email)}">Restore</button>` : `<button class="btn danger" data-revoke="${esc(m.email)}">Remove</button>`}</td></tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="muted">No one approved yet.</td></tr></tbody>`;
  }
  $("#people").onclick = async (e) => {
    const r = e.target.closest("[data-revoke],[data-restore]"); if (!r) return;
    const email = r.dataset.revoke || r.dataset.restore;
    r.disabled = true;
    try {
      if (r.dataset.revoke) await api("owner_member", { slug: current, email, status: "revoked" });
      else await api("owner_invite", { slug: current, emails: [email] });
      await openAgent(current); selectTab("people");
    } catch (x) { setS("#inv-status", x.message, "err"); r.disabled = false; }
  };
  $("#btn-invite").onclick = async () => {
    const emails = $("#inv-emails").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!emails.length) { setS("#inv-status", "Add at least one email.", "err"); return; }
    $("#btn-invite").disabled = true; setS("#inv-status", "Approving…");
    try {
      const r = await api("owner_invite", { slug: current, emails, role: $("#inv-role").value });
      const sent = r.invited.filter((i) => i.email_sent).length, skipped = r.invited.filter((i) => i.status === "skipped").length;
      const notes = r.invited.filter((i) => !i.email_sent && i.status !== "skipped").map((i) => `${i.email}: ${i.note}`);
      setS("#inv-status", `Approved ${r.invited.length - skipped}. Emails sent: ${sent}.` + (skipped ? ` Skipped ${skipped} invalid.` : "") + (notes.length ? " " + notes.join("; ") : ""), notes.length ? "err" : "ok");
      $("#inv-emails").value = "";
      const msg = $("#inv-status").textContent, cls = $("#inv-status").className;
      await openAgent(current); selectTab("people"); $("#inv-status").textContent = msg; $("#inv-status").className = cls;
    } catch (x) { setS("#inv-status", x.message, "err"); } finally { $("#btn-invite").disabled = false; }
  };

  $("#settings").onsubmit = async (e) => {
    e.preventDefault();
    const budget = $("#s-budget").value.trim();
    const agent = { slug: current, name: $("#s-name").value, model: $("#s-model").value.trim(), description: $("#s-description").value,
      notice: $("#s-notice").value, greeting: $("#s-greeting").value, instructions: $("#s-instructions").value, access_mode: $("#s-access").value,
      allowed_domain: $("#s-domain").value, daily_replies_per_user: parseInt($("#s-daily").value, 10), monthly_token_budget: budget ? parseInt(budget, 10) : null, status: $("#s-status").value };
    if (!agent.instructions.trim()) { setS("#s-msg", "Instructions can't be empty.", "err"); return; }
    setS("#s-msg", "Saving…");
    try { await api("owner_deploy", { agent }); await loadAgents(current); selectTab("settings"); setS("#s-msg", "Saved as a new version.", "ok"); }
    catch (x) { setS("#s-msg", x.message, "err"); }
  };

  $("#btn-key").onclick = async () => {
    const key = $("#k-key").value.trim(); if (!key) return;
    try { await api("owner_key", { slug: current, key }); $("#k-key").value = ""; await openAgent(current); selectTab("key"); setS("#k-msg", "Key saved. This agent now uses it.", "ok"); }
    catch (x) { setS("#k-msg", x.message, "err"); }
  };
  $("#btn-key-clear").onclick = async () => {
    try { await api("owner_key", { slug: current, key: null }); await openAgent(current); selectTab("key"); setS("#k-msg", "Removed. The platform key pays again.", "ok"); }
    catch (x) { setS("#k-msg", x.message, "err"); }
  };

  async function loadConvos() {
    $("#c-transcript").innerHTML = "";
    try {
      const r = await api("owner_transcripts", { slug: current });
      $("#c-table").innerHTML = r.sessions.length ? `<thead><tr><th>Started</th><th>Person</th><th>Replies</th><th>Version</th><th></th></tr></thead><tbody>${r.sessions.map((s) => `<tr><td>${when(s.created_at)}</td><td>${esc(s.email)}</td><td>${s.replies}</td><td>v${s.agent_version}</td><td><button class="btn" data-sid="${esc(s.id)}">Read</button></td></tr>`).join("")}</tbody>` : `<tbody><tr><td class="muted">No conversations yet.</td></tr></tbody>`;
    } catch (x) { $("#c-table").innerHTML = `<tbody><tr><td>${esc(x.message)}</td></tr></tbody>`; }
  }
  $("#c-table").onclick = async (e) => {
    const b = e.target.closest("[data-sid]"); if (!b) return;
    const r = await api("owner_transcripts", { slug: current, sessionId: b.dataset.sid });
    $("#c-transcript").innerHTML = r.messages.map((m) => `<div class="${m.role === "user" ? "u" : ""}"><span class="eyebrow">${m.role === "user" ? "Person" : "Agent"} · ${when(m.created_at)}</span>\n${esc(m.content)}</div>`).join("");
    $("#c-transcript").scrollIntoView({ behavior: "smooth", block: "start" });
  };

  function selectTab(t) {
    $$("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.t === t)));
    $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t));
  }
  $("#tabs").onclick = (e) => { const b = e.target.closest("[data-t]"); if (b) selectTab(b.dataset.t); };

  /* ---------- new agent ---------- */
  $("#btn-new-agent").onclick = () => { $$("#agentlist button").forEach((b) => b.setAttribute("aria-current", "false")); view("#newagent"); $("#n-name").focus(); };
  $("#newagent").onsubmit = async (e) => {
    e.preventDefault();
    const agent = { name: $("#n-name").value.trim(), slug: $("#n-slug").value.trim() || undefined, instructions: $("#n-instructions").value, notice: $("#n-notice").value || undefined,
      invite: $("#n-invite").value.split(/[\s,;]+/).filter(Boolean) };
    if (!agent.name || !agent.instructions.trim()) { setS("#n-msg", "Name and instructions are required.", "err"); return; }
    setS("#n-msg", "Deploying…");
    try { const r = await api("owner_deploy", { agent }); $("#newagent").reset(); history.replaceState(null, "", "?a=" + r.agent.slug); await loadAgents(r.agent.slug); }
    catch (x) { setS("#n-msg", x.message, "err"); }
  };

  /* ---------- tokens ---------- */
  $("#btn-connect").onclick = async () => { $$("#agentlist button").forEach((b) => b.setAttribute("aria-current", "false")); view("#connect"); $("#tok-secret").hidden = true; renderTokens((await api("owner_tokens", {})).tokens); };
  $("#btn-tok").onclick = async () => {
    const r = await api("owner_tokens", { op: "create", name: $("#tok-name").value.trim() || "Deploy token" });
    $("#tok-url").textContent = r.connector_url;
    $("#tok-cli").textContent = `export KARMAN_TOKEN=${r.token}\nkarman agents`;
    $("#tok-secret").hidden = false; $("#tok-name").value = "";
    renderTokens((await api("owner_tokens", {})).tokens);
  };
  function renderTokens(tokens) {
    $("#tok-table").innerHTML = tokens.length ? `<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${when(t.created_at)}</td><td>${when(t.last_used_at)}</td><td>${t.revoked_at ? '<span class="pill revoked">revoked</span>' : `<button class="btn danger" data-tok="${esc(t.id)}">Revoke</button>`}</td></tr>`).join("")}</tbody>` : "";
  }
  $("#tok-table").onclick = async (e) => { const b = e.target.closest("[data-tok]"); if (b) renderTokens((await api("owner_tokens", { op: "revoke", id: b.dataset.tok })).tokens); };

  /* ---------- boot ---------- */
  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { $("#signin").hidden = false; return; }
    $("#who").hidden = false; $("#who-email").textContent = data.session.user.email;
    try {
      const me = await api("me");
      if (!me.owner) { $("#denied").hidden = false; $("#denied-msg").textContent = `${me.email} isn't set up to manage agents.`; return; }
      $("#signin").hidden = true; $("#console").hidden = false;
      const want = new URLSearchParams(location.search).get("a");
      await loadAgents(want || null);
      if (!want && agents.length) await openAgent(agents[0].slug);
    } catch (x) { $("#denied").hidden = false; $("#denied-msg").textContent = x.message; }
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && !$("#signin").hidden) { $("#signin").hidden = true; boot(); } });
  boot();
})();

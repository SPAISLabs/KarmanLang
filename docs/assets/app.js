(function () {
  const $ = (s) => document.querySelector(s);
  const { sb, api, esc, md, signInEmail, signInProvider, here } = window.KLCore;
  const slug = new URLSearchParams(location.search).get("a") || "";
  let sessionId = null, busy = false, agent = null;
  const show = (id) => ["#signin", "#home", "#denied", "#chat"].forEach((s) => ($(s).hidden = s !== id));
  const PROVIDER_LABEL = { google: "Continue with Google", azure: "Continue with Microsoft", github: "Continue with GitHub" };

  function renderProviders(list) {
    const p = (list || window.KL.providers).filter((x) => x !== "email" && PROVIDER_LABEL[x]);
    $("#provider-btns").innerHTML = p.map((x) => `<button class="btn block" type="button" data-p="${x}">${PROVIDER_LABEL[x]}</button>`).join("");
    $("#or").hidden = !p.length;
  }
  $("#provider-btns").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    try { await signInProvider(b.dataset.p, here()); } catch (x) { setSignin(x.message, true); }
  });
  const setSignin = (t, err) => { const s = $("#signin-status"); s.textContent = t; s.className = "status" + (err ? " err" : t ? " ok" : ""); };
  $("#email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setSignin("Enter a valid email address.", true); return; }
    $("#email-btn").disabled = true;
    try { await signInEmail(email, here()); setSignin(`Check ${email} for a sign-in link. You can close this tab.`); }
    catch (x) { setSignin(x.message || "Couldn't send the link. Try again.", true); }
    finally { $("#email-btn").disabled = false; }
  });
  $("#btn-signout").onclick = async () => { await sb.auth.signOut(); location.href = location.pathname + location.search; };
  $("#btn-switch").onclick = $("#btn-signout").onclick;

  /* ---------- chat ---------- */
  const log = $("#log");
  function addMsg(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "me" : "agent");
    el.innerHTML = `<span class="who">${role === "user" ? "You" : esc(agent?.name || "Agent")}</span><div class="bubble">${text ? md(text) : '<span class="thinking">Thinking…</span>'}</div>`;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
    return el;
  }
  const status = (t, err) => { const s = $("#status"); s.textContent = t || ""; s.className = "status" + (err ? " err" : ""); };
  const left = (n) => { $("#left").textContent = Number.isFinite(n) ? `${n} replies left today` : ""; };
  async function startChat() {
    status(""); log.innerHTML = "";
    try {
      const r = await api("start", { slug });
      agent = { ...agent, ...r.agent }; sessionId = r.sessionId;
      $("#agent-name").textContent = agent.name; $("#agent-desc").textContent = agent.description || "";
      document.title = agent.name + " · KarmanLang";
      left(r.remainingToday); show("#chat"); addMsg("assistant", r.greeting); $("#input").focus();
    } catch (x) {
      if (["not_member", "revoked", "paused"].includes(x.code)) { $("#denied-msg").textContent = x.message; show("#denied"); }
      else if (x.code === "signin") { show("#signin"); }
      else { show("#denied"); $("#denied-msg").textContent = x.message; }
    }
  }
  async function send(text) {
    if (busy || !sessionId) return;
    busy = true; $("#btn-send").disabled = true; status("");
    addMsg("user", text); const pending = addMsg("assistant", "");
    try {
      const r = await api("chat", { sessionId, message: text });
      pending.querySelector(".bubble").innerHTML = md(r.reply);
      left(r.remainingToday);
      if (r.truncated) status("That reply was cut short.");
    } catch (x) {
      pending.remove(); status(x.message, true);
      if (x.code === "signin") show("#signin");
    } finally { busy = false; $("#btn-send").disabled = false; $("#input").focus(); }
  }
  $("#compose").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; send(t); });
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#compose").requestSubmit(); } });
  $("#btn-new").onclick = startChat;

  /* ---------- boot ---------- */
  async function boot() {
    let providers = null;
    if (slug) {
      try {
        const p = await api("agent_public", { slug });
        agent = p; providers = p.providers;
        $("#brand-sub").textContent = "· " + p.name;
        $("#signin-h").textContent = p.name;
        $("#signin-sub").textContent = (p.description ? p.description + " " : "") + "Sign in with the email address you were approved with.";
        if (p.notice) { $("#notice").textContent = p.notice; $("#notice").hidden = false; }
        document.title = p.name + " · KarmanLang";
      } catch (x) { show("#denied"); $("#denied-msg").textContent = x.message; return; }
    }
    renderProviders(providers);
    const { data } = await sb.auth.getSession();
    if (!data.session) { show("#signin"); return; }
    $("#who").hidden = false; $("#who-email").textContent = data.session.user.email;
    try {
      const me = await api("me");
      $("#who-admin").hidden = !me.owner;
      if (slug) return startChat();
      show("#home");
      $("#home-list").innerHTML = me.agents.length
        ? me.agents.map((a) => `<p style="margin:0"><a href="${esc(window.KL.base + a.slug)}"><b>${esc(a.name)}</b></a><br><span class="small muted">${esc(a.description || "")}</span></p>`).join("")
        : `<p class="muted">No agents yet.${me.owner ? ' Deploy one from Claude, the command line, or the <a href="admin">admin page</a>.' : " Ask an agent's owner to approve your email."}</p>`;
    } catch (x) { show("#denied"); $("#denied-msg").textContent = x.message; }
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && $("#signin").hidden === false) boot(); });
  boot();
})();

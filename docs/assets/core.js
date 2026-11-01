// Shared client: Supabase auth session + calls to the karman function.
(function () {
  const sb = window.supabase.createClient(window.KL.supabaseUrl, window.KL.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });
  async function api(action, payload = {}) {
    const { data } = await sb.auth.getSession();
    const headers = { "content-type": "application/json", apikey: window.KL.publishableKey };
    if (data.session) headers.authorization = "Bearer " + data.session.access_token;
    let r;
    try { r = await fetch(window.KL.api, { method: "POST", headers, body: JSON.stringify({ action, ...payload }) }); }
    catch (e) { throw { code: "network", message: "Can't reach KarmanLang. Check your connection and try again." }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.error || "http_" + r.status, message: j.message || "Something went wrong. Try again.", status: r.status };
    return j;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Small, safe markdown: paragraphs, **bold**, *italic*, `code`, ``` blocks, - lists, 1. lists, # headings.
  function md(src) {
    const blocks = String(src).split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return `<pre><code>${esc(b.replace(/^[a-z]*\n/, ""))}</code></pre>`;
      return b.trim().split(/\n{2,}/).map((p) => {
        const lines = p.split("\n");
        const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*(\S.*?\S|\S)\*(?=\W|$)/g, "$1<i>$2</i>");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("") + "</ul>";
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return "<ol>" + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("") + "</ol>";
        const h = p.match(/^(#{1,4})\s+(.*)$/);
        if (h && lines.length === 1) return `<h4>${inline(h[2])}</h4>`;
        return `<p>${lines.map(inline).join("<br>")}</p>`;
      }).join("");
    }).join("");
  }
  async function signInEmail(email, redirectTo) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
    if (error) throw { message: error.message };
  }
  async function signInProvider(provider, redirectTo) {
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo, scopes: provider === "azure" ? "email" : undefined } });
    if (error) throw { message: error.message };
  }
  const here = () => location.origin + location.pathname + location.search;
  window.KLCore = { sb, api, esc, md, signInEmail, signInProvider, here };
})();

// Shared plumbing: database, settings, identity, agents, members, invites, metering, model calls.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const db: SupabaseClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon: SupabaseClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export class HttpError extends Error {
  constructor(public status: number, public code: string, msg: string) { super(msg); }
}
export const bad = (msg: string, code = "bad_request") => new HttpError(400, code, msg);

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(prefix: string, bytes = 24): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return prefix + btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ "+": "x", "/": "y", "=": "" }[c]!));
}

// ---------- settings ----------
let settingsCache: { at: number; v: Record<string, string> } | null = null;
export async function settings(): Promise<Record<string, string>> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.v;
  const { data } = await db.from("settings").select("key, value");
  const v = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  settingsCache = { at: Date.now(), v };
  return v;
}
export async function appUrl(): Promise<string> {
  const u = (await settings()).app_url || "";
  return u.endsWith("/") ? u : u + "/";
}
export async function agentUrls(slug: string) {
  const base = await appUrl();
  return { url: `${base}${slug}`, admin_url: `${base}admin?a=${slug}` };
}

// ---------- identity ----------
export type User = { id: string; email: string };
export async function userFromJwt(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const jwt = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!jwt || jwt.split(".").length !== 3) return null;
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}
export async function requireUser(req: Request): Promise<User> {
  const u = await userFromJwt(req);
  if (!u) throw new HttpError(401, "signin", "Please sign in.");
  return u;
}
export async function ownerFor(u: User): Promise<string | null> {
  const { data } = await db.from("owners").select("user_id").eq("user_id", u.id).maybeSingle();
  if (data) return data.user_id;
  const allowed = ((await settings()).owner_emails || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(u.email)) {
    await db.from("owners").upsert({ user_id: u.id, email: u.email });
    return u.id;
  }
  return null;
}
export async function requireOwner(req: Request): Promise<{ user: User; ownerId: string }> {
  const user = await requireUser(req);
  const ownerId = await ownerFor(user);
  if (!ownerId) throw new HttpError(403, "not_owner", "This account can't manage agents.");
  return { user, ownerId };
}
export async function ownerFromDeployToken(token: string): Promise<string> {
  if (!token || !token.startsWith("kl_")) throw new HttpError(401, "token", "Missing or invalid deploy token.");
  const { data } = await db.from("deploy_tokens").select("id, owner_id, revoked_at").eq("token_hash", await sha256(token)).maybeSingle();
  if (!data || data.revoked_at) throw new HttpError(401, "token", "Missing or invalid deploy token.");
  await db.from("deploy_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return data.owner_id;
}

// ---------- agents ----------
export const AGENT_FIELDS = ["name", "description", "instructions", "greeting", "model", "notice", "access_mode",
  "allowed_domain", "daily_replies_per_user", "monthly_token_budget", "status", "payer_mode"] as const;

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}
export function cleanPatch(input: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const str = (k: string, max: number) => { if (typeof input[k] === "string") p[k] = (input[k] as string).slice(0, max); };
  str("name", 80); str("description", 400); str("instructions", 60000); str("greeting", 1000); str("notice", 600);
  if (typeof input.model === "string" && /^claude-[a-z0-9.-]+$/.test(input.model)) p.model = input.model;
  if (input.access_mode === "invite_only" || input.access_mode === "domain") p.access_mode = input.access_mode;
  if (typeof input.allowed_domain === "string") p.allowed_domain = input.allowed_domain.toLowerCase().replace(/^@/, "").trim() || null;
  if (Number.isInteger(input.daily_replies_per_user)) p.daily_replies_per_user = Math.min(10000, Math.max(1, input.daily_replies_per_user as number));
  if (input.monthly_token_budget === null) p.monthly_token_budget = null;
  else if (Number.isInteger(input.monthly_token_budget) && (input.monthly_token_budget as number) > 0) p.monthly_token_budget = input.monthly_token_budget;
  if (input.status === "active" || input.status === "paused") p.status = input.status;
  if (input.payer_mode === "deployer" || input.payer_mode === "byok") p.payer_mode = input.payer_mode;
  return p;
}
export async function ownedAgent(ownerId: string, slug: string) {
  const { data } = await db.from("agents").select("*").eq("slug", String(slug ?? "")).eq("owner_id", ownerId).maybeSingle();
  if (!data) throw new HttpError(404, "no_agent", `No agent "${slug}" in your account.`);
  return data;
}
export async function audit(ownerId: string, agentId: string | null, actor: string, action: string, detail: unknown) {
  await db.from("audit").insert({ owner_id: ownerId, agent_id: agentId, actor, action, detail });
}

export async function deployAgent(ownerId: string, actor: string, input: Record<string, unknown>) {
  const patch = cleanPatch(input);
  const slug = slugify(String(input.slug || input.name || ""));
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw bad("Pick a name or slug of 3–40 letters, numbers, or dashes.");
  const { data: existing } = await db.from("agents").select("*").eq("slug", slug).maybeSingle();
  let agent;
  if (existing) {
    if (existing.owner_id !== ownerId) throw new HttpError(409, "slug_taken", `The address "${slug}" is taken. Choose another slug.`);
    const { data, error } = await db.from("agents").update({ ...patch, version: existing.version + 1, updated_at: new Date().toISOString() })
      .eq("id", existing.id).select("*").single();
    if (error) throw error;
    agent = data;
  } else {
    if (!patch.instructions) throw bad("Instructions (the agent's system prompt) are required for a new agent.");
    if (!patch.name) patch.name = String(input.slug || slug);
    const { data, error } = await db.from("agents").insert({ ...patch, slug, owner_id: ownerId }).select("*").single();
    if (error) throw error;
    agent = data;
  }
  if (agent.access_mode === "domain" && !agent.allowed_domain) {
    await db.from("agents").update({ access_mode: "invite_only" }).eq("id", agent.id);
    agent.access_mode = "invite_only";
  }
  await audit(ownerId, agent.id, actor, existing ? "update_agent" : "deploy_agent", { slug, version: agent.version });
  let invited: unknown[] = [];
  if (Array.isArray(input.invite) && input.invite.length) invited = await inviteMembers(ownerId, actor, agent, input.invite as string[], "user");
  return { agent: publicAgentView(agent), created: !existing, ...(await agentUrls(slug)), invited };
}

export function publicAgentView(a: any) {
  return {
    slug: a.slug, name: a.name, description: a.description, model: a.model, status: a.status, version: a.version,
    access_mode: a.access_mode, allowed_domain: a.allowed_domain, daily_replies_per_user: a.daily_replies_per_user,
    monthly_token_budget: a.monthly_token_budget, payer_mode: a.payer_mode, has_own_key: !!a.key_secret_id,
    notice: a.notice, greeting: a.greeting, updated_at: a.updated_at,
  };
}

// ---------- members & invites ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function inviteMembers(ownerId: string, actor: string, agent: any, emails: string[], role: "user" | "admin") {
  const out: { email: string; status: string; email_sent: boolean; note?: string }[] = [];
  const list = [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 200);
  for (const email of list) {
    if (!EMAIL_RE.test(email)) { out.push({ email, status: "skipped", email_sent: false, note: "not an email address" }); continue; }
    const { data: m } = await db.from("members").select("id, status").eq("agent_id", agent.id).eq("email", email).maybeSingle();
    if (m) await db.from("members").update({ status: m.status === "active" ? "active" : "invited", role }).eq("id", m.id);
    else await db.from("members").insert({ agent_id: agent.id, email, role });
    const sent = await sendApprovalEmail(agent, email);
    out.push({ email, status: m?.status === "active" ? "active" : "invited", email_sent: sent.ok, note: sent.note });
  }
  await audit(ownerId, agent.id, actor, "invite", { emails: list, role });
  return out;
}

async function sendApprovalEmail(agent: any, email: string): Promise<{ ok: boolean; note?: string }> {
  const { url } = await agentUrls(agent.slug);
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("KARMAN_FROM_EMAIL");
  if (resendKey && from) {
    const fromName = (await settings()).from_name || "KarmanLang";
    const html = `<p>You've been approved to use <b>${esc(agent.name)}</b>.</p>
      <p><a href="${url}">Open ${esc(agent.name)}</a> and sign in with this email address (${esc(email)}) using Google, Microsoft, or an email link.</p>
      ${agent.notice ? `<p style="color:#7a3b00">${esc(agent.notice)}</p>` : ""}<p style="color:#666">Sent by KarmanLang on behalf of the agent's owner.</p>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [email], subject: `You're approved for ${agent.name}`, html }),
    });
    return r.ok ? { ok: true } : { ok: false, note: "email service error" };
  }
  // Fallback: Supabase's own auth emails (low hourly limit on the default mail server).
  const { error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: url });
  if (!error) return { ok: true, note: "sent as a sign-up invitation" };
  if (/already|registered|exists/i.test(error.message)) {
    const { error: e2 } = await anon.auth.signInWithOtp({ email, options: { emailRedirectTo: url, shouldCreateUser: false } });
    return e2 ? { ok: false, note: "approved; email not sent (" + e2.message + ")" } : { ok: true, note: "sent as a sign-in link" };
  }
  return { ok: false, note: "approved; email not sent (" + error.message + ")" };
}
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Can this signed-in user use this agent? Returns the member row (auto-created for domain access or the owner).
export async function accessFor(user: User, agent: any) {
  if (agent.owner_id === user.id) return { role: "admin", daily_limit_override: null };
  const { data: m } = await db.from("members").select("*").eq("agent_id", agent.id).eq("email", user.email).maybeSingle();
  if (m && m.status === "revoked") throw new HttpError(403, "revoked", "Your access to this agent was removed.");
  if (m) {
    if (m.status !== "active" || m.user_id !== user.id) {
      await db.from("members").update({ status: "active", user_id: user.id, first_login_at: m.first_login_at ?? new Date().toISOString() }).eq("id", m.id);
    }
    return m;
  }
  if (agent.access_mode === "domain" && agent.allowed_domain && user.email.endsWith("@" + agent.allowed_domain)) {
    const { data } = await db.from("members").insert({ agent_id: agent.id, email: user.email, status: "active", user_id: user.id, first_login_at: new Date().toISOString() }).select("*").single();
    return data;
  }
  throw new HttpError(403, "not_member", `${user.email} hasn't been approved for this agent. Ask its owner to add you.`);
}

// ---------- metering ----------
export async function repliesLast24h(agentId: string, userId: string): Promise<number> {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("agent_id", agentId).eq("user_id", userId).eq("role", "assistant").gte("created_at", since);
  return count ?? 0;
}
export async function tokensThisMonth(agentId: string): Promise<number> {
  const d = new Date(); const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const { data } = await db.from("messages").select("input_tokens, output_tokens").eq("agent_id", agentId).eq("role", "assistant").gte("created_at", start).limit(100000);
  return (data ?? []).reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
}
export async function usageSummary(agent: any, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: rows } = await db.from("messages").select("user_id, input_tokens, output_tokens, created_at").eq("agent_id", agent.id).eq("role", "assistant").gte("created_at", since).limit(100000);
  const { data: price } = await db.from("model_prices").select("*").eq("model", agent.model).maybeSingle();
  const { data: members } = await db.from("members").select("email, user_id, status, role, first_login_at").eq("agent_id", agent.id);
  const byUser: Record<string, { replies: number; tokens: number }> = {};
  let tin = 0, tout = 0;
  for (const r of rows ?? []) {
    tin += r.input_tokens ?? 0; tout += r.output_tokens ?? 0;
    const k = r.user_id; byUser[k] ??= { replies: 0, tokens: 0 };
    byUser[k].replies++; byUser[k].tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
  }
  const emailOf = Object.fromEntries((members ?? []).filter((m) => m.user_id).map((m) => [m.user_id, m.email]));
  const cost = price ? (tin * Number(price.input_usd_per_mtok) + tout * Number(price.output_usd_per_mtok)) / 1e6 : null;
  return {
    days, replies: rows?.length ?? 0, input_tokens: tin, output_tokens: tout,
    estimated_cost_usd: cost == null ? null : Math.round(cost * 100) / 100,
    cost_note: price ? undefined : `No price set for ${agent.model}; cost not estimated.`,
    tokens_this_month: await tokensThisMonth(agent.id), monthly_token_budget: agent.monthly_token_budget,
    by_user: Object.entries(byUser).map(([uid, v]) => ({ email: emailOf[uid] ?? (uid === agent.owner_id ? "(owner)" : uid), ...v }))
      .sort((a, b) => b.replies - a.replies),
    members: (members ?? []).map((m) => ({ email: m.email, status: m.status, role: m.role, first_login_at: m.first_login_at })),
  };
}

// ---------- model ----------
export async function keyFor(agent: any): Promise<string> {
  if (agent.payer_mode === "byok") {
    const { data, error } = await db.rpc("kl_get_agent_key", { p_agent: agent.id });
    if (error || !data) throw new HttpError(503, "no_key", "This agent is set to use its owner's own key, but none is saved yet.");
    return data as string;
  }
  const k = Deno.env.get("ANTHROPIC_API_KEY");
  if (!k) throw new HttpError(503, "no_key", "The platform's model key isn't set up yet. Tell the agent's owner.");
  return k;
}
export async function callClaude(key: string, model: string, system: string, messages: { role: string; content: string }[]) {
  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("anthropic_error", r.status, JSON.stringify(j).slice(0, 400));
    if (r.status === 401) throw new HttpError(502, "bad_key", "The model key was rejected. The agent's owner needs to check it.");
    if (r.status === 404) throw new HttpError(502, "bad_model", "This agent's model isn't available. The owner should pick another.");
    if (r.status === 429 || r.status === 529) throw new HttpError(503, "busy", "The model is busy. Try again in a minute.");
    throw new HttpError(502, "upstream", "The model couldn't be reached. Try again.");
  }
  const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  if (!text) throw new HttpError(502, "empty", "The model returned an empty reply. Try again.");
  return { text, usage: j.usage ?? {}, latency: Date.now() - t0, stop: j.stop_reason };
}

// KarmanLang API. Routes (under /functions/v1/karman):
//   POST /api           JSON {action, ...}; signed-in users (Supabase session JWT)
//   POST /mcp[/<token>] deploy connector for Claude / ChatGPT / CLI (deploy token)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  accessFor, agentUrls, audit, bad, callClaude, db, deployAgent, HttpError, inviteMembers, keyFor, ownedAgent, ownerFor,
  publicAgentView, randomToken, repliesLast24h, requireOwner, requireUser, settings, sha256, tokensThisMonth, usageSummary, userFromJwt,
} from "./lib.ts";
import { handleMcp } from "./mcp.ts";

const MAX_MSG = 8000, HISTORY_KEEP = 30, MAX_SESSION_REPLIES = 150;

async function corsHeaders(req: Request): Promise<Record<string, string>> {
  const origin = req.headers.get("origin") ?? "";
  const app = new URL((await settings()).app_url || "https://example.invalid/").origin;
  const allowed = [app, "http://localhost:8000", "http://127.0.0.1:8000"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : app,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, mcp-session-id, mcp-protocol-version",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}

async function agentBySlug(slug: unknown) {
  const { data } = await db.from("agents").select("*").eq("slug", String(slug ?? "")).maybeSingle();
  if (!data) throw new HttpError(404, "no_agent", "There's no agent at this address.");
  return data;
}

// ---------- user actions ----------
async function agentPublic(body: any) {
  const a = await agentBySlug(body.slug);
  return { slug: a.slug, name: a.name, description: a.description, notice: a.notice, status: a.status, providers: ((await settings()).auth_providers || "email").split(",") };
}

async function me(req: Request) {
  const u = await requireUser(req);
  const owner = !!(await ownerFor(u));
  const { data: mem } = await db.from("members").select("agents(slug, name, description)").eq("email", u.email).neq("status", "revoked");
  const { data: own } = owner ? await db.from("agents").select("slug, name, description").eq("owner_id", u.id) : { data: [] };
  const seen = new Set<string>(); const agents = [];
  for (const a of [...(own ?? []), ...((mem ?? []).map((m: any) => m.agents).filter(Boolean))]) if (!seen.has(a.slug)) { seen.add(a.slug); agents.push(a); }
  return { email: u.email, owner, agents };
}

async function start(req: Request, body: any) {
  const u = await requireUser(req);
  const a = await agentBySlug(body.slug);
  if (a.status !== "active" && a.owner_id !== u.id) throw new HttpError(403, "paused", "This agent is paused by its owner.");
  const m = await accessFor(u, a);
  const { data, error } = await db.from("sessions").insert({ agent_id: a.id, user_id: u.id, agent_version: a.version }).select("id").single();
  if (error) throw error;
  const limit = m.daily_limit_override ?? a.daily_replies_per_user;
  return {
    sessionId: data.id, greeting: a.greeting || `Hi! I'm ${a.name}. How can I help?`,
    agent: { name: a.name, notice: a.notice, description: a.description }, role: m.role ?? "user",
    remainingToday: Math.max(0, limit - (await repliesLast24h(a.id, u.id))),
  };
}

async function chat(req: Request, body: any) {
  const u = await requireUser(req);
  const sid = String(body.sessionId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(sid)) throw bad("Unknown session.");
  const { data: s } = await db.from("sessions").select("*, agents(*)").eq("id", sid).eq("user_id", u.id).maybeSingle();
  if (!s) throw new HttpError(404, "no_session", "Unknown session. Start a new one.");
  const a = s.agents;
  if (a.status !== "active" && a.owner_id !== u.id) throw new HttpError(403, "paused", "This agent is paused by its owner.");
  const m = await accessFor(u, a);
  const msg = String(body.message ?? "").trim();
  if (!msg) throw bad("Type a message first.");
  if (msg.length > MAX_MSG) throw bad(`Keep messages under ${MAX_MSG} characters.`);
  const limit = m.daily_limit_override ?? a.daily_replies_per_user;
  if (await repliesLast24h(a.id, u.id) >= limit) throw new HttpError(429, "daily_limit", "You've reached today's limit for this agent. It resets over the next 24 hours.");
  if (a.monthly_token_budget && (await tokensThisMonth(a.id)) >= a.monthly_token_budget) throw new HttpError(429, "budget", "This agent has used its budget for the month. The owner can raise it.");

  const { data: prior } = await db.from("messages").select("idx, role, content").eq("session_id", sid).order("idx");
  const hist = prior ?? [];
  if (hist.filter((x) => x.role === "assistant").length >= MAX_SESSION_REPLIES) throw new HttpError(429, "session_full", "This conversation is at its length limit. Start a new one.");
  let ctx: { role: string; content: string }[] = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].role === "user" && hist[i + 1]?.role === "assistant") { ctx.push({ role: "user", content: hist[i].content }, { role: "assistant", content: hist[i + 1].content }); i++; }
  }
  ctx.push({ role: "user", content: msg });
  if (ctx.length > HISTORY_KEEP + 1) {
    let tail = ctx.slice(-HISTORY_KEEP); if (tail[0].role === "assistant") tail = tail.slice(1);
    ctx = [ctx[0], { role: "assistant", content: "(Earlier turns omitted.)" }, ...tail];
  }
  const nextIdx = hist.length ? hist[hist.length - 1].idx + 1 : 0;
  await db.from("messages").insert({ session_id: sid, agent_id: a.id, user_id: u.id, idx: nextIdx, role: "user", content: msg });
  const out = await callClaude(await keyFor(a), a.model, a.instructions, ctx);
  await db.from("messages").insert({
    session_id: sid, agent_id: a.id, user_id: u.id, idx: nextIdx + 1, role: "assistant", content: out.text,
    input_tokens: out.usage.input_tokens ?? null, output_tokens: out.usage.output_tokens ?? null, latency_ms: out.latency,
  });
  return { reply: out.text, truncated: out.stop === "max_tokens", remainingToday: Math.max(0, limit - (await repliesLast24h(a.id, u.id))) };
}

// ---------- owner actions ----------
async function ownerAgents(req: Request) {
  const { ownerId } = await requireOwner(req);
  const { data } = await db.from("agents").select("*").eq("owner_id", ownerId).order("updated_at", { ascending: false });
  return { agents: await Promise.all((data ?? []).map(async (a) => ({ ...publicAgentView(a), ...(await agentUrls(a.slug)) }))) };
}
async function ownerAgent(req: Request, body: any) {
  const { ownerId } = await requireOwner(req);
  const a = await ownedAgent(ownerId, body.slug);
  return { agent: { ...publicAgentView(a), instructions: a.instructions }, ...(await agentUrls(a.slug)), usage: await usageSummary(a, 30) };
}
async function ownerDeploy(req: Request, body: any) {
  const { ownerId, user } = await requireOwner(req);
  return await deployAgent(ownerId, user.email, body.agent ?? {});
}
async function ownerInvite(req: Request, body: any) {
  const { ownerId, user } = await requireOwner(req);
  const a = await ownedAgent(ownerId, body.slug);
  if (!Array.isArray(body.emails) || !body.emails.length) throw bad("Add at least one email.");
  return { invited: await inviteMembers(ownerId, user.email, a, body.emails, body.role === "admin" ? "admin" : "user") };
}
async function ownerMember(req: Request, body: any) {
  const { ownerId, user } = await requireOwner(req);
  const a = await ownedAgent(ownerId, body.slug);
  const email = String(body.email ?? "").trim().toLowerCase();
  const patch: Record<string, unknown> = {};
  if (["revoked", "invited"].includes(body.status)) patch.status = body.status;
  if (["user", "admin"].includes(body.role)) patch.role = body.role;
  if (body.daily_limit_override === null || Number.isInteger(body.daily_limit_override)) patch.daily_limit_override = body.daily_limit_override;
  const { data } = await db.from("members").update(patch).eq("agent_id", a.id).eq("email", email).select("email");
  if (!data?.length) throw new HttpError(404, "no_member", "That person isn't on this agent.");
  await audit(ownerId, a.id, user.email, "member_update", { email, ...patch });
  return { ok: true };
}
async function ownerKey(req: Request, body: any) {
  const { ownerId, user } = await requireOwner(req);
  const a = await ownedAgent(ownerId, body.slug);
  if (body.key === null) {
    await db.rpc("kl_clear_agent_key", { p_agent: a.id });
    await db.from("agents").update({ payer_mode: "deployer" }).eq("id", a.id);
    await audit(ownerId, a.id, user.email, "key_cleared", {});
    return { payer_mode: "deployer", has_own_key: false };
  }
  const key = String(body.key ?? "").trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw bad("That doesn't look like an Anthropic API key (it should start with sk-ant-).");
  const { error } = await db.rpc("kl_set_agent_key", { p_agent: a.id, p_key: key });
  if (error) throw error;
  await db.from("agents").update({ payer_mode: "byok" }).eq("id", a.id);
  await audit(ownerId, a.id, user.email, "key_set", { last4: key.slice(-4) });
  return { payer_mode: "byok", has_own_key: true };
}
async function ownerTranscripts(req: Request, body: any) {
  const { ownerId } = await requireOwner(req);
  const a = await ownedAgent(ownerId, body.slug);
  if (body.sessionId) {
    const { data: msgs } = await db.from("messages").select("idx, role, content, created_at").eq("session_id", body.sessionId).eq("agent_id", a.id).order("idx");
    return { messages: msgs ?? [] };
  }
  const { data: sessions } = await db.from("sessions").select("id, user_id, agent_version, created_at").eq("agent_id", a.id).order("created_at", { ascending: false }).limit(100);
  const { data: members } = await db.from("members").select("email, user_id").eq("agent_id", a.id);
  const emailOf = Object.fromEntries((members ?? []).filter((m) => m.user_id).map((m) => [m.user_id, m.email]));
  const ids = (sessions ?? []).map((s) => s.id);
  const { data: counts } = ids.length ? await db.from("messages").select("session_id").in("session_id", ids).eq("role", "assistant") : { data: [] };
  const n: Record<string, number> = {}; for (const c of counts ?? []) n[c.session_id] = (n[c.session_id] ?? 0) + 1;
  return { sessions: (sessions ?? []).map((s) => ({ ...s, email: emailOf[s.user_id] ?? (s.user_id === ownerId ? "(owner)" : "—"), replies: n[s.id] ?? 0 })) };
}
async function ownerTokens(req: Request, body: any) {
  const { ownerId, user } = await requireOwner(req);
  if (body.op === "create") {
    const token = randomToken("kl_");
    const name = String(body.name || "Deploy token").slice(0, 60);
    await db.from("deploy_tokens").insert({ owner_id: ownerId, name, token_hash: await sha256(token) });
    await audit(ownerId, null, user.email, "token_create", { name });
    const base = Deno.env.get("SUPABASE_URL") + "/functions/v1/karman/mcp";
    return { token, connector_url: `${base}/${token}`, endpoint: base };
  }
  if (body.op === "revoke") {
    await db.from("deploy_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", body.id).eq("owner_id", ownerId);
    await audit(ownerId, null, user.email, "token_revoke", { id: body.id });
  }
  const { data } = await db.from("deploy_tokens").select("id, name, created_at, last_used_at, revoked_at").eq("owner_id", ownerId).order("created_at", { ascending: false });
  return { tokens: data ?? [] };
}

Deno.serve(async (req) => {
  const h = await corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "content-type": "application/json" } });
  const path = new URL(req.url).pathname.replace(/^.*\/karman/, "");
  try {
    const mcp = path.match(/^\/mcp(?:\/([A-Za-z0-9_-]+))?\/?$/);
    if (mcp) return await handleMcp(req, mcp[1] ?? null, h);
    if (req.method !== "POST") return json({ error: "method", message: "POST only." }, 405);
    const body = await req.json().catch(() => ({}));
    switch (body?.action) {
      case "agent_public": return json(await agentPublic(body));
      case "me": return json(await me(req));
      case "start": return json(await start(req, body));
      case "chat": return json(await chat(req, body));
      case "owner_agents": return json(await ownerAgents(req));
      case "owner_agent": return json(await ownerAgent(req, body));
      case "owner_deploy": return json(await ownerDeploy(req, body));
      case "owner_invite": return json(await ownerInvite(req, body));
      case "owner_member": return json(await ownerMember(req, body));
      case "owner_key": return json(await ownerKey(req, body));
      case "owner_transcripts": return json(await ownerTranscripts(req, body));
      case "owner_tokens": return json(await ownerTokens(req, body));
      default: return json({ error: "action", message: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error("karman_error", e);
    return json({ error: "server", message: "Something went wrong on the server. Try again." }, 500);
  }
});

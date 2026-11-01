// KarmanLang deploy connector: a remote MCP server (Streamable HTTP, JSON responses).
// Add it in Claude or ChatGPT as a custom connector; authenticate with a deploy token
// either in the URL (/karman/mcp/<token>) or as "Authorization: Bearer <token>".
import { agentUrls, audit, bad, db, deployAgent, HttpError, inviteMembers, ownedAgent, ownerFromDeployToken, publicAgentView, usageSummary, cleanPatch } from "./lib.ts";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "karmanlang", title: "KarmanLang", version: "0.1.0" };
const INSTRUCTIONS = `KarmanLang turns an agent into a private web app that only approved people can use.
Typical flow: deploy_agent (name + the agent's full instructions), then invite_members with email addresses.
When the user says "deploy this agent" from inside a project or custom assistant, pass that assistant's full instructions as "instructions".
Never ask the user to paste an API key into chat; model keys are added on the agent's admin page.`;

const str = (d: string) => ({ type: "string", description: d });
const int = (d: string) => ({ type: "integer", description: d });
const AGENT_PROPS = {
  name: str("Display name, e.g. 'NQRY Tutor'."),
  slug: str("Web address part, e.g. 'nqry' gives …/nqry. Defaults from the name. Reusing an existing slug updates that agent."),
  instructions: str("The agent's full system prompt. Required for a new agent."),
  description: str("One line shown on the sign-in page."),
  greeting: str("First message users see."),
  notice: str("Banner shown on every page, e.g. 'Educators only. Not for student use.'"),
  model: str("Claude model id. Default claude-sonnet-5-5."),
  access_mode: { type: "string", enum: ["invite_only", "domain"], description: "invite_only (default): only invited emails. domain: anyone with an email at allowed_domain." },
  allowed_domain: str("For access_mode=domain, e.g. 'myschool.org'."),
  daily_replies_per_user: int("Max agent replies per person per 24 h. Default 100."),
  monthly_token_budget: int("Optional cap on total tokens per calendar month for this agent."),
};

const TOOLS = [
  { name: "list_agents", title: "List my agents", description: "List the agents deployed in this KarmanLang account with their web and admin links.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "deploy_agent", title: "Deploy agent", description: "Create a private web app for an agent, or update it if the slug already exists. Returns the user link and the admin link. Defaults: invite-only access, the owner's platform key pays, 100 replies per person per day.",
    inputSchema: { type: "object", properties: { ...AGENT_PROPS, invite: { type: "array", items: { type: "string" }, description: "Emails to approve right away." } }, required: ["name"] } },
  { name: "update_agent", title: "Update agent", description: "Change an existing agent's instructions or settings. Each change creates a new version.",
    inputSchema: { type: "object", properties: { ...AGENT_PROPS, status: { type: "string", enum: ["active", "paused"] } }, required: ["slug"] } },
  { name: "describe_agent", title: "Describe agent", description: "Show an agent's settings, links, and members.",
    inputSchema: { type: "object", properties: { slug: str("Agent slug.") }, required: ["slug"] }, annotations: { readOnlyHint: true } },
  { name: "invite_members", title: "Approve people", description: "Approve email addresses for an agent and send each an email saying they've been approved and how to sign in.",
    inputSchema: { type: "object", properties: { slug: str("Agent slug."), emails: { type: "array", items: { type: "string" } }, role: { type: "string", enum: ["user", "admin"], description: "admin can view usage. Default user." } }, required: ["slug", "emails"] } },
  { name: "revoke_member", title: "Remove access", description: "Remove a person's access to an agent.",
    inputSchema: { type: "object", properties: { slug: str("Agent slug."), email: str("Email to remove.") }, required: ["slug", "email"] }, annotations: { destructiveHint: true } },
  { name: "get_usage", title: "Usage", description: "Replies, tokens, estimated cost, and per-person usage for an agent.",
    inputSchema: { type: "object", properties: { slug: str("Agent slug."), days: int("Look-back window in days. Default 30.") }, required: ["slug"] }, annotations: { readOnlyHint: true } },
];

async function runTool(ownerId: string, name: string, args: any) {
  const actor = "mcp";
  switch (name) {
    case "list_agents": {
      const { data } = await db.from("agents").select("*").eq("owner_id", ownerId).order("updated_at", { ascending: false });
      return { agents: await Promise.all((data ?? []).map(async (a) => ({ ...publicAgentView(a), ...(await agentUrls(a.slug)) }))) };
    }
    case "deploy_agent": return await deployAgent(ownerId, actor, args ?? {});
    case "update_agent": {
      const a = await ownedAgent(ownerId, args?.slug);
      return await deployAgent(ownerId, actor, { ...cleanPatch(args ?? {}), slug: a.slug });
    }
    case "describe_agent": {
      const a = await ownedAgent(ownerId, args?.slug);
      const { data: members } = await db.from("members").select("email, role, status, first_login_at").eq("agent_id", a.id).order("invited_at");
      return { ...publicAgentView(a), instructions_preview: String(a.instructions).slice(0, 600), ...(await agentUrls(a.slug)), members };
    }
    case "invite_members": {
      const a = await ownedAgent(ownerId, args?.slug);
      if (!Array.isArray(args?.emails) || !args.emails.length) throw bad("Give at least one email.");
      return { invited: await inviteMembers(ownerId, actor, a, args.emails, args.role === "admin" ? "admin" : "user"), ...(await agentUrls(a.slug)) };
    }
    case "revoke_member": {
      const a = await ownedAgent(ownerId, args?.slug);
      const email = String(args?.email ?? "").trim().toLowerCase();
      const { data } = await db.from("members").update({ status: "revoked" }).eq("agent_id", a.id).eq("email", email).select("email");
      if (!data?.length) throw new HttpError(404, "no_member", `${email} isn't a member of ${a.slug}.`);
      await audit(ownerId, a.id, actor, "revoke", { email });
      return { revoked: email };
    }
    case "get_usage": {
      const a = await ownedAgent(ownerId, args?.slug);
      return await usageSummary(a, Number.isInteger(args?.days) ? Math.min(365, Math.max(1, args.days)) : 30);
    }
  }
  throw new HttpError(400, "unknown_tool", `Unknown tool ${name}.`);
}

function rpc(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

export async function handleMcp(req: Request, pathToken: string | null, headers: Record<string, string>): Promise<Response> {
  const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(o), { status, headers: { ...headers, ...extra, "content-type": "application/json" } });
  if (req.method === "GET") return new Response("KarmanLang MCP endpoint. Use POST.", { status: 405, headers: { ...headers, allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(null, { status: 405, headers });

  const auth = req.headers.get("authorization") ?? "";
  const token = pathToken || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  let ownerId: string;
  try { ownerId = await ownerFromDeployToken(token); }
  catch { return json(rpcErr(null, -32001, "Missing or invalid KarmanLang deploy token. Create one on the admin page."), 401); }

  const body = await req.json().catch(() => null);
  if (!body) return json(rpcErr(null, -32700, "Parse error"), 400);
  const batch = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const m of batch) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(rpcErr(m?.id ?? null, -32600, "Invalid request")); continue; }
    const isNote = m.id === undefined || m.id === null;
    try {
      switch (m.method) {
        case "initialize": {
          const want = m.params?.protocolVersion;
          out.push(rpc(m.id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS }));
          break;
        }
        case "ping": out.push(rpc(m.id, {})); break;
        case "tools/list": out.push(rpc(m.id, { tools: TOOLS })); break;
        case "tools/call": {
          try {
            const r = await runTool(ownerId, m.params?.name, m.params?.arguments ?? {});
            out.push(rpc(m.id, { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r }));
          } catch (e) {
            const msg = e instanceof HttpError ? e.message : "Something went wrong on the KarmanLang server.";
            if (!(e instanceof HttpError)) console.error("mcp_tool_error", e);
            out.push(rpc(m.id, { content: [{ type: "text", text: msg }], isError: true }));
          }
          break;
        }
        default:
          if (!isNote) out.push(rpcErr(m.id, -32601, `Method not found: ${m.method}`));
      }
    } catch (e) {
      console.error("mcp_error", e);
      if (!isNote) out.push(rpcErr(m.id, -32603, "Internal error"));
    }
  }
  if (!out.length) return new Response(null, { status: 202, headers });
  return json(Array.isArray(body) ? out : out[0]);
}

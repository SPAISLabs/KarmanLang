#!/usr/bin/env node
// karman: deploy and manage KarmanLang agents from a terminal.
// Talks to the same MCP endpoint Claude and ChatGPT use. Needs Node 18+.
//   export KARMAN_TOKEN=kl_...            (create one on the admin page → Connect)
//   karman deploy nqry --name "NQRY Tutor" --instructions prompt.md --invite ana@school.org
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT = process.env.KARMAN_ENDPOINT || "https://nouuodihcgddrdyfkoca.supabase.co/functions/v1/karman/mcp";
const TOKEN = process.env.KARMAN_TOKEN || "";
const CACHE = join(homedir(), ".cache", "karman", "agents.txt");

const HELP = `karman — deploy agents as private web apps

  karman agents                         list your agents
  karman deploy <slug> [options]        create or update an agent
      --name "Display name"   --instructions <file|->   --description "…"
      --greeting "…"          --notice "…"              --model <id>
      --daily <n>             --budget <tokens/month>   --domain <example.org>
      --invite a@x.org,b@y.org
  karman show <slug>                    settings, links, members
  karman invite <slug> <email>...       approve people and email them
  karman revoke <slug> <email>          remove access
  karman pause <slug> | resume <slug>
  karman usage <slug> [--days 30]
  karman completion bash|zsh            print shell completion (eval it)

Environment: KARMAN_TOKEN (required), KARMAN_ENDPOINT (optional)`;

let rpcId = 0;
async function call(name, args = {}) {
  if (!TOKEN) die("Set KARMAN_TOKEN first. Create a token on the KarmanLang admin page → Connect.");
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }).catch(() => die("Can't reach KarmanLang. Check your connection."));
  const j = await r.json().catch(() => die(`Unexpected response (HTTP ${r.status}).`));
  if (j.error) die(j.error.message);
  const res = j.result;
  if (res.isError) die(res.content?.[0]?.text || "Request failed.");
  return res.structuredContent ?? JSON.parse(res.content[0].text);
}
function die(msg) { console.error("karman: " + msg); process.exit(1); }

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; opt[k] = v; }
    else pos.push(a);
  }
  return { pos, opt };
}
function readInstructions(src) {
  if (src === "-") return readFileSync(0, "utf8");
  if (existsSync(src)) return readFileSync(src, "utf8");
  return src;
}
function cacheAgents(list) { try { mkdirSync(join(homedir(), ".cache", "karman"), { recursive: true }); writeFileSync(CACHE, list.join("\n")); } catch {} }
const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
const int = (v, name) => { const n = parseInt(v, 10); if (!Number.isInteger(n)) die(`--${name} needs a number.`); return n; };

const COMPLETION = {
  bash: `_karman() {
  local cur prev cmds; cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[1]}"
  cmds="agents deploy show invite revoke pause resume usage completion"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "$cmds" -- "$cur") ); return; fi
  if [ "$COMP_CWORD" -eq 2 ] && [[ " deploy show invite revoke pause resume usage " == *" $prev "* ]]; then
    COMPREPLY=( $(compgen -W "$(karman __slugs 2>/dev/null)" -- "$cur") ); return; fi
  if [[ "$cur" == --* ]] && [ "$prev" = deploy ]; then
    COMPREPLY=( $(compgen -W "--name --instructions --description --greeting --notice --model --daily --budget --domain --invite" -- "$cur") ); fi
}
complete -F _karman karman`,
  zsh: `_karman() {
  local -a cmds; cmds=(agents deploy show invite revoke pause resume usage completion)
  if (( CURRENT == 2 )); then compadd -- $cmds; return; fi
  if (( CURRENT == 3 )); then compadd -- \${(f)"$(karman __slugs 2>/dev/null)"}; return; fi
  [[ $words[2] == deploy ]] && compadd -- --name --instructions --description --greeting --notice --model --daily --budget --domain --invite
}
compdef _karman karman`,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h": return out(HELP);
    case "completion": return out(COMPLETION[pos[0]] || die("Use: karman completion bash|zsh"));
    case "__slugs": {
      try { out(readFileSync(CACHE, "utf8")); } catch {}
      if (TOKEN) { try { const r = await call("list_agents"); cacheAgents(r.agents.map((a) => a.slug)); } catch {} }
      return;
    }
    case "agents": {
      const r = await call("list_agents");
      cacheAgents(r.agents.map((a) => a.slug));
      if (!r.agents.length) return out("No agents yet. Try: karman deploy my-agent --name \"My Agent\" --instructions prompt.md");
      return out(r.agents.map((a) => `${a.slug.padEnd(22)} ${a.status.padEnd(7)} ${a.name}\n${"".padEnd(31)}${a.url}`).join("\n"));
    }
    case "deploy": {
      const slug = pos[0] || die("Give a slug: karman deploy <slug> --instructions prompt.md");
      const args = { slug, name: opt.name || slug };
      if (opt.instructions) args.instructions = readInstructions(opt.instructions);
      for (const k of ["description", "greeting", "notice", "model"]) if (typeof opt[k] === "string") args[k] = opt[k];
      if (opt.daily) args.daily_replies_per_user = int(opt.daily, "daily");
      if (opt.budget) args.monthly_token_budget = int(opt.budget, "budget");
      if (opt.domain) { args.access_mode = "domain"; args.allowed_domain = opt.domain; }
      if (opt.invite) args.invite = String(opt.invite).split(",").map((s) => s.trim()).filter(Boolean);
      const r = await call("deploy_agent", args);
      out(`${r.created ? "Deployed" : "Updated"} ${r.agent.name} (v${r.agent.version})\n  Users:  ${r.url}\n  Admin:  ${r.admin_url}`);
      for (const i of r.invited || []) out(`  ${i.email}: ${i.status}${i.email_sent ? ", emailed" : i.note ? " (" + i.note + ")" : ""}`);
      return;
    }
    case "show": return out(await call("describe_agent", { slug: pos[0] }));
    case "invite": {
      if (pos.length < 2) die("Use: karman invite <slug> <email>...");
      const r = await call("invite_members", { slug: pos[0], emails: pos.slice(1), role: opt.admin ? "admin" : "user" });
      return out(r.invited.map((i) => `${i.email}: ${i.status}${i.email_sent ? ", emailed" : i.note ? " (" + i.note + ")" : ""}`).join("\n"));
    }
    case "revoke": return out(await call("revoke_member", { slug: pos[0], email: pos[1] }));
    case "pause": case "resume": {
      const r = await call("update_agent", { slug: pos[0], status: cmd === "pause" ? "paused" : "active" });
      return out(`${r.agent.slug} is now ${r.agent.status}.`);
    }
    case "usage": {
      const r = await call("get_usage", { slug: pos[0], days: opt.days ? int(opt.days, "days") : 30 });
      out(`Last ${r.days} days: ${r.replies} replies, ${r.input_tokens.toLocaleString()} in / ${r.output_tokens.toLocaleString()} out tokens` +
        (r.estimated_cost_usd != null ? `, about $${r.estimated_cost_usd.toFixed(2)}` : ""));
      for (const u of r.by_user) out(`  ${u.email.padEnd(32)} ${String(u.replies).padStart(5)} replies`);
      return;
    }
    default: die(`Unknown command "${cmd}". Run karman help.`);
  }
}
main();

# KarmanLang

Deploy an AI agent as a private web app, from inside Claude, ChatGPT, or a terminal.
Say "deploy this agent," get a link, and hand each person an access code.

```
Claude / ChatGPT ──┐                       ┌─ /<slug>   chat page; people sign in with an access code
  (connector)      │  POST /mcp/<token>    ├─ /admin    your console; you sign in with ADMIN_PASSWORD
karman CLI ────────┴──────────────────────▶│  Cloudflare Worker (this repo)
                                           ├─ /api      JSON API for both pages
                                           └─ D1 database: agents, codes, conversations, usage
```

## How it works

| | |
|---|---|
| **Deploy** | `deploy_agent` from Claude/ChatGPT, `karman deploy` in a terminal, or **+ New** on `/admin`. Re-deploying a slug makes a new version. |
| **Access** | You generate one code per person (`XXXX-XXXX-XXXX`). They enter it on the agent page, or open the one-click link that carries it. Codes can expire, have their own daily limit, and be turned off anytime. |
| **Admin** | Only you: `/admin` with `ADMIN_PASSWORD`. Agents, codes, settings, usage per person, full conversations, connector tokens. |
| **Who pays** | The `ANTHROPIC_API_KEY` set on the Worker. |
| **Limits** | Replies per person per day (per agent, overridable per code), message size, conversation length. Failed sign-ins are throttled. |
| **Security** | Codes and session tokens are stored only as SHA-256 hashes. Sessions are HttpOnly, Secure, SameSite cookies. The API only accepts same-site requests. |

## Setup (once)

1. **Cloudflare account** and a **D1 database** named `karmanlang` (its ID is in `wrangler.jsonc`).
2. **Workers & Pages → Create → Import a repository** → `SPAISLabs/KarmanLang` → Deploy. Every push to `main` redeploys.
3. **Worker → Settings → Variables and Secrets**, add two secrets:
   - `ANTHROPIC_API_KEY`: your Anthropic key
   - `ADMIN_PASSWORD`: the password for `/admin`
4. Open `https://karmanllm.seantucker.workers.dev/admin`, sign in, open **Connect**, create a connector token, and add the connector URL in Claude (Settings → Connectors → Add custom connector).

The database tables are created automatically on first use.

## Agents in this repo (source of truth)

`agents/agents.json` lists each agent by slug with its name, settings, and the `.md` file holding its full instructions.
Change the `.md`, then deploy it:

```bash
karman check          # which agents changed in the repo but aren't deployed yet
karman sync nqry      # deploy nqry from agents/agents.json + agents/nqry.md
karman status         # dashboard: codes, people, replies, last activity, expiring codes
```

The admin page's **Dashboard** shows the same overview. The KarmanLang Operator (a Claude skill) uses these
connector tools to do all of this from chat, and a weekly check-in reports drift, expiring codes and usage.

## Connector tools (MCP)

`overview`, `list_agents`, `deploy_agent`, `update_agent`, `describe_agent`, `create_code`, `list_codes`, `revoke_code`, `get_usage`.
`overview`, `describe_agent` and `deploy_agent` return `instructions_sha256` so the deployed prompt can be compared with the repo file.

## CLI

```bash
npm i -g ./cli            # or: node cli/karman.mjs …
export KARMAN_ENDPOINT=https://karmanllm.seantucker.workers.dev/mcp
export KARMAN_TOKEN=kl_…  # admin page → Connect
eval "$(karman completion bash)"

karman deploy nqry --name "NQRY Tutor" --instructions agents/nqry.md --notice "Educators only. Not for student use."
karman code nqry "Ana – Lincoln HS" --days 30
karman codes nqry
karman uncode nqry Ana
karman usage nqry --days 7
karman pause nqry
```

## Local development

```bash
npx wrangler dev          # uses a local D1 database
```
Put `ADMIN_PASSWORD` and `ANTHROPIC_API_KEY` in `.dev.vars` (git-ignored).

## Known limits (v0.3)

- Claude models only.
- Plain chat UI. Agent-specific interfaces (like NQRY's graph board) aren't supported yet.
- Agent tools and knowledge files don't carry over; only instructions do.
- A code works for whoever has it. Usage shows which code each reply came from, so a shared code is visible and can be turned off.

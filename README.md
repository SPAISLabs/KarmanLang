# KarmanLang

Deploy an AI agent as a private web app, from inside Claude, ChatGPT, or a terminal.
Say "deploy this agent," get a link people sign in to and an `/admin` page where you approve them.

```
Claude / ChatGPT ──┐                               ┌── docs/  (GitHub Pages)
   (custom         │   POST /karman/mcp/<token>    │   /<slug>   chat for approved people
    connector)     ├──────────────────────────────▶│   /admin    owner console
karman CLI ────────┘     Supabase Edge Function    │
                         `karman`                  └── Supabase Auth (email link, Google, Microsoft)
                             │  holds the model key, meters usage, enforces limits
                             ▼
                         Postgres (RLS locked; only the function reads/writes) + Vault (per-agent keys)
```

## What it does (v0.1)

| | |
|---|---|
| **Deploy** | `deploy_agent` from Claude/ChatGPT, `karman deploy` from a terminal, or **+ New** on `/admin`. Re-deploying a slug creates a new version. |
| **Sign-in** | Email link out of the box; Google and Microsoft once enabled in Supabase Auth. |
| **Access** | Invite-only by email (default) or anyone at a domain. Approved people get an email saying they're approved and how to sign in. Remove access anytime. |
| **Who pays** | Default: the platform key (you pay). Per agent: its own Anthropic key, stored encrypted in Vault. |
| **Limits** | Replies per person per day, optional monthly token budget per agent, per-session length, message size. |
| **Admin** | Links, people, settings, model & billing, usage by person, full conversations, deploy tokens. |

## Connector tools (MCP)

`list_agents`, `deploy_agent`, `update_agent`, `describe_agent`, `invite_members`, `revoke_member`, `get_usage`.
API keys are never accepted through chat; they're entered on the admin page.

## CLI

```bash
npm i -g ./cli            # or: node cli/karman.mjs …
export KARMAN_TOKEN=kl_…  # admin page → Connect → Create deploy token
eval "$(karman completion bash)"   # tab-completes commands and agent names

karman deploy nqry --name "NQRY Tutor" --instructions agents/nqry.md \
  --notice "Educators only. Not for student use." --invite ana@school.org
karman agents
karman invite nqry ben@school.org
karman usage nqry --days 7
karman pause nqry
```

## One-time setup

1. **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `/docs`.
2. **Supabase Auth → URL Configuration** (project `karmanlang`):
   Site URL `https://seantucker-spais.github.io/KarmanLang/`; add redirect URL `https://seantucker-spais.github.io/KarmanLang/**`.
3. **Edge Function secrets** (project `karmanlang` → Edge Functions → Secrets):
   - `ANTHROPIC_API_KEY`: the platform key (required for the default "you pay" mode).
   - `RESEND_API_KEY` and `KARMAN_FROM_EMAIL` (optional): branded "you're approved" emails. Without them, Supabase's built-in emails are used, which allow only a few per hour.
4. **Google / Microsoft sign-in (optional):** enable the providers in Supabase Auth, then set `providers: ["email","google","azure"]` in `docs/assets/config.js` and `update settings set value='email,google,azure' where key='auth_providers'` (insert if missing).
5. **Sign in at `/admin`** with an owner email (`settings.owner_emails`), open **Connect**, create a deploy token, and add the connector URL in Claude (Settings → Connectors → Add custom connector).

Optional: add model prices so the admin page estimates cost:
```sql
insert into model_prices(model, input_usd_per_mtok, output_usd_per_mtok) values ('claude-sonnet-5-5', <in>, <out>);
```

## Deploying the function

```bash
supabase functions deploy karman --no-verify-jwt --project-ref nouuodihcgddrdyfkoca
```
`--no-verify-jwt` is intentional: the function checks Supabase sessions itself and accepts deploy tokens on `/mcp`.

## Known limits (v0.1)

- Claude models only; OpenAI routing is next.
- Plain chat UI. Agent-specific interfaces (like NQRY's graph board) aren't supported yet.
- Agent tools and knowledge files don't carry over; only instructions do.
- The connector authenticates with a token in its URL. OAuth for the connector directories comes before public listing.

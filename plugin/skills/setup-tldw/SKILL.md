---
name: setup-tldw
description: Configure or diagnose an API key connection to the tldw.sh SaaS through REST, MCP or the agent plugin without collecting secrets in the conversation.
---

Connect to the user's existing tldw.sh SaaS deployment. Any HTTP client or agent
can use its REST API with a scoped API key; MCP and this plugin are optional client
integrations over the same jobs, permissions and usage. The plugin does not install
a local media processor or create provider accounts.

For a new Free account, have the user sign in to the web app and activate the
500-credit monthly caption/text allowance once, including configured account
and bot verification. Do not automate or bypass that human activation. Their API key,
MCP client and plugin then reuse the same entitlement without a CAPTCHA per call.
Polling and connection checks do not consume analyses. Creating or rotating keys
does not reset account usage.

The web app's `/agents` page provides a configured package command. Its CLI `init`
prepares a new local plugin directory and prints native client commands; it does
not write a key, change global settings or install itself into a client. Respect
its refusal to overwrite existing work. The CLI's `doctor` checks the REST/MCP
connection without submitting processing. Browser verification remains a human
step and no package command bypasses it.

Have the user create an API key in **API keys**. Media analysis, video summaries and
TikTok comparisons normally need jobs:write, jobs:read and summaries:read. Media
submission returns a job receipt; poll get_job, then fetch get_summary only after
completion. Status access alone does not expose content.
Add account:read for usage, both chat scopes for later questions, and uploads:write
for subtitle ingestion. Additional scopes depend on the requested feature.

Keep the key in a client-supported secret store or `TLDW_API_TOKEN`, never in
this conversation, a committed file, a manifest or command arguments. REST sends
`Authorization: Bearer` to the operator's API origin. MCP uses its `/mcp` endpoint
and requires remote Streamable HTTP with custom Authorization headers. The packaged
`.invalid` address is intentionally nonworking; use the README's client-specific
configuration. Claude Code/Grok Build also accept `TLDW_MCP_URL`; Codex uses an
explicit JSON/TOML URL and `bearer_token_env_var` for the key.

Cursor uses its dedicated `.cursor-plugin/plugin.json` and `cursor.mcp.json`.
Its manifest declares the required `TLDW_API_TOKEN` plugin variable; have the user
configure the value through Cursor's private plugin configuration. Its separate
direct-MCP example reads `${env:TLDW_API_TOKEN}` from the client environment.
Use the README's supported setup for that client's available features; never
paste a token into either file or copy a global configuration without permission.

When configuration changes are requested, preserve unrelated settings and avoid
duplicate connections. This package has no installer or hook that changes global
configuration automatically. This package configures API-key authentication.
The server also supports OAuth discovery and browser consent. If the user chooses
OAuth in a compatible MCP client, add the deployment's full `/mcp` URL using that
client's connection interface and let its browser flow handle login and permission
approval. Reuse an existing authorized connection; never request access tokens,
refresh tokens or OAuth client secrets in chat.

Verify MCP initialization and tool discovery, then call `list_styles` as a
read-only connection check. The current server exposes 29 tools. Use
`account_usage` only with account:read. Do not submit processing work, contact
support or publish content merely to test setup. A connection check does not
verify production transcription, AI quality or payments.

For the operator's explicitly enabled local development profile, a native client
on the same machine can use `http://localhost:8000/mcp` with no Authorization
header. A client requiring the packaged token setting can use the non-secret
`dev-user` local user marker. This is limited to direct loopback requests in
development; it does not grant admin access. A hosted model cannot connect to
your laptop's localhost. Keep the separate private `DEV_ADMIN_KEY` in the local
operator UI; never put it in a distributed plugin. Production uses a scoped key.

For TRIAL_ACTIVATION_REQUIRED, direct the user back to the signed-in browser.
For TRIAL_PAUSED or TRIAL_EXHAUSTED, purchased credits or a paid plan can fund more
work; buying credits requires the web app. Honor trial length, batch, attempt and
conversation limits. For SIGNUP_REQUIRED or HUMAN_VERIFICATION_REQUIRED, direct
the user to the web app's one-time Cloudflare verification. Never evade access or
usage limits with new accounts or tokens.

For 401, check expiry/revocation and whether the client inherited the environment
value without printing it. For scope errors, name the required scope. For network
errors, confirm the exact HTTPS API/MCP endpoint and client transport support.
Use plain HTTP only with a loopback development server the user controls. For an
authorized summary or comparison test, preserve custom instructions, a stable
idempotency key and the returned job/comparison ID. analyze_media is always
asynchronous; get_job reports progress, and get_summary returns successful output.
Legacy optional bounded waits do not cancel processing when their wait ends.

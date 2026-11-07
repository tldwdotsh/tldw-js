# tldw.sh agent plugin · 0.8.0

**Too long; didn't watch.** Connect with a scoped tldw.sh API key from any HTTP
client, script or agent.
For Claude Code, Codex, Cursor, Grok Build and compatible MCP clients, this plugin adds
two reusable skills and tool discovery over the SaaS's existing Streamable HTTP
MCP server. Processing, access checks,
progress, usage, credits and durable jobs stay on the SaaS. The primary workflow
accepts raw text, X posts/threads/articles, public web articles and YouTube/TikTok
links with custom instructions.

This folder is a standalone repository package. You can place it in your own
Git repository and distribute it through the included local marketplace files.
No GitHub repository, vendor listing or global plugin installation is created
by downloading or validating it.

The project has reserved the private distribution repository
[`tldwdotsh/tldw-agent-plugin`](https://github.com/tldwdotsh/tldw-agent-plugin).
The reviewed source of truth currently remains `packages/agent-plugin` in the
private [`tldwdotsh/tldw`](https://github.com/tldwdotsh/tldw) monorepo. This export
is derived from that source; maintain changes there and regenerate the export
rather than editing two independent copies. Repository creation does not mean
the reviewed source has been uploaded or a marketplace listing is available.

After the operator uploads the export, collaborators with repository access can
clone it with their existing GitHub authentication:

```sh
gh repo clone tldwdotsh/tldw-agent-plugin
```

Never embed a GitHub token in a clone URL or plugin file. GitHub access permits
downloading this private repository; the scoped tldw API key separately permits
using the SaaS. A private repository is not publicly installable or discoverable
in a connector store. An operator-provided ZIP is an alternative distribution.

For the hosted service, the app origin is `https://tldw.sh`, the API origin is
`https://api.tldw.sh`, and MCP is at `https://api.tldw.sh/mcp`. Publishing this
repository does not deploy or verify that hosted service.

## Prepare the plugin with the CLI

Open your operator's **Connect your agent** page (`/agents`) for the exact install
command and download origin. The downloadable `tldw-client-0.2.0.tgz` contains a
dependency-free Node client, CLI and this reviewed plugin. It is a real package
download; a public npm registry listing is not required.

```sh
# Use the exact HTTPS app/API origins shown in your account. Do not put keys in flags.
npx --yes 'https://YOUR_APP_ORIGIN/downloads/tldw-client-0.2.0.tgz' init \
  --api-url 'https://YOUR_API_ORIGIN' --web-url 'https://YOUR_APP_ORIGIN' \
  --dir ./tldw-agent-plugin
```

`init` verifies the embedded files and writes a **new directory** with the correct
MCP URLs. It refuses an existing destination or symlink parent, stores no key and
does not modify global settings or execute a native plugin install. Follow its
Claude Code/Codex commands or the client examples below. Configure the private
`TLDW_API_TOKEN` environment through your secret manager, then run the same package's
`doctor --api-url 'https://YOUR_API_ORIGIN'` command. Doctor checks REST/MCP with
read-only requests; it never submits inference, sends support messages or consumes
an analysis. `account:read` is optional for its usage check.

The CLI also offers `analyze --media URL` and `wait JOB_ID`; run `--help` for flags.
It prints an accepted job ID before waiting. A wait timeout or Ctrl-C stops the
client only; resume the durable job instead of submitting it again. For an
explicitly enabled loopback development API, `doctor`, `analyze` and `wait` accept
`--local` for anonymous checks. This option refuses non-loopback origins.

## Configure your account

1. Get the correct MCP endpoint from your operator's **API keys** page. Source
   templates use a reserved `.invalid` endpoint; operator-generated packages
   may already contain the configured endpoint.
2. Sign up in the web app. New Free accounts activate their 500-credit monthly allowance
   once in the browser, completing the configured account/bot verification.
   Agents reuse that activated account without a CAPTCHA on each request.
3. Create an API key in **API keys**. Start with `jobs:write`, `jobs:read`
   and `summaries:read` for summaries. Add `account:read` for usage,
   `chat:write`/`chat:read` for questions, and `uploads:write` for subtitles.
4. Make `TLDW_API_TOKEN` available to the client process through your secret
   manager or private shell environment. Keep the actual value out of prompts,
   tracked files, command arguments and public archives. This is a **tldw.sh
   API key**, not a model provider credential.

Claude Code and Grok Build can override their endpoint with the full URL in
`TLDW_MCP_URL`. Codex uses the literal endpoint in `codex.mcp.json`; replace
its reserved `.invalid` origin before installing an unconfigured source copy.
`TLDW_API_TOKEN` is read at runtime; it is never baked into this package.
Restart a client launched before you configured its environment.

Version 0.8.0 adds explicit transcription consent and credit ceilings, with
monthly Free/Hobby/Pro allowances. Version 0.7.0 introduced a dedicated Cursor manifest/configuration while retaining
plugin/marketplace name `tldw` and the `TLDW_*` environment variables.
Existing SaaS API keys remain valid, including the legacy `yta_`
format; do not regenerate a secret just to rename its environment variable.
An existing client configured under the old `yt2alpha` name can keep using its
endpoint and key. When switching to this package, remove the duplicate old
connection through that client's settings. The optional hosted Grok Python
example accepts `YT2ALPHA_API_TOKEN` and `YT2ALPHA_MCP_URL` only when their new
`TLDW_*` counterparts are absent; native manifests use the new names.

Only use plain HTTP with a loopback development server you control. Deploy the
SaaS endpoint over HTTPS for other clients. These packaged configurations keep
using API keys. The server also supports browser OAuth for compatible MCP clients:
add its full `/mcp` URL through the client's OAuth connection interface, sign in,
and approve the requested permissions. See the deployment's `/docs#authentication`
for its live authentication contract. Client and directory
support must be tested separately; installing this package is not store approval.

## Claude Code

Run these commands from the directory containing the extracted
`tldw-agent-plugin/` folder:

```sh
claude plugin validate ./tldw-agent-plugin
claude --plugin-dir ./tldw-agent-plugin
```

For persistent installation, add its local marketplace and install the entry:

```sh
claude plugin marketplace add ./tldw-agent-plugin
claude plugin install tldw@tldw
```

The `.claude-plugin/plugin.json` manifest, shared `skills/`, and `.mcp.json`
provide the native integration. `.mcp.json` uses Claude's environment expansion
for the endpoint and Authorization header. Check the server in `/mcp`.

Invoke `/tldw:setup-tldw` for setup or `/tldw:video-summary` for a
workflow, or ask Claude to analyze supported media. The client may ask you
to approve the server or tool actions; the plugin does not grant itself trust.

## Codex

```sh
codex plugin marketplace add ./tldw-agent-plugin
codex plugin add tldw@tldw
```

Use the current Codex plugin browser if your client does not expose `plugin add`.
The repository's `.agents/plugins/marketplace.json` lists this plugin. Its
`.codex-plugin/plugin.json` compatibility manifest explicitly loads
`codex.mcp.json`, whose `bearer_token_env_var` points at `TLDW_API_TOKEN`.
Its URL is a literal value: Codex does not need to interpolate a token into a
static header. The shared skills also load under this manifest.

The newer portable Agent Plugins remote HTTP format does not expand environment
variables in URLs or headers. This package intentionally uses Codex's supported
compatibility format rather than supplying a portable header that would send
literal `${TLDW_API_TOKEN}` text.

For clients without plugin support, merge
[`examples/codex/config.toml`](examples/codex/config.toml) into your chosen Codex
configuration after replacing the endpoint. Preserve unrelated settings and use
one connection method to avoid duplicate servers. This direct-MCP alternative
does not install the skill workflows; you can still ask Codex to discover and
use the server's tools.

## Cursor

This package includes `.cursor-plugin/plugin.json`, shared `skills/`, and a
dedicated `cursor.mcp.json`. The manifest explicitly selects that MCP file, so
Cursor does not load the Codex token format or Claude's endpoint expansion.
The operator's CLI `init` renders its literal MCP endpoint. Replace the reserved
`.invalid` origin before using an unconfigured source checkout.

For a Cursor plugin install, use your chosen marketplace or Cursor's local
plugin-import mechanism. Local testing uses a directory such as
`~/.cursor/plugins/local/tldw` containing this package; reload Cursor, then check
**Customize** for the plugin, skills and MCP server. Copying/importing there is an
explicit user step, not something this package does automatically. Enterprise
administrators may need to allow local plugin imports.

The Cursor manifest declares a required `TLDW_API_TOKEN` variable without a
default value. Configure its value privately through Cursor's supported plugin
configuration, such as **Plugins → Configure** in the dashboard. Cursor supplies
the `${TLDW_API_TOKEN}` header at runtime. Do not fill it into `cursor.mcp.json`,
commit it, send it in chat, or reuse a shared administrator key. Plugin-variable
configuration availability depends on the Cursor client/workspace; it does not
require weakening the SaaS's authentication.

For a direct MCP connection with a token already in your local environment,
merge [`examples/cursor/mcp.json`](examples/cursor/mcp.json) into your project's
`.cursor/mcp.json` or your chosen Cursor MCP configuration. Preserve unrelated
entries. That separate example uses Cursor's `${env:TLDW_API_TOKEN}` expansion;
the plugin file instead uses declared plugin variables. Restart a client that
did not inherit the environment. Direct MCP setup provides tools; it does not
install the shared skills. Choose one connection method to avoid duplicate tools.

Public Cursor Marketplace distribution requires a public open-source repository
and Cursor review. This prepared package is not a published listing. The offline
validator checks its manifest, variable declarations and endpoint rendering;
it does not certify Cursor UI installation or secret-storage behavior.

## Grok Build and other clients

Grok Build accepts Claude-compatible plugins. See the
[Grok Build and xAI examples](examples/grok/README.md) for native validation,
installation, configuration and the separate opt-in xAI Responses API example.
The API example has its own xAI billing and credential requirements; the native
plugin uses your existing client setup and tldw.sh token.

For another client with remote Streamable HTTP and custom header support, use
the operator's `/mcp` endpoint and an Authorization bearer header from the
client's secret store. Client configuration formats differ; `.mcp.json` is a
Claude-compatible format, not a universal configuration schema. A model name
alone does not establish that its host application supports MCP or plugins.

## Workflows and limits

- Call `analyze_media` with `media` (raw text, a supported public URL or an explicit
  source object) and optional `instructions` (up to 4,000 characters).
  `instructions` can request a summary, interesting details or a focused analysis.
  It always returns an accepted durable job receipt without embedded output;
  there is no `wait_seconds` argument. Preserve `job_id`, poll `get_job` for
  `job.status` and `job.progress`, then call `get_summary` with `summary_id` only
  after successful completion. Honor `next_poll_after_ms` and rate-limit guidance.
  Preserve the exact body and idempotency key after an unknown network outcome;
  a client disconnect does not cancel the accepted job.
- Resolve finding `source_ids` against the result's returned `sources` and read
  its `limitations`. Public X post retrieval depends on the deployment's current
  public/official retrieval mode; full thread/article and web-article extraction
  depend on source coverage and deployment capabilities. No single post is
  presented as a complete thread. If source content cannot be retrieved completely, paste
  the text; never present missing thread/article content as if it was read.
  `submit_video` remains available for explicit video styles.
- Compare 2–20 supplied TikTok links with `compare_tiktoks`, optionally focusing
  the comparison with `instructions`. Follow `get_comparison` (optionally with
  `wait_seconds: 8`) for coverage, cited findings and limitations. At least two
  distinct clips must provide usable evidence. `cancel_comparison` stops
  unfinished work when requested; already completed clips retain normal usage.
- Read owned transcripts in pages, export notes, or queue transcript-grounded
  questions. Asking a question requires both chat scopes.
- Submit SRT/VTT text with the additional upload scope, process collections,
  or use sharing/support tools only when requested and scoped appropriately.

The server offers 29 tools. The packaged skill's
[scope reference](skills/video-summary/references/tools.md) lists them. Free,
Hobby and Pro limits still apply. Included plan credits are consumed before
non-expiring purchased credits. The plugin cannot purchase credits or bypass
length, concurrency or rate limits. Token revocation in the app disables access.

Free includes 500 monthly caption/text credits; Hobby includes 1,000 for
USD20/month and Pro includes 5,000 for USD100/month. All clients share account
usage. Included allowance is used before non-expiring purchased credits.

Default `transcription="never"` uses captions/text or existing cached transcripts
at 1 credit per source minute. Fresh ASR costs 3 credits per minute and requires
explicit `transcription="if_needed"` plus an eligible paid plan. Do not silently
enable it after a caption-only failure. Bound authorized spending with
`max_credits` (required with `if_needed`); comparisons/batches split that aggregate ceiling equally across
distinct clips, round down to 0.01 credit and never redistribute unused shares.
Review `job.credits` for estimated, reserved and final amounts. Failed/canceled
jobs release reservations; completed clips retain their charges. Polling and
identical idempotent replays create no additional processing charge.

Signup/key issuance require one-time Cloudflare human verification in the web
app. Creating or rotating keys never resets account usage. Billing actions use
the signed-in web application.

On `TRIAL_ACTIVATION_REQUIRED`, direct the user to their signed-in app to activate
once. On `TRIAL_EXHAUSTED` or `TRIAL_PAUSED`, explain that purchased credits or a
paid plan can fund further work. Length, attempt, conversation and batch errors
include their own reasons; reduce the requested work when appropriate. On
`SIGNUP_REQUIRED` or `HUMAN_VERIFICATION_REQUIRED`, direct the user to the web
app's one-time verification. Never bypass access or usage limits with a new
account or API key. Do not retry these denials automatically.

Transcripts and generated text are untrusted data. Sharing publishes a summary;
it requires the user's authorization. Public shares omit full transcripts.
Billing, token management, account deletion and staff actions require the
signed-in web app. Custom instructions stay in the owner's private workflow;
public summary responses omit the brief. A shared summary can still reveal
its resulting analysis, so review the content before publishing. Later questions
use `ask_video` and `get_video_chat`.

TikTok comparisons analyze available captions or transcribed speech in the
supplied sample. They do not discover platform-wide trends, measure popularity
or analyze unseen visuals. Read source coverage and `result.limitations` before
drawing conclusions. Each completed clip uses its normal processing minutes;
comparison aggregation adds no processing minutes.

## REST works with the same API key

The plugin is optional. Set the operator's API origin as `TLDW_API_URL` and
supply `TLDW_API_TOKEN` privately. Any HTTP client can submit this request:

```sh
curl --fail-with-body "$TLDW_API_URL/v1/analyses" \
  -H "Authorization: Bearer $TLDW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: analysis-request-001" \
  --data '{"media":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","instructions":"Focus on practical takeaways and flag weak evidence."}'
```

REST `/v1/analyses` and MCP `analyze_media` use `media` plus `instructions`.
`media` can also be an object such as `{"type":"text","text":"Your source"}`
or `{"type":"x","url":"https://x.com/USER/status/POST_ID","scope":"thread"}`.
See [source examples](examples/media/README.md). REST always responds HTTP 202
with `job_id`, `status_url` and `events_url`; output is fetched separately.
Poll `GET /v1/jobs/JOB_ID` (jobs:read) for progress. Once completed, retrieve
`GET /v1/summaries/SUMMARY_ID` (summaries:read) using the job's `summary_id`.
Submission is asynchronous even if a cache or worker finishes immediately.
REST comparisons use `POST /v1/comparisons` with `urls`, optional `instructions`
and optional per-clip `options`; use its returned comparison ID to resume.
See the operator's public `/docs` and generated OpenAPI for full schemas.

For direct local development, the operator can enable its guarded no-login
profile. A native client on the same machine can connect to
`http://localhost:8000/mcp` without a header, or use the non-secret `dev-user`
marker if its client requires a token setting. Hosted agents cannot reach laptop
localhost. Keep the private development admin key out of plugin configuration.

## Validate and test

```sh
python3 scripts/validate.py
claude plugin validate ./.claude-plugin/plugin.json --strict
claude plugin validate ./.claude-plugin/marketplace.json --strict
grok plugin validate .
```

The Python validator works offline and performs no installation or provider
requests. Native validation checks package structure, not authentication or
inference quality. For a live read-only connection check, initialize the server,
discover tools and call `list_styles`. Do not submit videos just to test setup.

This package has no install scripts, lifecycle hooks, auto-updaters or default
tool approvals. Real login and processing still require the operator's deployed
services and your account configuration. Public vendor-directory publication
needs its own review; API-key authentication is not currently supported by
OpenAI's submission portal connection form. No published listing is claimed.

## Privacy and licensing

The remote SaaS operator controls processing and retention. Review its Privacy
Policy and Terms at the same web app where you create API keys. This plugin does
not alter those policies or promise a processing location or provider retention
policy. API key scope limits what a connected client can read and request.

The MIT [LICENSE](LICENSE) covers this plugin repository and its new examples.
It does not license the separately operated SaaS or waive subscription terms.

## Format references

- [Claude Code plugin format](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code MCP environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)
- [Codex plugin packaging and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex native plugin MCP parser](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs)
- [Agent Plugins specification](https://agent-plugin.org/en/specification)
- [Cursor plugin manifests and variables](https://cursor.com/docs/reference/plugins)
- [Cursor local plugin testing](https://cursor.com/docs/plugins#test-plugins-locally)
- [Cursor MCP environment variables](https://cursor.com/docs/mcp#variables)

# Grok Build and the Grok API

## Grok Build plugin

Grok Build is the terminal coding agent. It can load this repo's Claude-compatible
plugin, shared workflow skills and remote MCP configuration. This does not install
a plugin into the Grok web chat. See the official
[plugin compatibility guide](https://docs.x.ai/build/features/skills-plugins-marketplaces).

The plugin's MCP endpoint is a fixed literal in `.mcp.json`, never an
environment override, so no other process setting can redirect your token to a
different host. Use a directory prepared by the operator's verified CLI `init`
command, which writes your API origin into every configuration. For an
unconfigured source copy, replace its reserved `.invalid` origin before
installing. Supply `TLDW_API_TOKEN` from your secret manager or private shell
environment. A local Grok Build process can use a loopback endpoint such as `http://localhost:8000/mcp`.
API keys come from **API keys** in the web app; use the minimum scopes needed.
For custom summaries and transcripts, use `jobs:write`, `jobs:read` and `summaries:read`. Add
`account:read` for allowance checks and
`chat:write`/`chat:read` for queued video questions. Never use a provider API key
or Clerk session as the SaaS token.

Existing API keys remain valid after the tldw.sh rebrand. This package uses
`TLDW_API_TOKEN` and the MCP label `tldw`. Native plugin configuration no longer
reads `TLDW_MCP_URL`; remove it from launch environments that only served the
plugin. For an existing native configuration, avoid duplicate server entries.
The optional Python example below still reads a validated `TLDW_MCP_URL` and also
accepts legacy `YT2ALPHA_API_TOKEN` / `YT2ALPHA_MCP_URL` when the new variables
are absent.

From the parent of the extracted repository:

```sh
grok plugin validate ./tldw-agent-plugin
grok plugin install ./tldw-agent-plugin
```

Review Grok's trust prompt and enable the plugin in `/plugins`. Start a new
session after changing environment values. Use `grok inspect` to confirm
discovery and `grok mcp doctor tldw` to check connectivity. Plugin validation
does not prove credentials or SaaS processing work.

For MCP only, merge [`grok-config.example.toml`](grok-config.example.toml) into
your own Grok config after replacing its reserved `.invalid` origin with your
operator's HTTPS API origin. Do not overwrite unrelated settings. Alternatively,
with the same literal endpoint substituted:

```sh
grok mcp add --transport http tldw \
  'https://api.tldw.invalid/mcp' \
  --header 'Authorization: Bearer ${TLDW_API_TOKEN}'
```

The single quotes preserve the token placeholder; Grok expands it at load time.
Keep the endpoint literal; do not make it an environment expansion.
Use one connection method to avoid duplicate tools. Remove the MCP-only connection
with `grok mcp remove tldw`. See the official
[MCP settings](https://docs.x.ai/build/features/mcp-servers).

## Native processing workflows

The native plugin discovers the hosted MCP tools. `analyze_media` accepts raw text,
X posts/threads/articles, public articles or YouTube/TikTok URLs as `media`, plus
custom `instructions`. It always returns a durable job receipt without output.
Poll `get_job` for status/progress; after completion call `get_summary` with its
`summary_id`. It has no `wait_seconds` argument. Never resubmit to poll progress. Use
`extract_transcript` for original captions or text without a summary. Analyses
use captions/transcribed speech, without claiming platform-wide trends or unseen
visual analysis.

General analysis results include source-ID citations and limitations. An X URL
requires the operator's X read/search access; paste full source text when a link
cannot be fetched completely. See the [media examples](../media/README.md).

The same SaaS API key also works with REST from any client; the plugin is optional.
Custom briefs are private to the owner and omitted from public responses,
but generated result content can still reflect them. Review content before sharing.

## Optional hosted Grok API example

[`grok_mcp.py`](grok_mcp.py) uses only Python 3.10+ standard-library modules.
Provide these through your private environment:

| Variable               | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `XAI_API_KEY`          | Your xAI API key; separate from the SaaS token.                               |
| `GROK_MODEL`           | An available model in your xAI account that supports remote MCP.              |
| `TLDW_API_TOKEN`       | A dedicated SaaS token with `account:read`, `jobs:read` and `summaries:read`. |
| `TLDW_MCP_URL`         | Public HTTPS endpoint ending in `/mcp`.                                       |
| `GROK_TIMEOUT_SECONDS` | Optional socket timeout, 5–120 seconds; default 60.                           |

The hosted API connects from xAI's infrastructure, so it cannot reach your laptop's
localhost. An explicit `--run` sends the SaaS token and requested content to xAI,
and can incur xAI charges. Review the service endpoint and provider data controls
before running. A socket timeout is not a provider-spend limit; the remote request
can continue after the local client times out. This example never retries.

```sh
# Validate settings without sending requests or printing credential values:
python3 examples/grok/grok_mcp.py

# Request an account-grounded answer through xAI and the live SaaS:
python3 examples/grok/grok_mcp.py --run

# Optionally use your own UTF-8 question, without putting secrets in it:
python3 examples/grok/grok_mcp.py --run --prompt-file ./question.txt
```

Only read tools are exposed: `account_usage`, `list_jobs`, `get_job`, `wait_job`,
`get_summary`, `get_transcript`, `list_transcripts` and `get_saved_transcript`.
Processing, cancellation and other write tools are unavailable in this API example; use the native plugin for those
user-authorized workflows. xAI currently does not support MCP `require_approval`,
so the allowlist is enforced in the request instead. The example disables stored
response continuation, refuses redirects, caps response size and prints only the
answer or sanitized error codes. A model response that never called MCP is
reported as incomplete integration evidence rather than presented as account fact.
Model quality, endpoint access and real billing remain live acceptance checks.

References: [xAI remote MCP fields](https://docs.x.ai/developers/tools/remote-mcp),
[Responses format and storage](https://docs.x.ai/developers/model-capabilities/text/comparison).

Run the offline example regressions without vendor requests:

```sh
python3 -m unittest discover -s examples/grok/tests -p 'test_*.py'
```

# Grok Build and the Grok API

## Grok Build: browser sign-in

```sh
grok mcp add --transport http tldw https://api.tldw.sh/mcp
```

Open `/mcps`, select tldw, and authenticate through your browser. Grok discovers
OAuth and stores its credentials outside the project configuration. This is
Grok Build, separate from Grok web chat or the hosted xAI API. The equivalent
native table is in [grok-config.example.toml](grok-config.example.toml).
Merge it into `.grok/config.toml` or your chosen Grok configuration without
replacing other servers. There is no `oauth` key to add.

The optional local plugin supplies shared skills:

```sh
grok plugin validate ./tldw-agent-plugin
grok plugin install ./tldw-agent-plugin
```

Review the client's trust prompts and use one connection method to avoid
adding duplicate tldw tools. Start a new session after changing its configuration.
`grok mcp doctor tldw` diagnoses connectivity; structure validation does not prove
browser authentication or media processing.

For an API-key alternative, use
[grok-api-key.example.toml](grok-api-key.example.toml). Its literal endpoint
cannot be redirected by an environment variable. Set `TLDW_API_TOKEN` privately
in the process environment. Never put its value in a prompt, a committed file,
or a command argument. Agent workflows recommend `account:read`, `jobs:write`, `jobs:read` and
`summaries:read`, including the first `account_usage` check.

First call `account_usage` to check access. Only a user request authorizes a new
analysis; save its job ID, resume that ID after a disconnect, and retrieve the
summary and original transcript after completion. The server chooses whether
eligible audio fallback is needed. Follow the canonical tldw skill for source,
spending, error and untrusted-content rules.

Official references: [MCP servers](https://docs.x.ai/build/features/mcp-servers),
[skills and plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces).

## Optional hosted xAI API example

[grok_mcp.py](grok_mcp.py) is a Python 3.10+ example for the hosted Responses API.
It uses an API key, not Grok Build's browser OAuth session. These are separate
credentials and billing:

| Variable | Purpose |
| --- | --- |
| `XAI_API_KEY` | Your xAI API credential |
| `GROK_MODEL` | An available model supporting remote MCP |
| `TLDW_API_TOKEN` | A private tldw key with read scopes |
| `TLDW_MCP_URL` | The public HTTPS MCP endpoint |
| `GROK_TIMEOUT_SECONDS` | Socket timeout from 5–120 seconds; default 60 |

Without `--run`, the example validates configuration without sending requests
or printing credential values:

```sh
python3 examples/grok/grok_mcp.py
```

An explicit `--run` sends the tldw credential and requested content to xAI and
can incur xAI charges. Review the endpoint and data controls before choosing it.
A socket timeout does not cancel hosted work or bound its spend. It never
retries automatically, and it exposes only read tools; processing and other
state-changing tools are unavailable. A response that did not invoke MCP is
not treated as verified account information.

Run its offline tests without vendor requests:

```sh
python3 -m unittest discover -s examples/grok/tests -p 'test_*.py'
```

References: [xAI remote MCP fields](https://docs.x.ai/developers/tools/remote-mcp),
[Responses storage](https://docs.x.ai/developers/model-capabilities/text/comparison).

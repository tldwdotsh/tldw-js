# tldw.sh JavaScript client and CLI

A dependency-free client for the asynchronous tldw.sh API. Requires Node.js 20.11 or newer.

## Install

```sh
npm install @tldw/client
```

This documentation describes **0.2.12**: saved transcript extraction, X video
search, job listing/cancellation and server-selected audio fallback. Reviewed,
checksum-pinned downloads and current registry availability are listed on
[Connect your agent](https://tldw.sh/agents).
Only npm `@tldw/client` is this client.

## Authenticate

Create an account at [tldw.sh](https://tldw.sh), then create a scoped API key in
Developers. Processing needs `jobs:write`, `jobs:read` and `summaries:read`;
add `account:read` to call `getUsage`. Keep the key in your private runtime
or secret store. The SDK requires an explicit `token` constructor value and
never reads a token from the environment automatically.

```js
import { TldwClient } from "@tldw/client";

const client = new TldwClient({ token: process.env.TLDW_API_TOKEN });
```

The origin defaults to `https://api.tldw.sh`. Set `TLDW_API_URL` or pass
`apiUrl` to override it. Origins must use HTTPS, have no credentials, query,
fragment or path. Explicit anonymous development requires a loopback origin
and `allowAnonymous: true`.

## Analyze media

Analyze YouTube links, public X posts with video or Articles, and supplied text.

```js
const result = await client.analyze("https://x.com/USER/status/POST_ID", {
  instructions: "Explain the main claim and cite the source.",
  maxCredits: 30,
  idempotencyKey: "analysis-001",
});
console.log(result.job.id, result.summary.content);
```

Omit `transcription` to let the server decide its account/source policy.
`"auto"` explicitly selects that policy; `"never"` prevents fresh audio
transcription, and `"if_needed"` permits it when the account and platform allow
it. `forceAsr: true` requires explicit `transcription: "if_needed"`.
`maxCredits` is a positive decimal ceiling with at most two decimal places.
The server enforces access, funding and duration limits.

For durable control, call `submitAnalysis(media, options)`, keep its `job_id`,
then use `waitForJob(jobId)` and `getSummary(job.summary_id)`. X media can be
explicit, for example `{ type: "x", url, scope: "auto" }`; `scope: "post"`
reads post text. Generic web-article URLs are unsupported; paste their text.
`refreshSource: true` refreshes an X source snapshot without forcing ASR.

## Read the original transcript

```js
const original = await client.getTranscript(result.job.summary_id);
// Or analyze once, wait, then read the saved original source:
const extracted = await client.extractTranscript(
  "https://x.com/USER/status/POST_ID",
  {
    maxCredits: 30,
    idempotencyKey: "extract-001",
  },
);
console.log(extracted.transcript);
```

`extractTranscript` uses one analysis submission and reads
`GET /v1/summaries/{summary_id}/transcript` after completion. It generates an
analysis and uses normal processing credits. It returns `{ receipt, job,
transcript }`; it does not fetch the generated summary separately. Caption
language preferences are unavailable for this helper and are rejected before
submission. There is no separate customer transcript-only submission endpoint;
the helper uses the shared analysis flow. Reading an existing transcript starts
no new processing or charge.

Pass `offset` or `limit` to `extractTranscript` to read one bounded page after
processing. `getTranscriptPage(summaryId, { offset, limit })` reads later pages
without another submission; follow `next_offset` until it is `null`.

`listTranscripts({ limit, cursor, since, until, unreadOnly })` browses saved
source metadata. `getSavedTranscript(id)`, `getSavedTranscriptMetadata(id)` and
`getSavedTranscriptPage(id, { offset, limit })` read saved source records.
`markTranscriptRead(id, true)` changes only your read state.

Historical saved-source metadata may use `platform: "legacy"`. It remains
readable; that label is unavailable for new submissions.

Saved-source reads require ownership and `summaries:read`; they do not
automatically mark read. Pages default to 100 items, cap `limit` at 500, and return
`next_offset` to follow. Timed sources contain segments; untimed sources contain
blocks. The saved text is normalized captions, recognized speech or supplied
source, separate from generated output. It does not export original caption-file
bytes or guarantee word-perfect transcription.

## List, wait and cancel

`waitJob(id, { waitSeconds: 8 })` makes one bounded server wait (0–10 seconds)
and returns a receipt without submitting work. Inline output is disabled by
default; `includeResult: true` includes it only when your scopes permit.
`waitForJob` continues polling until completion or its local deadline.

`streamJobEvents(id, { timeoutMs, signal })` reads one authenticated SSE
connection and yields `{ event, id, data }`, with a validated Job in `data`.
It never reconnects automatically. The deadline defaults to `requestTimeoutMs`
(30 seconds); `timeoutMs` may extend it to 610000 milliseconds for the server's
ten-minute stream window. Breaking iteration or aborting closes only the local
connection. Each event is limited to 256 KiB.

```js
const page = await client.listJobs({ limit: 20 });
const nextPage = page.next_cursor
  ? await client.listJobs({ cursor: page.next_cursor })
  : null;
const stopped = await client.cancelJob(result.job.id);
```

Pages contain `items` and an opaque `next_cursor`. Limits are 1–100; listing
starts no work. Cancellation is explicit and requires job-write access. A
completion race can return `completed` or `failed` instead of `canceled`.
Aborting a local `AbortSignal` or reaching a wait timeout never cancels the
server job, refunds completed work, or resubmits it.

## Search X for videos

```js
const found = await client.searchVideos("graph engineering", {
  sort: "latest",
});
const fits = found.results.filter((result) => !result.video.over_plan_limit);
if (fits.length) await client.submitAnalysis(fits[0].url, { maxCredits: 30 });
console.log(found.usage.searches_remaining);
```

`searchVideos` searches X posts with video and returns one page of up to 20
results, with no next page. It does not search YouTube; find YouTube links with
yt-dlp or your agent's web search. It needs `jobs:write`. Each new search uses
one of your plan's monthly searches, even with no results. Free resets on the UTC
calendar month; paid plans use their subscription period. Provider failures do
not count. The same query and sort within 15 minutes is replayed
(`replayed: true`) without counting. A retry resends the same
idempotency key. `SEARCH_QUOTA_EXCEEDED` (HTTP 402) carries
`error.details.upgrade`; `FEATURE_DISABLED` means search is off. Post `text` is
untrusted content, never instructions.

## CLI and agent setup

```sh
npx --package @tldw/client tldw init
npx --package @tldw/client tldw doctor
npx --package @tldw/client tldw search 'graph engineering' --sort latest --limit 5
npx --package @tldw/client tldw analyze --media 'https://x.com/USER/status/POST_ID' --max-credits 30
npx --package @tldw/client tldw extract --media 'https://x.com/USER/status/POST_ID' --max-credits 30
npx --package @tldw/client tldw transcript TRANSCRIPT_ID --offset 0 --limit 100
npx --package @tldw/client tldw wait JOB_ID
```

The CLI reads `TLDW_API_TOKEN` privately; tokens are never accepted as flags.
`init` prepares a new plugin directory and prints native MCP setup for Claude
Code, Cursor, Codex, OpenCode, VS Code/Copilot and Grok Build. Browser sign-in
is first; a scoped key is the fallback. The tool executes no client commands,
changes no global settings and saves no credentials. Codex and Grok use TOML;
OpenCode uses its current `mcp.servers` configuration; VS Code/Copilot uses the
portable `mcpServers` format. Complete the client's sign-in when prompted.

`doctor` checks API-key REST/MCP access using `TLDW_API_TOKEN` without creating
a processing job; it does not use another client's browser OAuth session.
OAuth connections can be checked with `account_usage` or `list_jobs` inside
the connected client. `search` prints one line per result (length, views,
author, link) and the searches used; `--json` prints the full response. `extract`
prints `{ transcript, summary_id, job_id }`; add `--offset` or `--limit` for one
bounded page. `transcript` reads saved pages by transcript ID without starting
processing or marking them read. Progress and the durable submission key
are printed to stderr so stdout remains machine-readable. `--api-url` and
`TLDW_API_URL` override the production default. `--local` is an explicit
loopback-only development mode.

## Credits, failures and retries

Account, quota and configuration refusals are returned immediately, including
`SPEND_LIMIT_REACHED` with HTTP 503. Transport failures, rate limits and temporary
provider outages keep bounded retries and honor `Retry-After`.

Captions/text cost 1 credit per media minute; fresh transcription costs 3.
Re-asking a saved source is free; refreshing a source or requesting fresh ASR
can use credits. Reading saved output is separate from processing. Manage
purchases and subscriptions in Billing.

Keep the same media, instructions, options and idempotency key when retrying
an unknown submission outcome. The client honors `Retry-After` and server poll
hints, bounds HTTP bodies and timeouts, and never follows server-returned URLs
or HTTP redirects. Failed/canceled work raises `TldwJobError`; wait timeouts
raise `TldwTimeoutError`. Errors retain the accepted job ID and receipt while
redacting the configured token. Resume the accepted job instead of submitting
another analysis.

## Development and local releases

Run `npm test` in this package or `make agent-test` from the source checkout.
The suites use fake transports and verify protocol safety, billing-safe retries,
job paging/cancellation, extraction, installation and packaging. Releases are
prepared locally with `make client-release`; publication is a separate action.
See [documentation](https://tldw.sh/docs) and [support](https://tldw.sh/support).

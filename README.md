# tldw.sh client and agent tools

Dependency-free Node.js 20.11+ ESM client for the same durable REST jobs used by MCP and
the sample web app. This package does not contain a media processor or provider
credentials.

```sh
npm install @tldw/client
```

You can instead install the versioned tarball from your operator's `/agents`
page. Download it, verify it against the SHA-256 checksum shown on that page,
then install the verified local file:

```sh
curl -fsSLo tldw-client-0.2.5.tgz 'https://YOUR_APP_ORIGIN/downloads/tldw-client-0.2.5.tgz' &&
  echo 'SHA256_FROM_YOUR_AGENTS_PAGE  tldw-client-0.2.5.tgz' | shasum -a 256 -c - &&
  npm install ./tldw-client-0.2.5.tgz
```

Only `@tldw/client` on npm and your operator's verified download are this
client; similarly named packages are not. TypeScript types are included;
CommonJS consumers can use dynamic `import("@tldw/client")`.

Supply your deployment's API origin and a scoped **tldw API key** through your
secret manager. Never put a real key in a prompt, source file, command argument,
or checked-in client configuration. REST/MCP/plugin clients share your account's
100 monthly Free caption/text credits, Hobby/Pro limits, and purchased credits. Signup and
one-time human verification happen in the browser; processing calls stay headless.

```js
import { TldwClient, TldwTimeoutError } from "@tldw/client";

const client = new TldwClient({
  apiUrl: process.env.TLDW_API_URL,
  token: process.env.TLDW_API_TOKEN,
});

// Persist a stable key before submitting; reuse it with the exact same input
// if the submission's network outcome is unknown.
const receipt = await client.submitAnalysis("https://youtu.be/VIDEO_ID", {
  instructions: "Extract the argument and flag weak evidence.",
  idempotencyKey: "my-persisted-request-001",
});
console.log({ jobId: receipt.job_id }); // Persist before waiting.
try {
  const job = await client.waitForJob(receipt.job_id, { timeoutMs: 180_000 });
  const result = await client.getSummary(job.summary_id);
  console.log(result.content);
} catch (error) {
  if (error instanceof TldwTimeoutError) {
    console.log({
      jobId: error.jobId,
      status: "still-running-or-not-yet-observed",
    });
    // Resume later with waitForJob(error.jobId); don't submit again.
  } else throw error;
}
```

The `analyze(media, options)` convenience helper combines those calls and returns
`{ receipt, job, summary }`. A failure after acceptance carries `error.jobId` and
`error.receipt`. A submission failure carries `error.idempotencyKey`, including
when the SDK generated the key. Preserve it before retrying an unknown outcome.

Methods:

- `submitAnalysis(media, { instructions?, transcription?, maxCredits?, forceAsr?, refreshSource?, idempotencyKey?, signal? })`
- `getJob(jobId, { signal? })` / `getSummary(summaryId, { signal? })`
- `waitForJob(jobId, { timeoutMs?, pollIntervalMs?, signal?, onProgress? })`
- `analyze(media, { ...submissionOptions, ...waitOptions })`
- `getUsage({ signal? })` requires `account:read`.
- `compareTikToks(urls, { instructions?, idempotencyKey?, signal? })` returns the
  accepted comparison view, including its durable ID.
- `getComparison(id)` / `waitForComparison(id, waitOptions)` return the unwrapped
  comparison view. A successful wait requires result access (`summaries:read`).

Pass an `AbortSignal` to stop the client wait; it never cancels accepted work on
the server. Waits default to 180 seconds and allow a finite maximum of one hour.
Each HTTP operation has a separate 30-second budget (`requestTimeoutMs`, up to
120 seconds). The client honors polling hints and Retry-After; transient
429/502/503/504 and network failures have bounded retries. POST retries preserve
the same serialized body and idempotency key. Authorization, scope and trial
denials are returned to the caller without automatic resubmission.

`TldwError` exposes `code`, `status`, `requestId`, `retryAfterMs` and durable IDs
when known. `TldwJobError` marks failed/canceled work. Server-returned status and
result URLs are never followed; the client uses validated UUIDs under the fixed
API origin. Redirects are rejected and response bodies are size-limited.

For explicitly enabled local development only, use
`{ apiUrl: "http://localhost:8000", allowAnonymous: true }`. It cannot grant admin
access. Hosted deployments require HTTPS and a scoped key.

The bundled `tldw` command provides installation and connection checks; run
`tldw --help` for its exact options. See the public `/agents` page for matching
Claude Code, Codex and generic MCP instructions. Provider credentials and payment
configuration remain operator-only and are not part of this package.

From a source checkout, run protocol and installer checks with `npm test`. Reference workflows are
distributed separately from the same deployment.

## Standalone development and release preparation

This private repository is an exported snapshot of
[`tldwdotsh/tldw`](https://github.com/tldwdotsh/tldw), directory
`packages/agent-client-js`. The monorepo remains canonical until the owner adopts
and documents an independent release/synchronization workflow. Private GitHub
clones require organization access; HTTPS uses your GitHub credential manager,
and SSH uses a key already authorized for this organization. Do not put a token
in a clone URL or committed configuration.

From this repository's root:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

No runtime dependencies, monorepo checkout, model provider, Docker service or
registry account is needed. Tests run local fixture servers and exercise the
real tarball installer offline. `npm run build` writes a tarball and SHA-256
manifest under `dist/`; it does not publish. The tarball embeds the reviewed
0.8.5 agent plugin, so the `tldw init` command works independently of this repo's
parent directory. The validation workflow covers Node 20.11, 22 and 24, plus Python 3.12 checks
for the bundled plugin and Grok example. It has read-only repository permissions
and no publication credentials.

Releases of `@tldw/client` are published from the monorepo's `main` branch through
npm trusted publishing after the exact packed files are reviewed. This repository
contains no npm publisher, trusted-publisher configuration, deployment job or SaaS
credentials.

`EXPORT_MANIFEST.json` records the canonical source snapshot and exported file
hashes. Sync by reviewing changes in the monorepo, refreshing this export and its
embedded plugin together, then repeating these checks. Do not silently diverge
or overwrite an independently edited export.

## Releasing (maintainers)

The monorepo's `scripts/prepare_client_release.py` stages reviewed source, uses
the real `npm pack` command and builds Python wheel/source archives. It does not
publish. The package declares public npm access and an explicit file allowlist;
no provider keys, account tokens, global configuration or SaaS server code belongs
in the release. Review the generated manifest and run the clean-install checks.

The release script adds the real GitHub repository URL to the staged package
metadata for provenance. Releases are published from `main` by the monorepo's
manual release workflow through npm trusted publishing (Node 24 and npm 11.5.1+);
consumers need Node 20.11+.

## Extract original source without generated analysis

```js
const receipt = await client.submitTranscript("https://youtu.be/VIDEO_ID", {
  transcription: "never",
  maxCredits: "30.00",
  idempotencyKey: "original-source-001",
});
console.log(receipt.job_id); // Persist before waiting.
const job = await client.waitForJob(receipt.job_id);
const original = await client.getSavedTranscriptPage(job.transcript_id, {
  limit: 100,
});
// Follow original.next_offset for more source content.
```

`submitTranscript` posts to `POST /v1/transcripts` and always returns a durable
accepted receipt. It never requests a summary or invokes an LLM. A completed
transcript job has `output_mode: "transcript"`, `transcript_id`, and no
`summary_id`. `extractTranscript(media, options)` combines submission, polling
and a full source read, returning `{ receipt, job, transcript }`; timeout and
source-permission errors retain the accepted receipt and job ID.

For a parsed subtitle upload, use `submitTranscript(null, { uploadId })`.
`preferredCaptionLanguages` selects original captions. Extraction accepts
spending/ASR controls and `refreshSource`, but no analysis instructions.
Submission requires `jobs:write`, polling `jobs:read`, and source reads
`summaries:read`; no account-read scope is needed.

The CLI equivalent is `tldw extract --media URL_OR_TEXT` (or `--file PATH`).
`tldw wait JOB_ID` resumes either an extraction or analysis job and prints its
matching result. No transcript-only path requests generated analysis, but a new
processing job still uses normal credits and ASR consent/caps. If you already
have a transcript ID, use `getSavedTranscriptPage` directly for a read that
starts no job and charges no processing credits.

## Summary and transcript are separate reads

After the job completes, use its `summary_id` to retrieve generated output and
original source independently. Both calls require `summaries:read` and account
ownership. Neither starts another analysis, transcription or processing-credit
charge. The summary response includes transcript metadata, not the full source.

```js
const summary = await client.getSummary(job.summary_id);
const transcript = await client.getTranscript(job.summary_id);
console.log(summary.content.answer);
const originalText = transcript.timed
  ? transcript.segments.map((segment) => segment.text).join("\n")
  : transcript.text;
console.log(originalText);
```

REST uses `GET /v1/summaries/{id}` and `GET /v1/summaries/{id}/transcript`.
MCP uses `get_summary` and paginated `get_transcript`. Timed YouTube/TikTok
sources expose `segments`; text/X sources expose `blocks` and `text`. X video
caption blocks retain `start_s` / `end_s` alongside separate untimed post context.
The saved source stays in its original language when requesting a translated summary.

## Saved transcription inbox

`listTranscripts` returns the latest 50 distinct sources requested by your account,
including sources saved before an analysis failed. It reads metadata only and does
not mark anything read. All library, source and read-state calls require `summaries:read`.

```js
const page = await client.listTranscripts({ limit: 50, unreadOnly: true });
for (const item of page.items) {
  console.log(item.id, item.video.title, item.last_requested_at);
  const source = await client.getSavedTranscriptPage(item.id, {
    offset: 0,
    limit: 100,
  });
  // Follow source.next_offset for additional content. Mark only when ready.
  await client.markTranscriptRead(item.id, true);
}
```

Pass `cursor: page.next_cursor` with the same filters for older entries. `since`
is inclusive and `until` exclusive, using ISO 8601 timestamps against
`last_requested_at`. `markTranscriptRead(id, false)` marks a source unread again.
Reading source content through REST/MCP/SDK never implicitly changes its read state.

X posts, X video captions and articles reuse an owned source snapshot for 24 hours.
Use `submitAnalysis(media, { refreshSource: true })` to retrieve current source content.
YouTube/TikTok keep reusing saved transcripts; another brief does not redownload
audio or repeat transcription when a usable source already exists.

## X video captions and output language

Pass an X post URL directly. Default `scope=auto` detects one attached video and
analyzes its available captions plus separately labeled post context when the
deployment enables X video extraction. You do not need a subtitle URL or a
separate provider key. Use `{"type":"x","url":"YOUR_X_POST_URL","scope":"post"}`
only for post text alone; thread scope does not recursively analyze its videos.

```js
const receipt = await client.submitAnalysis(
  "https://x.com/hamptonism/status/2071631335836225751",
  {
    instructions:
      "Summarize the spoken content in Spanish. Keep it concise and avoid repetition.",
    transcription: "never",
    idempotencyKey: "x-video-spanish-001",
  },
);
console.log({ jobId: receipt.job_id }); // Persist before waiting.
const job = await client.waitForJob(receipt.job_id, {
  onProgress: ({ status, progress }) => console.error({ status, progress }),
});
const result = await client.getSummary(job.summary_id);
console.log(result.content.answer);
```

The response is a durable job receipt. Save its ID before waiting; a timeout does
not cancel the job. Use a fresh stable key for a different brief or language and
reuse the exact body/key after an uncertain submission. Without instructions,
the service produces a concise summary. A translated summary is generated text
inside the same schema-3 result, not dubbed audio, a translated video or an SRT
translation; the original captions remain saved separately.

Captioned X videos use actual video duration at 1 credit/minute under normal
rounding (128.197 seconds = 2.2 credits), not the post's reading time. Missing
captions fail explicitly with no customer processing charge; X audio
transcription and visual analysis are not enabled, even with `if_needed`.

## Credit controls

Captions, text and existing cached transcripts cost **1 credit per source minute**.
Fresh audio transcription costs **3 credits per source minute** and requires an
eligible paid plan or server-confirmed billing exemption, plus explicit `transcription: "if_needed"` (Python:
`transcription="if_needed"`). The default `never` fails with a clear error when
new transcription would be necessary. Supplying `forceAsr: true` /
`force_asr=True` also requires that explicit permission.

Use `maxCredits: "30.00"` in JavaScript or `max_credits="30.00"` in Python to cap
a job. The server validates affordability before new transcription. The cap is
positive, at most 1,000,000 credits, and has at most two decimal places. It is
required for ordinary paid accounts when `transcription` is `if_needed`. Preserve
these controls in the same idempotent request body on retries. Jobs expose
`credits.estimated`, `reserved`, `final`, the billing class/rate and real source
duration; polling does not create another processing charge.

For `compareTikToks` / `compare_tiktoks`, the cap covers all distinct supplied
clips: each receives an equal share rounded down to 0.01 credit. Unused shares
are not redistributed. Comparison aggregation adds no customer processing credits.
Source minutes round up to 0.1 minute with a 0.5-minute minimum before the rate
multiplier. Raw text uses estimated reading minutes.

Free includes 100 credits per month for captions/text, Hobby costs USD20/month
with 1,000 credits, and Pro costs USD99/month with 5,000 credits. Included
allowance is used first, then purchased credits, which do not expire. Reading
account usage does not buy credits or change plans.

Server-confirmed billing exemption: the authenticated server decides whether an account is exempt. Exempt accounts may omit a credit ceiling and do not incur customer-credit charges; explicit transcription permission and resource/provider limits still apply. Ordinary paid accounts allowing fresh transcription must supply a ceiling or receive `TRANSCRIPTION_NOT_ALLOWED` (HTTP 422); `MAX_CREDITS_EXCEEDED` (HTTP 422) means a supplied ceiling is invalid or below the required charge. Clients validate supplied values, then pass requests through without fetching extra account scopes or inferring privileges from names, roles, or key prefixes.

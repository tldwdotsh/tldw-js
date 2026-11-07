# tldw.sh client and agent tools

Dependency-free Node.js 20.11+ ESM client for the same durable REST jobs used by MCP and
the sample web app. This package does not contain a media processor or provider
credentials. Install the versioned package from your deployment's `/agents` page;
the package is not assumed to be published on npm.

```sh
npm install /path/to/tldw-client-0.2.1.tgz
```

The intended registry name is `@tldw/client`. After the owner publishes the first
release, `npm install @tldw/client` and `npx @tldw/client --help` use the same API.
Until then, install the reviewed tarball from your operator. TypeScript types are
included; CommonJS consumers can use dynamic `import("@tldw/client")`.

Supply your deployment's API origin and a scoped **tldw API key** through your
secret manager. Never put a real key in a prompt, source file, command argument,
or checked-in client configuration. REST/MCP/plugin clients share your account's
500 monthly Free caption/text credits, Hobby/Pro limits, and purchased credits. Signup and
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

- `submitAnalysis(media, { instructions?, idempotencyKey?, signal? })`
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
0.8.1 agent plugin, so the `tldw init` command works independently of this repo's
parent directory. The validation workflow covers Node 20.11, 22 and 24, plus Python 3.12 checks
for the bundled plugin and Grok example. It has read-only repository permissions
and no publication credentials.

The intended name `@tldw/client` does not establish ownership of the npm scope.
The GitHub organization and npm scope are separate. Before a manual npm release,
confirm registry ownership/access, review the exact packed files, and choose an
explicit release policy. This repository contains no automatic npm publisher,
trusted-publisher configuration, deployment job or SaaS credentials.

`EXPORT_MANIFEST.json` records the canonical source snapshot and exported file
hashes. Sync by reviewing changes in the monorepo, refreshing this export and its
embedded plugin together, then repeating these checks. Do not silently diverge
or overwrite an independently edited export.

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

Free includes 500 credits per month for captions/text, Hobby costs USD20/month
with 1,000 credits, and Pro costs USD99/month with 5,000 credits. Included
allowance is used first, then purchased credits, which do not expire. Reading
account usage does not buy credits or change plans.


Server-confirmed billing exemption: the authenticated server decides whether an account is exempt. Exempt accounts may omit a credit ceiling and do not incur customer-credit charges; explicit transcription permission and resource/provider limits still apply. Ordinary paid accounts allowing fresh transcription must supply a ceiling or receive `MAX_CREDITS_EXCEEDED` (HTTP 422). Clients validate supplied values, then pass requests through without fetching extra account scopes or inferring privileges from names, roles, or key prefixes.

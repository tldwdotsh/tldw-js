# Tool access

The SaaS checks scopes and ownership on every tool call. Names
omit client-specific prefixes. The `tldw://guide` resource accepts any active
personal API key; it is not an additional tool. Production MCP exposes exactly
these 12 tools:

| Tools                                                        | Required scope |
| ------------------------------------------------------------ | -------------- |
| account_usage                                                | account:read   |
| analyze_media, extract_transcript, cancel_job                | jobs:write     |
| get_job, wait_job, list_jobs                                 | jobs:read      |
| get_summary, get_transcript                                  | summaries:read |
| list_transcripts, get_saved_transcript, mark_transcript_read | summaries:read |

Embedded summary results require summaries:read in addition to the
submission or status scope. Write-only access can submit work without exposing
its content. Instructions are limited to 4,000 characters and stay in the owner's
private workflow.

New Free users verify once in the browser. Free includes 100 monthly caption/text credits; Hobby includes 1,000 for
USD20/month and Pro includes 5,000 for USD99/month. All clients share account
usage. Included credits reset monthly. Agents cannot buy credits.

`transcription="never"` uses captions/text or existing cached transcripts only,
at 1 credit per source minute; the default `auto` reuses those first, then allows
audio fallback where the account and platform permit it. Fresh ASR costs 3 credits per minute and requires
explicit `transcription="if_needed"` plus an eligible paid plan or server-confirmed billing exemption. Do not silently
enable it after a caption-only failure. Bound authorized spending with
`max_credits` (required with `if_needed` for ordinary paid accounts).
Review `job.credits` for estimated, reserved and final amounts. Failed/canceled
jobs release reservations. Polling and
identical idempotent replays create no additional processing charge.

## Extract original source without an LLM

Call `extract_transcript` with `media` (raw text, URL or source object). Optional
`preferred_caption_languages` chooses captions in their original language;
spending/ASR controls and `refresh_source` match analysis jobs. There is no
`instructions` or `wait_seconds` argument and no summary or LLM call.

The accepted receipt is asynchronous. Preserve `job_id`; poll `get_job` or
`wait_job`, honoring the polling hint. When `output_mode="transcript"` completes,
use `transcript_id` with `get_saved_transcript` (`offset=0`, `limit=100`), then
follow `next_offset`. Transcript `wait_job` returns metadata and pointers with
`result: null`, so it never hydrates a full source. Submission needs `jobs:write`, polling `jobs:read`, and
source reads `summaries:read`. New extraction retains normal processing rates,
ASR consent and caps. Existing saved-source reads start no job and charge no
processing credits, so use `get_saved_transcript` directly when its ID is known.

REST uses `POST /v1/transcripts` and always returns HTTP 202 without inline
source; `GET /v1/transcripts/ID/page` reads bounded content. SDKs expose
`submitTranscript` / `submit_transcript` and the polling convenience
`extractTranscript` / `extract_transcript`. CLI: `tldw extract --media URL_OR_TEXT`.

## Analyze media with a custom focus

MCP `analyze_media` accepts the two main inputs, `media` and `instructions`:

```json
{
  "media": "Text to analyze or a supported public URL",
  "instructions": "Find interesting claims, assess the evidence and cite the source.",
  "idempotency_key": "analysis-request-001"
}
```

A media string containing a supported URL is fetched; other strings are treated
as raw text. For unambiguous pasted content, send
`{"type":"text","text":"Source content","title":"Optional title"}`. Explicit
source types are `auto`, `text`, `url`, `x`, `youtube`, `tiktok` and `article`.
A source object has exactly one of `text` or `url`. X objects can select
`scope: "auto" | "post" | "thread" | "article"`. All URLs must be public and
supported by the configured source provider. Text limits are operator-configured.

X links default to `scope:auto`, detecting one attached video and using its captions
when supported. `scope:post` reads post text alone. Use `instructions` to request a
translated summary, for example `Summarize the spoken content in Spanish.` The
result is generated text in the same schema; original captions stay unchanged.
No X audio transcription, visual analysis, dubbing or subtitle translation is
enabled. Missing video captions fail explicitly.

General analysis results have `schema_version: "3"`, `answer`, `findings`,
`sources` and `limitations`. Each finding references returned `source_ids`;
resolve those IDs to source labels/URLs/timestamps instead of inventing citations.
Text/article processing is billed using a reading-minute estimate; video keeps
its duration-based processing minutes. No extraction credential is needed for
pasted text. Public X posts may use the deployment's public retrieval mode;
complete X threads/articles and public web articles require source coverage and
the corresponding deployment extraction capabilities. Missing or partial content is reported
explicitly. Offer pasted source text if fetching is unavailable; do not substitute
a single post for a requested thread or pretend a page preview is a full article.

REST uses `POST /v1/analyses` with the same two fields and always responds with
HTTP 202 and a durable accepted receipt, without embedded output. MCP
`analyze_media` has no `wait_seconds` argument and returns that same receipt.
Preserve `job_id`; poll `get_job` / `GET /v1/jobs/JOB_ID`, observing progress and
`next_poll_after_ms`. After `job.status` is `completed`, fetch `get_summary` with
`job.summary_id` / `GET /v1/summaries/SUMMARY_ID`. Do not fetch output merely because
submission succeeded; failed and canceled jobs are terminal without new output.
Submission needs jobs:write, polling jobs:read, and output summaries:read.
See [copyable source examples](../../../examples/media/README.md).

## Bounded waits and retries

`wait_job` defaults to an 8-second wait; 0–10 seconds is supported. Read an embedded `result` when present; otherwise preserve `job_id`
and call `wait_job` or `get_job` with that ID. Honor `next_poll_after_ms`. A
timeout ends only the wait. A terminal receipt can be completed, failed or
canceled. Completed jobs carry `summary_id` for `get_summary`.

To retry a failed or canceled job, submit the same source again with
`analyze_media` or `extract_transcript` and a fresh stable `idempotency_key`.
The original job is unchanged. Keep the new key on network replay.

## Follow-up work and boundaries

Jobs are asynchronous. A successful
submission is not proof of completion. Keep returned IDs across turns and do not
resubmit accepted work because a client disconnects. `list_jobs` uses cursor
pagination; transcripts use offset/limit with at most 500 segments per page.
Untimed transcripts (`timed: false`) paginate source blocks: offset/limit index
blocks, `total_blocks` describes the full source, and `text` contains only the
returned page. Timed video pages retain their segment representation.

API keys cannot manage billing, credentials, account deletion or staff.
Use the signed-in app for those actions; plugins cannot upgrade their permissions.

Server-confirmed billing exemption: the authenticated server decides whether an account is exempt. Exempt accounts may omit a credit ceiling and do not incur customer-credit charges; explicit transcription permission and resource/provider limits still apply. Ordinary paid accounts allowing fresh transcription must supply a ceiling or receive `TRANSCRIPTION_NOT_ALLOWED` (HTTP 422); `MAX_CREDITS_EXCEEDED` (HTTP 422) means a supplied ceiling is invalid or below the required charge. Clients validate supplied values, then pass requests through without fetching extra account scopes or inferring privileges from names, roles, or key prefixes.

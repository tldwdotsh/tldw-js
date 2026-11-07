# Tool access

The SaaS exposes 29 tools and checks scopes and ownership on every call. Names
omit client-specific prefixes. `list_styles` and the `tldw://guide` resource
accept any active personal API key. The resource is not an additional tool.

| Tools                                                                  | Required scope                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| account_usage                                                          | account:read                                    |
| analyze_media, submit_video, retry_job, cancel_job, regenerate_summary | jobs:write                                      |
| get_job, wait_job, list_jobs                                           | jobs:read                                       |
| get_summary, get_transcript, export_summary                            | summaries:read                                  |
| compare_tiktoks, cancel_comparison                                     | jobs:write                                      |
| get_comparison                                                         | jobs:read; findings also require summaries:read |
| ask_video                                                              | chat:write                                      |
| get_video_chat                                                         | chat:read                                       |
| create_share, revoke_share                                             | shares:write                                    |
| create_batch, cancel_batch                                             | jobs:write                                      |
| get_batch, list_batches                                                | jobs:read                                       |
| submit_subtitles                                                       | uploads:write and jobs:write                    |
| list_support_tickets, get_support_ticket                               | support:read                                    |
| create_support_ticket, reply_support_ticket                            | support:write                                   |

Embedded summary/comparison results require summaries:read in addition to the
submission or status scope. Write-only access can submit work without exposing
its content. Instructions are limited to 4,000 characters and stay in the owner's
private workflow. Public summary responses omit the brief, while shared
result content can still reflect it.

New Free users verify once in the browser. Free includes 500 monthly caption/text credits; Hobby includes 1,000 for
USD20/month and Pro includes 5,000 for USD99/month. All clients share account
usage. Included allowance is used before non-expiring purchased credits.

Default `transcription="never"` uses captions/text or existing cached transcripts
at 1 credit per source minute. Fresh ASR costs 3 credits per minute and requires
explicit `transcription="if_needed"` plus an eligible paid plan or server-confirmed billing exemption. Do not silently
enable it after a caption-only failure. Bound authorized spending with
`max_credits` (required with `if_needed` for ordinary paid accounts); comparisons/batches split that aggregate ceiling equally across
distinct clips, round down to 0.01 credit and never redistribute unused shares.
Review `job.credits` for estimated, reserved and final amounts. Failed/canceled
jobs release reservations; completed clips retain their charges. Polling and
identical idempotent replays create no additional processing charge.

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

## Summarize video with an explicit style

MCP `submit_video` arguments:

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "style": "standard",
  "instructions": "Focus on practical takeaways and flag weak evidence.",
  "idempotency_key": "summary-request-001",
  "wait_seconds": 8
}
```

The legacy `submit_video`, `regenerate_summary`, `submit_subtitles` and `wait_job` tools default to
an 8-second wait; 0–10 seconds is supported. Read an embedded `result` when present;
otherwise preserve `job_id` and call `wait_job` with that ID. Honor
`next_poll_after_ms`. A timeout ends only the wait. A terminal receipt can be
completed, failed or canceled. Completed jobs carry `summary_id` for `get_summary`.
For regeneration, omit `instructions` to inherit or pass `""` to clear the brief.

REST uses the same API key and body options, with no plugin requirement:
`POST /v1/jobs?wait_seconds=8` accepts `url` and
`options: {"style":"standard","force_asr":false,"instructions":"Your focus"}`.
Set the `Idempotency-Key` header and retain the same body and key on an unknown
outcome. Resume with `GET /v1/jobs/JOB_ID/wait?wait_seconds=8`.
REST regeneration accepts explicit `null` or `""` to clear instructions.

`retry_job` accepts an owned failed/canceled `job_id`, an optional stable
`idempotency_key`, and `wait_seconds` (default 8). It creates a new job ID and
normal plan-controlled processing request instead of changing the source job. Keep that retry's
key on replay. REST uses `POST /v1/jobs/JOB_ID/retry?wait_seconds=8` with the
`Idempotency-Key` header and no request body.

## Compare supplied TikToks

MCP `compare_tiktoks` arguments:

```json
{
  "urls": [
    "https://www.tiktok.com/@creator/video/VIDEO_ID_1",
    "https://www.tiktok.com/@creator/video/VIDEO_ID_2"
  ],
  "instructions": "Compare spoken hooks and audience pain points. Cite each finding.",
  "idempotency_key": "comparison-request-001",
  "wait_seconds": 8
}
```

Supply 2–20 TikTok links; the IDs above are placeholders. Optional
`summary_instructions` overrides the per-clip extraction brief. The default
extracts spoken hooks, claims and problems for comparison. Read the returned
`comparison.id`, coverage and status. Follow `get_comparison` with
`{"comparison_id":"RETURNED_ID","wait_seconds":8}`; its default wait is zero.
`cancel_comparison` cancels unfinished collection/aggregation work when requested.

REST uses `POST /v1/comparisons?wait_seconds=8` with `urls`, optional comparison
`instructions` and optional per-clip `options.instructions`. Resume via
`GET /v1/comparisons/COMPARISON_ID/wait?wait_seconds=8`, or cancel via
`POST /v1/comparisons/COMPARISON_ID/cancel`.

Comparison results require at least two distinct clips with usable evidence.
Read coverage, per-source failures, citations and `result.limitations`. Findings
apply to available captions or transcribed speech in the supplied sample. They do
not establish platform-wide trends, engagement/popularity or unseen visuals.
Completed clips use normal processing minutes; aggregation adds no processing
minutes. Canceling does not reverse usage for already completed clips.

## Follow-up work and boundaries

Jobs, chat answers, batches and comparisons are asynchronous. A successful
submission is not proof of completion. Keep returned IDs across turns and do not
resubmit accepted work because a client disconnects. `list_jobs` uses cursor
pagination; transcripts use offset/limit with at most 500 segments per page.
Untimed transcripts (`timed: false`) paginate source blocks: offset/limit index
blocks, `total_blocks` describes the full source, and `text` contains only the
returned page. Timed video pages retain their segment representation.

Sharing publishes result content to anyone holding the link. It omits full
transcripts and the custom brief. A ticket requests human support; it does not
imply a person has replied.
API keys cannot manage billing, credentials, account deletion or staff.
Use the signed-in app for those actions; plugins cannot upgrade their permissions.


Server-confirmed billing exemption: the authenticated server decides whether an account is exempt. Exempt accounts may omit a credit ceiling and do not incur customer-credit charges; explicit transcription permission and resource/provider limits still apply. Ordinary paid accounts allowing fresh transcription must supply a ceiling or receive `MAX_CREDITS_EXCEEDED` (HTTP 422). Clients validate supplied values, then pass requests through without fetching extra account scopes or inferring privileges from names, roles, or key prefixes.

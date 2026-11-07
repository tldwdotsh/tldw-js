# One media input, one instruction brief

The REST endpoint is `POST /v1/analyses`. Its body contains
`media` and optional `instructions`. Use the same fields with MCP `analyze_media`;
MCP also accepts `idempotency_key`; `analyze_media` has no `wait_seconds` argument.

The accompanying [pasted-text body](text.request.json) needs no source-retrieval
credential. The [X thread body](x-thread.request.json) needs the operator's X API
access; its URL is a placeholder. An unavailable or incomplete thread is reported
as such. Paste the full authorized source text instead when fetching is unavailable.

```json
{
  "media": {
    "type": "article",
    "url": "https://example.org/article"
  },
  "instructions": "Extract the surprising claims and explain the evidence for each."
}
```

YouTube and TikTok URLs work through the same endpoint. For an explicit X post,
thread or article, set `type: "x"` and `scope: "post"`, `"thread"` or `"article"`.
For a public web article, use `type: "article"` and the operator's configured
article extractor. Never put credentials in the source body or instruction brief.

Use a stable `Idempotency-Key` REST header for one intended analysis. Keep the body
and key on an unknown network outcome. REST always returns HTTP 202 with a
`job_id`, `status_url` and `events_url`, without embedding output. MCP returns the
same accepted receipt. Poll MCP `get_job` / REST `GET /v1/jobs/JOB_ID`, following
`next_poll_after_ms` and rate-limit guidance. After `job.status` is `completed`,
fetch MCP `get_summary` / REST `GET /v1/summaries/SUMMARY_ID` with `job.summary_id`.
Submission needs jobs:write, progress jobs:read and output summaries:read.
Failed/canceled jobs are terminal; do not resubmit accepted work to poll it.

General results contain `schema_version: "3"`, `answer`, `findings`, `sources`
and `limitations`. Resolve each finding's `source_ids` against the returned
sources, keeping any URL or timestamp. Text has a reading-minute billing estimate;
it does not acquire fabricated video timestamps. Review limitations before
presenting partial content as a complete analysis.

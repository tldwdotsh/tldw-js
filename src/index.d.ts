/**
 * Type declarations for @tldw/client, the dependency-free client for the
 * asynchronous tldw.sh API (the implementation is index.mjs).
 *
 * Work is asynchronous: submitAnalysis() returns an accepted job at once,
 * waitForJob() polls it until it finishes, and getSummary() or
 * getTranscript() read the saved result. analyze() and extractTranscript()
 * chain those steps. Invalid arguments throw TypeError before any request is
 * sent; API, network and response problems throw TldwError.
 *
 * Response interfaces list the fields the client relies on. The API can add
 * fields over time; Job and Summary declare an index signature for them.
 */

/**
 * Media to analyze: a YouTube or public X URL string, complete supplied text,
 * or an explicit supported source object.
 */
export type Media = string | MediaInput;
/** Source object; provide exactly one of text or url. */
export interface MediaInput {
  type?: "auto" | "text" | "url" | "youtube" | "x";
  text?: string;
  url?: string;
  title?: string;
  scope?: "auto" | "post" | "thread" | "article";
}
/** Explicit X source. Omit scope (or use auto) to detect attached video captions. */
export interface XMedia {
  type: "x";
  /** Public X post URL. */
  url: string;
  /** post is text-only; thread does not recursively analyze attached videos. */
  scope?: "auto" | "post" | "thread" | "article";
}
/** Credit accounting for one job. Credit amounts are decimal numbers or strings. */
export interface JobCredits {
  /** Processing-billing exemption frozen when the job was admitted. */
  billing_exempt?: boolean;
  /** Estimated charge before processing; null when not yet known. */
  estimated: number | string | null;
  /** Credits held for the job while it runs. */
  reserved: number | string;
  /** Credits charged once the job finished; null until then. */
  final: number | string | null;
  /** The job's credit ceiling, if one was set (null for exempt jobs). */
  max_credits?: number | string | null;
  /** Credits per billable source minute for this job's billing class. */
  rate_multiplier: number | string;
  /**
   * `standard`: captions, text or a saved transcript. `fresh_asr`: historical
   * audio transcription jobs. `reask`: a source this account already processed.
   */
  billing_class: "standard" | "fresh_asr" | "reask";
  /** Identifier of the pricing rules that priced the job. */
  billing_policy_version: string | null;
  /** Billable source duration, when known. */
  media_duration_seconds: number | null;
}
/** A processing job, as returned by getJob(), listJobs() and waitForJob(). */
export interface Job {
  id: string;
  /**
   * `completed`, `failed` and `canceled` are terminal; every other status
   * means the job is still in progress.
   */
  status:
    | "queued"
    | "queued_for_slot"
    | "fetching_metadata"
    | "fetching_transcript"
    | "downloading_audio"
    | "transcribing"
    | "summarizing"
    | "completed"
    | "failed"
    | "canceled";
  /** Integer percentage from 0 to 100. */
  progress: number;
  /** Set once a summary or analysis job completes; read it with getSummary(). */
  summary_id?: string | null;
  output_mode?: "summary" | "analysis" | "transcript";
  /** Saved source transcript; the result of a completed transcript-mode job. */
  transcript_id?: string | null;
  /** Informational server path; the client never fetches returned URLs. */
  transcript_url?: string | null;
  /** `details` carries allow-listed public fields such as `wall` and `upgrade`. */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
  } | null;
  /** Server's suggested delay before the next poll; waitForJob() honors it. */
  next_poll_after_ms?: number | null;
  credits?: JobCredits;
  /** Set while `status` is `queued_for_slot`: 1 means next to start. */
  queue_position?: number | null;
  /** The plan's concurrent-job limit, reported alongside the queue position. */
  max_concurrent_jobs?: number | null;
  /** Human-readable note about the queue wait. */
  queue_notice?: string | null;
  [key: string]: unknown;
}
/**
 * The receipt returned by submitAnalysis(). Persist `job_id` first: it is
 * what you resume with after an interruption.
 */
export interface AnalysisAccepted {
  job_id: string;
  /** The job's state when the submission was accepted. */
  job: Job;
  /** Server path of the job resource (informational). */
  status_url: string;
  /** Informational server path; streamJobEvents() constructs its own validated path. */
  events_url: string;
  /** True when the job had already finished, which happens on a replay. */
  terminal: boolean;
  /** True when the result can be read now. */
  result_available: boolean;
  result_url?: string | null;
  /** Server's suggested delay before the first poll. */
  next_poll_after_ms?: number | null;
  /** True when this response replays an earlier submission (same Idempotency-Key). */
  replayed?: boolean;
  output_mode?: "summary" | "analysis" | "transcript";
  transcript_id?: string | null;
  transcript_url?: string | null;
}
/** One bounded GET /v1/jobs/{id}/wait response; no processing is submitted. */
export interface JobReceipt {
  job_id: string;
  job: Job;
  terminal: boolean;
  result_available: boolean;
  output_mode: "summary" | "analysis" | "transcript";
  result?: Summary | TranscriptContent | null;
  result_required_scope?: string | null;
  result_url?: string | null;
  wait_url?: string | null;
  transcript_id?: string | null;
  transcript_url?: string | null;
  next_poll_after_ms?: number | null;
  replayed?: boolean;
}
/** One validated event from a single authenticated job stream. */
export interface JobEvent {
  event: "snapshot" | "status" | "completed" | "failed" | "canceled";
  id: string | null;
  data: Job;
}
/** One page of jobs, newest first. */
export interface JobList {
  items: Job[];
  /** Pass to listJobs({ cursor }) for the next page; null on the last page. */
  next_cursor: string | null;
}
/** Result of cancelJob(): the job's terminal state after the request. */
export interface CancelResult {
  id: string;
  /** `completed` or `failed` when the job finished before it could be canceled. */
  status: "completed" | "failed" | "canceled";
}
/** A generated summary or analysis. */
export interface Summary<TContent = Record<string, unknown>> {
  id: string;
  /** The generated output. */
  content: TContent;
  is_demo?: boolean;
  [key: string]: unknown;
}
/**
 * The original source text behind a result (not generated content). Video
 * sources are timed and use `segments`; text and X sources use `blocks` and
 * `text`.
 */
export interface TranscriptContent {
  transcript_id: string;
  /** Source language code, when known. */
  language: string | null;
  /**
   * Where the text came from, for example `platform_manual` or
   * `platform_auto` captions, `asr` (audio transcription) or `submitted_text`.
   */
  source: string;
  /** X post context and captions use blocks; caption blocks retain timestamps. */
  timed: boolean;
  /** Timed transcript lines, with start and end offsets in milliseconds. */
  segments: Array<{
    start_ms: number;
    end_ms: number;
    text: string;
    speaker?: string | null;
  }>;
  /** Labeled parts of a text or X source; caption blocks keep start_s/end_s. */
  blocks: Array<{
    id: string;
    label: string;
    text: string;
    url?: string | null;
    start_s?: number | null;
    end_s?: number | null;
  }>;
  /** Source text (the selected page on paged reads); null when `timed` is true. */
  text: string | null;
}
/** One page from getTranscriptPage() or getSavedTranscriptPage(). */
export interface TranscriptPage extends TranscriptContent {
  total_segments: number;
  total_blocks: number;
  /** Offset for the next page; null after the last page. */
  next_offset: number | null;
}
/** Metadata of a saved source transcript (no text). */
export interface SavedTranscript {
  id: string;
  /** The source the transcript belongs to. */
  video: {
    id: string;
    /** legacy identifies a historical source unavailable for new submissions. */
    platform: "youtube" | "upload" | "text" | "x" | "article" | "legacy";
    platform_video_id: string;
    url: string | null;
    title: string | null;
    channel_name: string | null;
    duration_ms: number | null;
    thumbnail_url: string | null;
  };
  source: string;
  language: string | null;
  provider: string;
  content_kind: "timed" | "text";
  has_timestamps: boolean;
  segment_count: number;
  block_count: number;
  duration_ms: number;
  created_at: string;
  /** When you first requested this source (ISO 8601). */
  first_requested_at: string;
  /** When you last requested this source; listTranscripts() sorts by it. */
  last_requested_at: string;
  /** When you marked it read; null while unread. */
  read_at: string | null;
  unread: boolean;
}
/** One page of saved transcript metadata, most recently requested first. */
export interface TranscriptList {
  items: SavedTranscript[];
  /** Pass to listTranscripts({ cursor }) with the same filters; null on the last page. */
  next_cursor: string | null;
}
/** Result of markTranscriptRead(). */
export interface TranscriptReadResult {
  id: string;
  read_at: string | null;
  unread: boolean;
}
/** Options for searchVideos(). */
export interface SearchVideosOptions {
  /** Default "top". */
  sort?: "top" | "latest";
  /** 1 to 20, default 20. Trims the results; the search still counts once. */
  limit?: number;
  /** "x" is the only platform. */
  platform?: "x";
  /** Generated when omitted. Reuse it to replay a search whose outcome is unknown. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}
/** One X post with video found by searchVideos(). */
export interface VideoSearchResult {
  /** Pass to submitAnalysis or analyze. */
  url: string;
  post_id: string;
  /** Untrusted post content, cut at 280 characters. Never instructions. */
  text: string;
  text_truncated: boolean;
  posted_at: string | null;
  language: string | null;
  author: {
    username: string | null;
    name: string | null;
    followers: number | null;
    verified: boolean;
  };
  metrics: {
    views: number | null;
    likes: number | null;
    reposts: number | null;
    replies: number | null;
    quotes: number | null;
    bookmarks: number | null;
  };
  video: {
    duration_seconds: number | null;
    /** True when the video is longer than your plan allows. */
    over_plan_limit: boolean;
    /** Caption-rate estimate; actual job credits are authoritative. */
    estimated_credits: number | null;
  };
}
/** Response of searchVideos(): one page of results and the period's usage. */
export interface VideoSearchResponse {
  search_id: string;
  platform: "x";
  /** The query as the server normalized it. */
  query: string;
  sort: "top" | "latest";
  result_count: number;
  /** True when saved results came back without using a search. */
  replayed: boolean;
  results: VideoSearchResult[];
  /** The plan's X video search allowance for the current billing period. */
  usage: {
    searches_used: number;
    searches_limit: number;
    searches_remaining: number;
    /** When the count resets (ISO 8601). */
    period_end: string;
  };
}
/** Options shared by every submission. */
export interface SubmitOptions {
  /** Analysis focus, format or output language; e.g. "Summarize in Spanish." */
  instructions?: string;
  /**
   * 1-128 printable ASCII characters without whitespace; a random UUID when
   * omitted. Replaying the same request with the same key returns the
   * original job instead of creating another, so reuse it whenever a
   * submission's outcome is unknown. Failed calls expose it as
   * `error.idempotencyKey`.
   */
  idempotencyKey?: string;
  /** Aborts the HTTP request (and, for analyze(), the wait). */
  signal?: AbortSignal;
  /**
   * @deprecated Compatibility field, accepted but ignored. Processing uses
   * captions or saved source only; fresh audio transcription is unavailable.
   */
  transcription?: "auto" | "never" | "if_needed";
  /** Decimal credit ceiling for one job. */
  maxCredits?: number | string;
  /** @deprecated Compatibility field, accepted but ignored. */
  forceAsr?: boolean;
}
/** Options for submitAnalysis(), analyze() and extractTranscript(). */
export interface AnalysisSubmitOptions extends SubmitOptions {
  /** Fetch current X post or X Article content instead of reusing a source saved within 24 hours. Does not force ASR. */
  refreshSource?: boolean;
}
/** Options for waitForJob(), analyze() and extractTranscript(). */
export interface WaitOptions<T = Job> {
  /** Total wait budget in ms, 1 to 3600000 (default 180000). The job keeps running after it. */
  timeoutMs?: number;
  /** Minimum ms between polls, 250 to 30000 (default 1500); server hints can lengthen it. */
  pollIntervalMs?: number;
  /** Stops waiting, not the job. */
  signal?: AbortSignal;
  /** Called (and awaited) after every poll; throwing ends the wait. */
  onProgress?: (resource: T) => void | Promise<void>;
}
export interface TranscriptPageOptions {
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}
export type ExtractTranscriptOptions = AnalysisSubmitOptions &
  WaitOptions & {
    /** Select a bounded source page after processing; omit both for the full source. */
    offset?: number;
    limit?: number;
  };
export interface TranscriptExtraction<
  T extends TranscriptContent = TranscriptContent,
> {
  receipt: AnalysisAccepted;
  job: Job;
  transcript: T;
}
/** Constructor options for {@link TldwClient}. */
export interface ClientOptions {
  /** Defaults to TLDW_API_URL, or https://api.tldw.sh when unset. */
  apiUrl?: string;
  /**
   * Scoped tldw API key, sent as a Bearer token and never exposed as a
   * property. Required unless `allowAnonymous` is set on a loopback origin.
   */
  token?: string;
  /** Allow token-less requests; only effective on a loopback development origin. */
  allowAnonymous?: boolean;
  /** Fetch implementation (for example a test double); defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Budget in ms for one API call including retries, 1 to 120000 (default 30000). */
  requestTimeoutMs?: number;
}
/** Optional fields for constructing a {@link TldwError}. */
export interface ErrorDetails {
  code?: string;
  status?: number | null;
  requestId?: string | null;
  retryAfterMs?: number | null;
  jobId?: string | null;
  /** @deprecated Comparisons were removed from the client; always null. */
  comparisonId?: string | null;
  details?: Record<string, unknown> | null;
}
/** Error raised for API, network and invalid-response failures. */
export class TldwError extends Error {
  constructor(message: string, details?: ErrorDetails);
  /**
   * The API's error code (for example QUOTA_EXCEEDED or RATE_LIMITED), or a
   * client code: CLIENT_ERROR, HTTP_ERROR, INVALID_RESPONSE, NETWORK_ERROR,
   * WAIT_TIMEOUT, JOB_FAILED or CANCELED.
   */
  code: string;
  /** HTTP status, or null when no response was received. */
  status: number | null;
  /** Server request ID, for support requests. */
  requestId: string | null;
  /** Parsed Retry-After header in milliseconds. */
  retryAfterMs: number | null;
  /** The job this error concerns; resume it rather than resubmitting. */
  jobId: string | null;
  /** @deprecated Comparisons were removed from the client; always null. */
  comparisonId: string | null;
  /** Redacted `error.details` from the API, e.g. `{ job_id }` or `{ required_scope }`. */
  details: Record<string, unknown> | null;
  /** Set by submissions and searches; replay with it when the outcome is unknown. */
  idempotencyKey?: string;
  /** Set by analyze() and extractTranscript() when the job was accepted. */
  receipt?: AnalysisAccepted;
}
/** A local wait or request deadline passed (code WAIT_TIMEOUT); accepted work continues. */
export class TldwTimeoutError extends TldwError {
  constructor(message?: string, details?: ErrorDetails);
}
/** The job finished as `failed` or `canceled`; `resource` is the final job. */
export class TldwJobError extends TldwError {
  constructor(resource: Job, kind?: "job");
  resource: Job;
}
/**
 * Validate an API origin: HTTPS without credentials, query, fragment or
 * path; plain HTTP only on localhost, 127.0.0.1 or [::1]. Returns the
 * normalized origin and whether it is loopback. Throws TypeError otherwise.
 */
export function validateApiUrl(value: string): {
  origin: string;
  loopback: boolean;
};
/** Production API origin. */
export const DEFAULT_API_URL: "https://api.tldw.sh";
/** TLDW_API_URL when set and non-empty, otherwise DEFAULT_API_URL. */
export function defaultApiUrl(): string;
/**
 * Client for the tldw.sh REST API. Never follows redirects or URLs returned
 * by the server, redacts the token from errors, and retries only transient
 * failures within its time budget.
 *
 * @example
 * import { TldwClient } from "@tldw/client";
 *
 * const client = new TldwClient({ token: process.env.TLDW_API_TOKEN });
 * const { job, summary } = await client.analyze(
 *   "https://www.youtube.com/watch?v=VIDEO_ID",
 *   { instructions: "List the key claims with timestamps.", maxCredits: 30 },
 * );
 */
export class TldwClient {
  /** Throws TypeError for an invalid origin, token or option. */
  constructor(options: ClientOptions);
  /** The validated API origin. */
  readonly apiUrl: string;
  readonly requestTimeoutMs: number;
  /**
   * Search X posts with video (not YouTube): one page of up to 20 results, no next page.
   * A new search uses one of the plan's monthly searches, and the count resets each
   * billing period; the same query and sort within 15 minutes is replayed without
   * counting. Requires jobs:write.
   */
  searchVideos(
    query: string,
    options?: SearchVideosOptions,
  ): Promise<VideoSearchResponse>;
  /**
   * Submit media and return as soon as the job is accepted. Persist
   * `job_id`, then waitForJob(). After an unknown outcome, resubmit the same
   * media and options with the same idempotency key to get the original job.
   * Requires jobs:write.
   */
  submitAnalysis(
    media: Media,
    options?: AnalysisSubmitOptions,
  ): Promise<AnalysisAccepted>;
  /** Analyze once, wait, then read the original saved transcript separately. Normal processing applies. */
  extractTranscript(
    media: Media,
    options: ExtractTranscriptOptions &
      ({ offset: number } | { limit: number }),
  ): Promise<TranscriptExtraction<TranscriptPage>>;
  extractTranscript(
    media: Media,
    options?: ExtractTranscriptOptions,
  ): Promise<TranscriptExtraction>;
  /** Read a job's current state once. Requires jobs:read. */
  getJob(id: string, options?: { signal?: AbortSignal }): Promise<Job>;
  /** One server wait, 0-10 seconds; waitForJob() continues until terminal. */
  waitJob(
    id: string,
    options?: {
      waitSeconds?: number;
      includeResult?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<JobReceipt>;
  /** One SSE connection, never reconnected; timeout defaults to requestTimeoutMs, maximum 610000ms. Requires jobs:read. */
  streamJobEvents(
    id: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): AsyncIterableIterator<JobEvent>;
  /** List your jobs, newest first. `limit` is 1 to 100 (default 20). Requires jobs:read. */
  listJobs(options?: {
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<JobList>;
  /** Explicitly stop an owned job. Ending a local wait never cancels a job. */
  cancelJob(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<CancelResult>;
  /** Read a generated summary, usually `job.summary_id`. Requires summaries:read. */
  getSummary<TContent = Record<string, unknown>>(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Summary<TContent>>;
  /** Read the original source behind a summary. Starts no processing. Requires summaries:read. */
  getTranscript(
    summaryId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptContent>;
  /** Read one bounded original-source page behind a summary. Starts no processing. */
  getTranscriptPage(
    summaryId: string,
    options?: TranscriptPageOptions,
  ): Promise<TranscriptPage>;
  /** Metadata only, ordered by latest owned request. Does not mark read. */
  listTranscripts(options?: {
    limit?: number;
    cursor?: string;
    /** Inclusive latest-request ISO 8601 timestamp. */
    since?: string;
    /** Exclusive latest-request ISO 8601 timestamp. */
    until?: string;
    unreadOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<TranscriptList>;
  /** Read a full saved source transcript by transcript ID. Does not mark read. */
  getSavedTranscript(
    transcriptId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptContent>;
  /** Read metadata by ID without loading the body, starting work or marking read. */
  getSavedTranscriptMetadata(
    transcriptId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SavedTranscript>;
  /** Read one page (`limit` 1 to 500, default 100); continue from `next_offset`. Does not mark read. */
  getSavedTranscriptPage(
    transcriptId: string,
    options?: TranscriptPageOptions,
  ): Promise<TranscriptPage>;
  /** Mark a saved transcript read (default) or unread; repeating a mark is harmless. */
  markTranscriptRead(
    transcriptId: string,
    read?: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptReadResult>;
  /** Read plan, credit usage and limits (GET /v1/me). Requires account:read. */
  getUsage(options?: {
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
  /**
   * Poll until the job completes. Rejects with TldwJobError when it fails or
   * is canceled and TldwTimeoutError when `timeoutMs` passes; every error
   * carries `jobId`, and the job keeps running after a timeout or abort.
   */
  waitForJob(id: string, options?: WaitOptions): Promise<Job>;
  /**
   * Submit, wait and read the summary in one call. Errors raised after the
   * job was accepted carry `jobId` and `receipt` for resuming.
   */
  analyze<TContent = Record<string, unknown>>(
    media: Media,
    options?: AnalysisSubmitOptions & WaitOptions,
  ): Promise<{
    receipt: AnalysisAccepted;
    job: Job;
    summary: Summary<TContent>;
  }>;
}

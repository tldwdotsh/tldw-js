export type Media = string | XMedia | Record<string, unknown>;
/** Explicit X source. Omit scope (or use auto) to detect attached video captions. */
export interface XMedia {
  type: "x";
  url: string;
  /** post is text-only; thread does not recursively analyze attached videos. */
  scope?: "auto" | "post" | "thread" | "article";
}
export interface JobCredits {
  billing_exempt?: boolean;
  estimated: number | string | null;
  reserved: number | string;
  final: number | string | null;
  max_credits?: number | string | null;
  rate_multiplier: number | string;
  billing_class: "standard" | "fresh_asr";
  billing_policy_version: string | null;
  media_duration_seconds: number | null;
}
export interface Job {
  id: string;
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
  progress: number;
  summary_id?: string | null;
  output_mode?: "summary" | "analysis" | "transcript";
  transcript_id?: string | null;
  transcript_url?: string | null;
  /** `details` carries allow-listed public fields such as `wall` and `upgrade`. */
  error?: { code: string; message: string; details?: Record<string, unknown> | null } | null;
  next_poll_after_ms?: number | null;
  credits?: JobCredits;
  /** Set while `status` is `queued_for_slot`: 1 means next to start. */
  queue_position?: number | null;
  max_concurrent_jobs?: number | null;
  queue_notice?: string | null;
  [key: string]: unknown;
}
export interface AnalysisAccepted {
  job_id: string;
  job: Job;
  status_url: string;
  events_url: string;
  terminal: boolean;
  result_available: boolean;
  result_url?: string | null;
  next_poll_after_ms?: number | null;
  replayed?: boolean;
  output_mode?: "summary" | "analysis" | "transcript";
  transcript_id?: string | null;
  transcript_url?: string | null;
}
export interface TranscriptAccepted extends AnalysisAccepted {
  output_mode: "transcript";
  job: Job & { output_mode: "transcript" };
}
export interface Summary<TContent = Record<string, unknown>> {
  id: string;
  content: TContent;
  is_demo?: boolean;
  [key: string]: unknown;
}
export interface TranscriptContent {
  transcript_id: string;
  language: string | null;
  source: string;
  /** X post context and captions use blocks; caption blocks retain timestamps. */
  timed: boolean;
  segments: Array<{
    start_ms: number;
    end_ms: number;
    text: string;
    speaker?: string | null;
  }>;
  blocks: Array<{
    id: string;
    label: string;
    text: string;
    url?: string | null;
    start_s?: number | null;
    end_s?: number | null;
  }>;
  text: string | null;
}
export interface TranscriptPage extends TranscriptContent {
  total_segments: number;
  total_blocks: number;
  next_offset: number | null;
}
export interface SavedTranscript {
  id: string;
  video: {
    id: string;
    platform: "youtube" | "tiktok" | "upload" | "text" | "x" | "article";
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
  first_requested_at: string;
  last_requested_at: string;
  read_at: string | null;
  unread: boolean;
}
export interface TranscriptList {
  items: SavedTranscript[];
  next_cursor: string | null;
}
export interface TranscriptReadResult {
  id: string;
  read_at: string | null;
  unread: boolean;
}
export interface SubmitOptions {
  /** Analysis focus, format or output language; e.g. "Summarize in Spanish." */
  instructions?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Default never: use captions/text or an existing cached transcript only. */
  transcription?: "never" | "if_needed";
  /** Decimal credit ceiling for one job. */
  maxCredits?: number | string;
  /** Requires explicit transcription=if_needed and server-authorized ASR access. */
  forceAsr?: boolean;
}
export interface AnalysisSubmitOptions extends SubmitOptions {
  /** Fetch current X/article content instead of reusing a source saved within 24 hours. Does not force ASR. */
  refreshSource?: boolean;
}
export type TranscriptSubmitOptions = Omit<
  AnalysisSubmitOptions,
  "instructions"
> & {
  preferredCaptionLanguages?: string[];
};
export interface WaitOptions<T = Job> {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (resource: T) => void | Promise<void>;
}
export interface ClientOptions {
  apiUrl: string;
  token?: string;
  allowAnonymous?: boolean;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}
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
export class TldwError extends Error {
  constructor(message: string, details?: ErrorDetails);
  code: string;
  status: number | null;
  requestId: string | null;
  retryAfterMs: number | null;
  jobId: string | null;
  /** @deprecated Comparisons were removed from the client; always null. */
  comparisonId: string | null;
  /** Redacted `error.details` from the API, e.g. `{ job_id }` or `{ required_scope }`. */
  details: Record<string, unknown> | null;
  idempotencyKey?: string;
  receipt?: AnalysisAccepted;
}
export class TldwTimeoutError extends TldwError {
  constructor(message?: string, details?: ErrorDetails);
}
export class TldwJobError extends TldwError {
  constructor(resource: Job, kind?: "job");
  resource: Job;
}
export function validateApiUrl(value: string): {
  origin: string;
  loopback: boolean;
};
export class TldwClient {
  constructor(options: ClientOptions);
  readonly apiUrl: string;
  readonly requestTimeoutMs: number;
  submitAnalysis(
    media: Media,
    options?: AnalysisSubmitOptions,
  ): Promise<AnalysisAccepted>;
  /** Save original captions/source text without generating an analysis or invoking an LLM. */
  submitTranscript(
    media: Media,
    options?: TranscriptSubmitOptions,
  ): Promise<TranscriptAccepted>;
  extractTranscript(
    media: Media,
    options?: TranscriptSubmitOptions & WaitOptions,
  ): Promise<{
    receipt: TranscriptAccepted;
    job: Job;
    transcript: TranscriptContent;
  }>;
  getJob(id: string, options?: { signal?: AbortSignal }): Promise<Job>;
  getSummary<TContent = Record<string, unknown>>(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Summary<TContent>>;
  getTranscript(
    summaryId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptContent>;
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
  getSavedTranscript(
    transcriptId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptContent>;
  /** Read metadata by ID without loading the body, starting work or marking read. */
  getSavedTranscriptMetadata(
    transcriptId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SavedTranscript>;
  getSavedTranscriptPage(
    transcriptId: string,
    options?: { offset?: number; limit?: number; signal?: AbortSignal },
  ): Promise<TranscriptPage>;
  markTranscriptRead(
    transcriptId: string,
    read?: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptReadResult>;
  getUsage(options?: {
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
  waitForJob(id: string, options?: WaitOptions): Promise<Job>;
  analyze<TContent = Record<string, unknown>>(
    media: Media,
    options?: AnalysisSubmitOptions & WaitOptions,
  ): Promise<{
    receipt: AnalysisAccepted;
    job: Job;
    summary: Summary<TContent>;
  }>;
}

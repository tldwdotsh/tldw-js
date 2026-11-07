export type Media = string | Record<string, unknown>;
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
  error?: { code: string; message: string } | null;
  next_poll_after_ms?: number | null;
  credits?: JobCredits;
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
}
export interface Summary<TContent = Record<string, unknown>> {
  id: string;
  content: TContent;
  is_demo?: boolean;
  [key: string]: unknown;
}
export interface Comparison {
  id: string;
  status:
    | "queued"
    | "waiting"
    | "processing"
    | "completed"
    | "failed"
    | "canceled";
  result?: {
    summary: string;
    findings: Array<Record<string, unknown>>;
    limitations: string[];
  } | null;
  error?: { code: string; message: string } | null;
  coverage?: Record<string, number>;
  next_poll_after_ms?: number | null;
  credits?: {
    max_credits: number | string | null;
    per_job_max_credits: number | string | null;
    allocation_count: number | null;
    unused_budget_redistributed: false;
    reserved: number | string;
    billed_so_far: number | string;
    final: number | string | null;
  } | null;
  [key: string]: unknown;
}
export interface SubmitOptions {
  instructions?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Default never: use captions/text or an existing cached transcript only. */
  transcription?: "never" | "if_needed";
  /** Decimal credit ceiling; aggregate fixed-share ceiling for comparisons. */
  maxCredits?: number | string;
  /** Requires explicit transcription=if_needed and server-authorized ASR access. */
  forceAsr?: boolean;
}
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
  comparisonId?: string | null;
}
export class TldwError extends Error {
  constructor(message: string, details?: ErrorDetails);
  code: string;
  status: number | null;
  requestId: string | null;
  retryAfterMs: number | null;
  jobId: string | null;
  comparisonId: string | null;
  idempotencyKey?: string;
  receipt?: AnalysisAccepted;
}
export class TldwTimeoutError extends TldwError {
  constructor(message?: string, details?: ErrorDetails);
}
export class TldwJobError extends TldwError {
  constructor(resource: Job | Comparison, kind?: "job" | "comparison");
  resource: Job | Comparison;
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
    options?: SubmitOptions,
  ): Promise<AnalysisAccepted>;
  getJob(id: string, options?: { signal?: AbortSignal }): Promise<Job>;
  getSummary<TContent = Record<string, unknown>>(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Summary<TContent>>;
  getUsage(options?: {
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
  waitForJob(id: string, options?: WaitOptions): Promise<Job>;
  analyze<TContent = Record<string, unknown>>(
    media: Media,
    options?: SubmitOptions & WaitOptions,
  ): Promise<{
    receipt: AnalysisAccepted;
    job: Job;
    summary: Summary<TContent>;
  }>;
  compareTikToks(urls: string[], options?: SubmitOptions): Promise<Comparison>;
  getComparison(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Comparison>;
  waitForComparison(
    id: string,
    options?: WaitOptions<Comparison>,
  ): Promise<Comparison>;
}

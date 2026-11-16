/**
 * @tldw/client: a dependency-free JavaScript client for the asynchronous
 * tldw.sh API. Requires Node.js 20.11 or newer.
 *
 * tldw.sh summarizes and analyzes videos and other media: YouTube links,
 * public X posts (with their attached video or Article) and pasted
 * text. Processing is asynchronous. A submission is accepted at once with a
 * durable job ID, the job is polled until it finishes, and the result is read
 * separately:
 *
 *   import { TldwClient } from "@tldw/client";
 *
 *   const client = new TldwClient({ token: process.env.TLDW_API_TOKEN });
 *
 *   // One call: submit, wait, then read the summary.
 *   const { job, summary } = await client.analyze(url, { maxCredits: 30 });
 *
 *   // Or keep durable control of each step. Persist receipt.job_id: if the
 *   // wait is interrupted, resume it with waitForJob instead of resubmitting.
 *   const receipt = await client.submitAnalysis(url, {
 *     idempotencyKey: "request-001",
 *   });
 *   const done = await client.waitForJob(receipt.job_id);
 *   const result = await client.getSummary(done.summary_id);
 *
 * Guarantees shared by every method:
 * - Only the configured API origin is contacted. Request paths are built from
 *   validated UUIDs, redirects are reported instead of followed, and URLs
 *   returned by the server (status_url, result_url, ...) are never fetched.
 * - The API token is kept in a private field, sent only as a Bearer header,
 *   and redacted from error messages and attached error details.
 * - JSON responses are capped at 8 MiB. Event streams are bounded per event
 *   to 256 KiB, with a single overall deadline and no automatic reconnect.
 *   Invalid response shapes raise TldwError with code INVALID_RESPONSE.
 * - Retries are bounded: at most 4 attempts, only for transient statuses
 *   (429, 502, 503, 504) and network failures. Account, quota and configuration
 *   error codes are final even with those statuses. A POST is retried only with the
 *   same body and Idempotency-Key, so the server replays the original result
 *   instead of creating a second job.
 * - Waiting never cancels server work. A wait timeout or an aborted signal
 *   stops local polling only; cancelJob() is the only way to stop a job.
 *
 * Errors are TldwError (or a subclass) for API, network and response
 * problems, and TypeError for invalid arguments, which are always rejected
 * before any request is sent. Type names in the JSDoc below (Job, Summary,
 * AnalysisAccepted, ...) refer to the declarations in index.d.ts.
 */
import { randomUUID } from "node:crypto";

// Canonical 8-4-4-4-12 hexadecimal UUID. Every resource ID is checked against
// this before it is placed in a request path.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every job status the API reports; any other value is an invalid response.
// completed, failed and canceled are terminal; the rest mean "keep polling".
const JOB_STATES = new Set([
  "queued",
  // Waiting for one of the plan's concurrent-job slots; not terminal.
  "queued_for_slot",
  "fetching_metadata",
  "fetching_transcript",
  "downloading_audio",
  "transcribing",
  "summarizing",
  "completed",
  "failed",
  "canceled",
]);
// Rate limiting and temporary gateway/upstream failures. These are retried
// with backoff; every other non-2xx status fails at once.
const TRANSIENT = new Set([429, 502, 503, 504]);
// These need account, quota or configuration changes even when a deployment
// reports them with 429/503. A short transport retry cannot resolve them.
const NON_RETRYABLE_CODES = new Set([
  "SPEND_LIMIT_REACHED",
  "ACCOUNT_UNAVAILABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SESSION_REQUIRED",
  "INSUFFICIENT_SCOPE",
  "TRIAL_PAUSED",
  "TRIAL_ACTIVATION_REQUIRED",
  "QUOTA_EXCEEDED",
  "SEARCH_QUOTA_EXCEEDED",
  "VIDEO_TOO_LONG",
  "ASR_REQUIRES_UPGRADE",
  "PLAN_FEATURE_REQUIRED",
  "MAX_CREDITS_EXCEEDED",
  "DURATION_LIMIT_EXCEEDED",
  "TRANSCRIPTION_NOT_ALLOWED",
  "CAPTIONS_UNAVAILABLE",
  "TRANSCRIPTION_NOT_CONFIGURED",
  "FEATURE_DISABLED",
  "SOURCE_NOT_CONFIGURED",
  "BILLING_CONFIGURATION_ERROR",
]);
// Largest response body the client buffers before rejecting the response.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// A stream is bounded per event rather than by its total lifetime.
const MAX_EVENT_BYTES = 256 * 1024;
const JOB_EVENTS = new Set([
  "snapshot",
  "status",
  "completed",
  "failed",
  "canceled",
]);
const MEDIA_TYPES = new Set(["auto", "text", "url", "youtube", "x"]);
const PUBLIC_READ_PATHS = new Set([
  "/v1/public/config",
  "/v1/public/security",
  "/v1/billing/catalog",
]);

/** Production API origin, used when neither `apiUrl` nor TLDW_API_URL is set. */
export const DEFAULT_API_URL = "https://api.tldw.sh";
/**
 * The API origin a new client uses by default: the TLDW_API_URL environment
 * variable when it is set and non-empty, otherwise {@link DEFAULT_API_URL}.
 * The value is validated by the TldwClient constructor, not here.
 *
 * @returns {string}
 */
export function defaultApiUrl() {
  return process.env.TLDW_API_URL || DEFAULT_API_URL;
}

/**
 * Base class for every error the client raises about the API, the network or
 * a response (invalid arguments raise TypeError instead).
 *
 * Fields:
 * - `code`: machine-readable code. API errors carry the server's code, for
 *   example QUOTA_EXCEEDED, RATE_LIMITED or TOKEN_SCOPE_REQUIRED. Client-side
 *   codes are CLIENT_ERROR, HTTP_ERROR (no API code, or a redirect),
 *   INVALID_RESPONSE, NETWORK_ERROR, WAIT_TIMEOUT, JOB_FAILED and CANCELED.
 * - `status`: HTTP status, or null when no response was received.
 * - `requestId`: the server's request ID (error.request_id or the
 *   X-Request-Id header), useful when contacting support.
 * - `retryAfterMs`: the parsed Retry-After header in milliseconds, or null.
 * - `jobId`: the job this error concerns: the job being submitted or waited
 *   on, or an existing job named by the API in `details.job_id` (for example
 *   with DUPLICATE_ACTIVE_JOB).
 * - `comparisonId`: retired; always null.
 * - `details`: the API's `error.details` object with the token redacted, for
 *   example `{ required_scope }` or `{ upgrade: { billing_url } }`.
 *
 * Methods also attach `idempotencyKey` to errors from submissions and
 * searches (replay with it when the outcome is unknown), and `receipt` to
 * errors raised by analyze()/extractTranscript() after the job was accepted.
 */
export class TldwError extends Error {
  /**
   * @param {string} message Human-readable description.
   * @param {object} [details] Any of the fields listed on the class.
   */
  constructor(
    message,
    {
      code = "CLIENT_ERROR",
      status = null,
      requestId = null,
      retryAfterMs = null,
      jobId = null,
      comparisonId = null,
      details = null,
    } = {},
  ) {
    super(message);
    this.name = "TldwError";
    Object.assign(this, {
      code,
      status,
      requestId,
      retryAfterMs,
      jobId,
      comparisonId,
      details,
    });
  }
}
/**
 * A local deadline passed (code WAIT_TIMEOUT): either a wait's `timeoutMs`
 * or a request's `requestTimeoutMs`. Work the server already accepted keeps
 * running; resume it with `waitForJob(error.jobId)`. When a submission timed
 * out before its response arrived, replay it with `error.idempotencyKey`.
 */
export class TldwTimeoutError extends TldwError {
  /**
   * @param {string} [message]
   * @param {object} [details] Extra TldwError fields; `code` defaults to
   *   WAIT_TIMEOUT.
   */
  constructor(
    message = "The wait ended. Accepted work continues on the server.",
    details = {},
  ) {
    super(message, { code: "WAIT_TIMEOUT", ...details });
    this.name = "TldwTimeoutError";
  }
}
/**
 * A job reached the `failed` or `canceled` state. The message and code come
 * from the job's `error` object when present; otherwise the code is CANCELED
 * or JOB_FAILED. `resource` holds the final job, with the token redacted.
 */
export class TldwJobError extends TldwError {
  /**
   * @param {Job} resource The terminal job.
   * @param {string} [kind] Always "job" today. Any other kind sets
   *   `comparisonId`, a field kept from the retired comparisons resource.
   */
  constructor(resource, kind = "job") {
    super(
      typeof resource.error?.message === "string"
        ? resource.error.message
        : `The ${kind} ${resource.status}.`,
      {
        code:
          typeof resource.error?.code === "string"
            ? resource.error.code
            : resource.status === "canceled"
              ? "CANCELED"
              : "JOB_FAILED",
        ...(kind === "job"
          ? { jobId: resource.id }
          : { comparisonId: resource.id }),
      },
    );
    this.name = "TldwJobError";
    this.resource = resource;
  }
}
// Validate an integer option within [min, max]. Invalid caller input always
// raises TypeError, so it is easy to tell apart from API failures.
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
  return value;
}
// Require a plain JSON object where the API contract promises one.
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TldwError(`Invalid ${label} response.`, {
      code: "INVALID_RESPONSE",
    });
  return value;
}
// Validate a resource ID and return it lowercased. Because request paths are
// built only from such IDs, no input can change a request's path or host.
function identifier(value, label = "ID") {
  if (typeof value !== "string" || !UUID.test(value))
    throw new TypeError(`${label} must be a UUID.`);
  return value.toLowerCase();
}
/**
 * Validate an API origin and report whether it is a loopback address.
 *
 * Accepts `https://host[:port]` with an optional trailing slash. Plain HTTP
 * is allowed only for localhost, 127.0.0.1 and [::1] (local development).
 * Credentials, a query, a fragment or any path are rejected, so the origin
 * can never carry a secret or point the token at another resource.
 *
 * @param {string} value
 * @returns {{ origin: string, loopback: boolean }} The normalized origin
 *   (scheme, host and port, no trailing slash) and whether it is loopback.
 * @throws {TypeError} When the value is not an acceptable origin.
 * @example
 * validateApiUrl("https://api.tldw.sh/");
 * // => { origin: "https://api.tldw.sh", loopback: false }
 */
export function validateApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      "apiUrl must be an absolute HTTPS URL, or HTTP loopback URL for local development.",
    );
  }
  // WHATWG URL keeps the brackets on IPv6 hostnames, hence "[::1]".
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  ) {
    throw new TypeError(
      "apiUrl must be an HTTPS origin without credentials, query, fragment or path; HTTP is allowed only on loopback.",
    );
  }
  return { origin: parsed.origin, loopback };
}
// Return the caller's idempotency key, or a fresh random UUID when omitted.
// The Idempotency-Key header accepts 1-128 printable ASCII characters
// without whitespace.
function key(value) {
  const result = value === undefined ? randomUUID() : value;
  if (typeof result !== "string" || !/^[\x21-\x7e]{1,128}$/.test(result))
    throw new TypeError(
      "idempotencyKey must contain 1–128 printable ASCII characters without whitespace.",
    );
  return result;
}
// Parse a Retry-After header, given either as delta-seconds or as an
// HTTP-date, into milliseconds capped at one hour. Returns null when the
// header is absent or unparseable.
function retryDelay(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(3_600_000, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(3_600_000, Math.max(0, date - Date.now()))
    : null;
}
// The error to throw when the caller's AbortSignal fires: the signal's own
// reason if it is an Error, otherwise an AbortError reminding the caller that
// aborting stops local waiting only.
function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "The wait was canceled. Accepted work continues on the server.",
        "AbortError",
      );
}
// Deep-copy a server-provided value, replacing every occurrence of the token
// in keys and strings with "[REDACTED]", so that errors (which callers tend
// to log) never leak the credential even if the server echoes it. Depth is
// capped to bound the work done on hostile input.
function safeErrorResource(resource, token) {
  if (!token) return resource;
  function redact(value, depth = 0) {
    if (depth > 100) return "[OMITTED]";
    if (typeof value === "string") return value.replaceAll(token, "[REDACTED]");
    if (Array.isArray(value))
      return value.map((item) => redact(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field.replaceAll(token, "[REDACTED]"),
          redact(item, depth + 1),
        ]),
      );
    return value;
  }
  return redact(resource);
}
// Abortable delay: resolves after `ms`, or rejects as soon as `signal` aborts.
// The listener is removed either way so long waits do not leak listeners.
async function sleep(ms, signal) {
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
// Read and parse a JSON response body without ever buffering more than
// MAX_BODY_BYTES. A declared Content-Length over the cap is refused before
// reading; otherwise the stream is counted chunk by chunk and canceled as
// soon as it exceeds the cap (Content-Length can be absent or wrong).
async function readJson(response, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) {
    if (signal) void response.body?.cancel().catch(() => {});
    else await response.body?.cancel();
    throw new TldwError("API response exceeded the client size limit.", {
      code: "INVALID_RESPONSE",
    });
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    const parts = [];
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      while (true) {
        const chunk = signal
          ? await abortable(reader.read(), signal)
          : await reader.read();
        if (signal?.aborted) throw abortError(signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          if (signal) void reader.cancel().catch(() => {});
          else await reader.cancel();
          throw new TldwError("API response exceeded the client size limit.", {
            code: "INVALID_RESPONSE",
          });
        }
        // stream: true keeps multi-byte characters split across chunks intact.
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      text = parts.join("");
    } finally {
      signal?.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  } else {
    // Fallback for fetch implementations whose Response has no stream body.
    text = signal
      ? await abortable(response.text(), signal)
      : await response.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES)
      throw new TldwError("API response exceeded the client size limit.", {
        code: "INVALID_RESPONSE",
      });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TldwError("API returned an invalid JSON response.", {
      code: "INVALID_RESPONSE",
      status: response.status,
    });
  }
}

// Parse bounded SSE frames incrementally, including split CRLF and UTF-8.
// The server emits complete JSON events; an incomplete final event is rejected.
function* eventFrames(state, text, final = false) {
  state.buffer += text;
  while (true) {
    const ending = state.buffer.search(/[\r\n]/);
    if (
      ending < 0 ||
      (!final &&
        ending === state.buffer.length - 1 &&
        state.buffer[ending] === "\r")
    )
      break;
    const width =
      state.buffer[ending] === "\r" && state.buffer[ending + 1] === "\n"
        ? 2
        : 1;
    const line = state.buffer.slice(0, ending);
    state.buffer = state.buffer.slice(ending + width);
    state.bytes += Buffer.byteLength(line) + width;
    if (state.bytes > MAX_EVENT_BYTES)
      throw new TldwError("Job event exceeded the client size limit.", {
        code: "INVALID_RESPONSE",
      });
    if (!line) {
      const frame = state.data.length
        ? { event: state.event, id: state.id, text: state.data.join("\n") }
        : null;
      state.bytes = 0;
      state.data = [];
      state.event = "message";
      state.id = null;
      if (frame) yield frame;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") state.data.push(value);
    else if (field === "event") state.event = value;
    else if (field === "id") {
      if (!/^[0-9]{1,64}$/.test(value) || !/[1-9]/.test(value))
        throw new TldwError("API returned an invalid job event ID.", {
          code: "INVALID_RESPONSE",
        });
      state.id = value;
    }
  }
  if (state.bytes + Buffer.byteLength(state.buffer) > MAX_EVENT_BYTES)
    throw new TldwError("Job event exceeded the client size limit.", {
      code: "INVALID_RESPONSE",
    });
  if (final && (state.buffer || state.data.length))
    throw new TldwError("API returned an incomplete job event.", {
      code: "INVALID_RESPONSE",
    });
}

// Aborting also bounds injected fetch/read implementations that ignore signals.
async function abortable(promise, signal) {
  if (signal.aborted) throw abortError(signal);
  let cancel;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        cancel = () => reject(abortError(signal));
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

/**
 * Validate the cost and transcription options shared by submissions and map
 * them to API body fields. Processing uses captions or saved source only.
 * Legacy transcription and forceAsr values are accepted but ignored by the server.
 *
 * @param {object} [options]
 * @param {"auto"|"never"|"if_needed"} [options.transcription] Deprecated
 *   compatibility field, accepted but ignored. Fresh audio is unavailable.
 * @param {number|string} [options.maxCredits] Credit ceiling for one job: a
 *   positive decimal up to 1,000,000 with at most two decimal places. It is
 *   sent as a string so no floating-point rounding reaches the server.
 * @param {boolean} [options.forceAsr] Deprecated compatibility field,
 *   accepted but ignored. Captions and saved source remain eligible for reuse.
 * @returns {{ transcription?: string, max_credits?: string, force_asr?: boolean }}
 * @throws {TypeError} On any invalid value.
 */
function spendingOptions({ transcription, maxCredits, forceAsr } = {}) {
  if (
    transcription !== undefined &&
    !["auto", "never", "if_needed"].includes(transcription)
  )
    throw new TypeError("transcription must be auto, never or if_needed.");
  if (forceAsr !== undefined && typeof forceAsr !== "boolean")
    throw new TypeError("forceAsr must be a boolean.");
  let cap;
  if (maxCredits !== undefined) {
    if (!["number", "string"].includes(typeof maxCredits))
      throw new TypeError(
        "maxCredits must be a positive decimal with at most two decimal places.",
      );
    // String() of a number such as 1e21 or 0.1 + 0.2 fails the pattern below,
    // so only exactly representable decimals are accepted.
    cap = String(maxCredits);
    if (
      !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(cap) ||
      Number(cap) <= 0 ||
      Number(cap) > 1_000_000
    )
      throw new TypeError(
        "maxCredits must be greater than zero, at most 1000000, with at most two decimal places.",
      );
  }
  return {
    ...(transcription !== undefined ? { transcription } : {}),
    ...(cap !== undefined ? { max_credits: cap } : {}),
    ...(forceAsr !== undefined ? { force_asr: forceAsr } : {}),
  };
}

/**
 * Client for the tldw.sh REST API.
 *
 * A key needs these scopes: `jobs:write` to submit work and search,
 * `jobs:read` to poll and list jobs, `summaries:read` to read summaries and
 * transcripts, and optionally `account:read` for getUsage(). Create keys in
 * the Developers page of the web app; the client never reads a token from
 * the environment by itself.
 *
 * @example
 * const client = new TldwClient({ token: process.env.TLDW_API_TOKEN });
 * const { summary } = await client.analyze(
 *   "https://www.youtube.com/watch?v=VIDEO_ID",
 *   { instructions: "List the key claims with timestamps.", maxCredits: 30 },
 * );
 */
export class TldwClient {
  #token;
  #fetch;
  #publicOnly;
  // First-poll guidance per accepted resource, keyed "kind:id": the earliest
  // time to poll (notBefore) and the minimum spacing between polls (interval).
  #pollHints = new Map();
  /**
   * @param {object} [options]
   * @param {string} [options.apiUrl] API origin; defaults to TLDW_API_URL,
   *   then https://api.tldw.sh. Validated by {@link validateApiUrl}.
   * @param {string} [options.token] Scoped API key, sent as a Bearer token.
   *   Required unless publicOnly is true or allowAnonymous is set for loopback.
   * @param {boolean} [options.allowAnonymous=false] Allow requests without a
   *   token; only takes effect on a loopback (local development) origin.
   * @param {boolean} [options.publicOnly=false] No-key client limited to the three
   *   public metadata GETs. Rejects tokens and every private operation.
   * @param {typeof fetch} [options.fetch] Fetch implementation, for example a
   *   test double; defaults to the global fetch.
   * @param {number} [options.requestTimeoutMs=30000] Budget in milliseconds
   *   (1-120000) for one API call, retries included. A wait uses its own,
   *   longer budget for each poll.
   * @throws {TypeError} When an option is invalid or the token is missing.
   */
  constructor({
    apiUrl = defaultApiUrl(),
    token,
    allowAnonymous = false,
    publicOnly = false,
    fetch: fetcher = globalThis.fetch,
    requestTimeoutMs = 30_000,
  } = {}) {
    const { origin, loopback } = validateApiUrl(apiUrl);
    if (typeof publicOnly !== "boolean")
      throw new TypeError("publicOnly must be a boolean.");
    if (publicOnly && token !== undefined)
      throw new TypeError("publicOnly clients do not accept a token.");
    if (!token && !publicOnly && !(allowAnonymous && loopback))
      throw new TypeError(
        "A tldw API token is required. Anonymous access is only available with explicit loopback development access.",
      );
    if (
      token !== undefined &&
      (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token))
    )
      throw new TypeError(
        "token must be a nonempty printable ASCII value without whitespace.",
      );
    if (typeof fetcher !== "function")
      throw new TypeError("A Fetch implementation is required.");
    // Read-only, enumerable public configuration. The token stays private.
    Object.defineProperty(this, "apiUrl", { value: origin, enumerable: true });
    Object.defineProperty(this, "requestTimeoutMs", {
      value: integer(requestTimeoutMs, "requestTimeoutMs", 1, 120_000),
      enumerable: true,
    });
    this.#token = token;
    this.#fetch = fetcher;
    this.#publicOnly = publicOnly;
  }
  #requireOperation(method, path, body) {
    if (
      this.#publicOnly &&
      (method !== "GET" || !PUBLIC_READ_PATHS.has(path) || body !== undefined)
    )
      throw new TldwError(
        "This public-only client cannot call private API operations. Create an authenticated client for account data or processing.",
        { code: "PUBLIC_READ_ONLY" },
      );
  }
  /**
   * Send one API request with bounded retries and return the parsed body.
   *
   * Retry policy (at most 4 attempts, all within `deadline`):
   * - 429/502/503/504: wait max(Retry-After, backoff) and try again, where
   *   the backoff is 0.5 s, 1 s, then 2 s.
   * - Network failure: back off the same way and try again. For a POST this
   *   resends the identical body and Idempotency-Key, which is safe.
   * - Per-attempt timeout: a GET is retried; any other method is not,
   *   because its outcome is unknown. The caller replays it with the same
   *   idempotency key.
   * - Redirects and every other non-2xx status fail at once.
   *
   * @param {string} method
   * @param {string} path Path and query, built from validated values only.
   * @param {object} [options]
   * @param {unknown} [options.body] JSON-serializable request body.
   * @param {AbortSignal} [options.signal] Aborts the request and any backoff.
   * @param {string} [options.idempotencyKey]
   * @param {number} [options.deadline] Absolute time (ms since the epoch)
   *   for the whole operation. Defaults to now + requestTimeoutMs; waits pass
   *   their own deadline so a slow poll can be retried within the wait.
   * @returns {Promise<{ data: object, retryAfterMs: number|null }>}
   * @throws {TldwError|TldwTimeoutError} Or the abort reason.
   */
  async #request(
    method,
    path,
    { body, signal, idempotencyKey, deadline } = {},
  ) {
    this.#requireOperation(method, path, body);
    // Paths are constructed exclusively from validated UUIDs; server-supplied URLs are never followed.
    const operationDeadline = deadline ?? Date.now() + this.requestTimeoutMs;
    // Serialize once: every retry must send byte-identical content.
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      const remaining = operationDeadline - Date.now();
      if (remaining <= 0) throw new TldwTimeoutError();
      // One controller per attempt, aborted either by the caller's signal
      // (relayed) or by this attempt's timer. `expired` tells the two apart.
      const controller = new AbortController();
      let expired = false;
      const relay = () => controller.abort(abortError(signal));
      signal?.addEventListener("abort", relay, { once: true });
      const timer = setTimeout(
        () => {
          expired = true;
          controller.abort();
        },
        Math.min(this.requestTimeoutMs, remaining),
      );
      let retry = null;
      try {
        const fetching = Promise.resolve(
          this.#fetch(this.apiUrl + path, {
            method,
            headers: {
              Accept: "application/json",
              ...(this.#token
                ? { Authorization: `Bearer ${this.#token}` }
                : {}),
              ...(body !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
              ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            },
            ...(payload !== undefined ? { body: payload } : {}),
            signal: controller.signal,
            // Never follow a redirect; report it instead of retrying it as a network failure.
            redirect: "manual",
            cache: "no-store",
            ...(this.#publicOnly ? { credentials: "omit" } : {}),
          }),
        );
        // A configured fetch can ignore abort; still honor the call's budget
        // and release a response that arrives after its caller has left.
        void fetching.then(
          (value) => {
            if (controller.signal.aborted && value?.body && !value.body.locked)
              void value.body.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await abortable(fetching, controller.signal);
        // Fetch in browsers reports a manual redirect as an opaque response
        // with status 0; Node reports the real 3xx status.
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        )
          throw new TldwError(
            `The API answered with a redirect (${response.status}); redirects are not followed. Check apiUrl.`,
            { status: response.status || null, code: "HTTP_ERROR" },
          );
        const retryAfterMs = retryDelay(response.headers.get("retry-after"));
        let data;
        try {
          data = await readJson(response, controller.signal);
        } catch (error) {
          // A proxy's 502/503 page is often HTML: keep retrying it rather
          // than failing on the parse error.
          if (response.ok || !TRANSIENT.has(response.status)) throw error;
          data = {};
        }
        if (!response.ok) {
          const detail = data?.error;
          // Recovery data such as the active job_id or required_scope.
          const extra =
            detail?.details &&
            typeof detail.details === "object" &&
            !Array.isArray(detail.details)
              ? safeErrorResource(detail.details, this.#token)
              : null;
          const redact = (value) =>
            typeof value === "string" && this.#token
              ? value.replaceAll(this.#token, "[REDACTED]")
              : value;
          const error = new TldwError(
            redact(
              typeof detail?.message === "string"
                ? detail.message
                : `API request failed (${response.status}).`,
            ),
            {
              status: response.status,
              code: redact(
                typeof detail?.code === "string" ? detail.code : "HTTP_ERROR",
              ),
              requestId: redact(
                typeof detail?.request_id === "string"
                  ? detail.request_id
                  : response.headers.get("x-request-id"),
              ),
              retryAfterMs,
              details: extra,
              jobId:
                typeof extra?.job_id === "string" && UUID.test(extra.job_id)
                  ? extra.job_id
                  : null,
            },
          );
          if (
            !TRANSIENT.has(response.status) ||
            NON_RETRYABLE_CODES.has(error.code) ||
            attempt === 3
          )
            throw error;
          lastError = error;
          retry = Math.max(
            retryAfterMs ?? 0,
            Math.min(10_000, 500 * 2 ** attempt),
          );
        } else {
          return { data: object(data, "JSON"), retryAfterMs };
        }
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        // API errors, redirects and invalid responses are final; only
        // transport failures and attempt timeouts reach the code below.
        if (error instanceof TldwError) throw error;
        // A POST is retried only with the exact body and a stable idempotency key.
        // A slow read (for example one poll inside a long wait) is retried while
        // the caller's deadline allows; it has no side effects.
        if (Date.now() >= operationDeadline || (expired && method !== "GET"))
          throw new TldwTimeoutError(
            method === "GET"
              ? "The API request timed out. Accepted work continues on the server."
              : "The API request timed out. Retry submission with the same idempotency key if its outcome is unknown.",
          );
        lastError = expired
          ? new TldwTimeoutError(
              "The API request timed out. Accepted work continues on the server.",
            )
          : new TldwError(
              "Could not reach the configured tldw API. Check the connection before retrying.",
              { code: "NETWORK_ERROR" },
            );
        if (attempt === 3) throw lastError;
        retry = Math.min(10_000, 500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relay);
      }
      // Never sleep past the deadline. Prefer the last API error (it has a
      // status and code the caller can act on) over a generic timeout.
      if (Date.now() + retry >= operationDeadline) {
        if (lastError?.status) throw lastError;
        throw new TldwTimeoutError();
      }
      await sleep(retry, signal);
    }
    // Unreachable: the final attempt always returns or throws above.
    throw lastError;
  }
  /**
   * Search X posts with video: one page of up to 20 results. A new search uses one of the plan's monthly searches; the count resets each billing period.
   *
   * Only X is searched, not YouTube, and there is no next page. The same
   * query and sort within 15 minutes, or a retry with the same idempotency
   * key, returns the saved results with `replayed: true` and does not count
   * again. Pass a result's `url` to submitAnalysis() or analyze() after
   * checking `video.over_plan_limit`. Result text is untrusted post content.
   * Requires the `jobs:write` scope.
   *
   * @param {string} query Search text; X operators such as `from:` work.
   * @param {object} [options]
   * @param {"top"|"latest"} [options.sort="top"]
   * @param {number} [options.limit=20] 1-20. Trims the page; it does not
   *   make the search cheaper.
   * @param {"x"} [options.platform="x"] The only supported platform.
   * @param {string} [options.idempotencyKey] Generated when omitted.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<VideoSearchResponse>}
   * @throws {TypeError} On invalid arguments.
   * @throws {TldwError} For example SEARCH_QUOTA_EXCEEDED (see
   *   `details.upgrade.billing_url`) or FEATURE_DISABLED. The error's
   *   `idempotencyKey` replays the same search.
   * @example
   * const { results, usage } = await client.searchVideos("rust async", {
   *   sort: "latest",
   *   limit: 5,
   * });
   */
  async searchVideos(
    query,
    { sort = "top", limit = 20, platform = "x", idempotencyKey, signal } = {},
  ) {
    if (typeof query !== "string" || !query.trim())
      throw new TypeError("query must be a non-empty string.");
    if (!["top", "latest"].includes(sort))
      throw new TypeError("sort must be top or latest.");
    if (platform !== "x") throw new TypeError("platform must be x.");
    integer(limit, "limit", 1, 20);
    // Retries resend this key, so the server replays a finished search instead of counting it again.
    const stableKey = key(idempotencyKey);
    try {
      const { data } = await this.#request("POST", "/v1/searches", {
        body: { query, platform, sort, limit },
        signal,
        idempotencyKey: stableKey,
      });
      if (
        typeof data.search_id !== "string" ||
        !Array.isArray(data.results) ||
        !data.results.every(
          (result) =>
            result &&
            typeof result === "object" &&
            typeof result.url === "string",
        ) ||
        !data.usage ||
        typeof data.usage !== "object" ||
        Array.isArray(data.usage)
      )
        throw new TldwError("API returned an invalid search.", {
          code: "INVALID_RESPONSE",
        });
      return data;
    } catch (error) {
      if (error && typeof error === "object") error.idempotencyKey = stableKey;
      throw error;
    }
  }
  /**
   * Submit media for analysis and return as soon as the job is accepted
   * (HTTP 202), without waiting for it to finish.
   *
   * Persist `receipt.job_id` before doing anything else: if the process
   * stops, resume with waitForJob(job_id) rather than submitting again. If
   * the outcome of the call itself is unknown (for example a timeout), call
   * again with the exact same media, options and idempotency key; the server
   * returns the original job (`replayed: true`) instead of starting another.
   *
   * @param {Media} media A YouTube or public X URL string; an
   *   explicit X source such as `{ type: "x", url, scope: "post" }`; or
   *   `{ type: "text", text }` for complete text you supply.
   * @param {object} [options]
   * @param {string} [options.instructions] Analysis focus, format or output
   *   language, for example "Summarize in Spanish."
   * @param {string} [options.idempotencyKey] Generated when omitted; read it
   *   back from `error.idempotencyKey` if the call fails.
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.refreshSource] Fetch current X post or Article
   *   content instead of reusing a snapshot saved within 24 hours. Does not
   *   force audio transcription.
   * @param {"auto"|"never"|"if_needed"} [options.transcription] Deprecated
   *   compatibility field, accepted but ignored. Processing uses captions or
   *   saved source only; fresh audio is unavailable.
   * @param {number|string} [options.maxCredits] Credit ceiling for this job.
   * @param {boolean} [options.forceAsr] Deprecated compatibility field, ignored.
   * @returns {Promise<AnalysisAccepted>} The receipt: `job_id`, the initial
   *   `job`, and polling hints.
   * @throws {TypeError} On invalid arguments (nothing is sent). Passing
   *   `preferredCaptionLanguages` is rejected: analyses do not support it.
   * @throws {TldwError} With `idempotencyKey` set, for example
   *   QUOTA_EXCEEDED, VIDEO_TOO_LONG or DUPLICATE_ACTIVE_JOB (see `jobId`).
   */
  async submitAnalysis(
    media,
    {
      instructions,
      idempotencyKey,
      signal,
      refreshSource,
      preferredCaptionLanguages,
      ...spending
    } = {},
  ) {
    if (refreshSource !== undefined && typeof refreshSource !== "boolean")
      throw new TypeError("refreshSource must be a boolean.");
    if (media == null) throw new TypeError("Provide media.");
    if (
      typeof media !== "string" &&
      (typeof media !== "object" ||
        Array.isArray(media) ||
        (media.type !== undefined && !MEDIA_TYPES.has(media.type)))
    )
      throw new TypeError(
        "Provide source text, a YouTube/public X URL, or a media object with type auto, text, url, youtube or x.",
      );
    if (preferredCaptionLanguages !== undefined)
      throw new TypeError(
        "preferredCaptionLanguages is unavailable for analysis submissions.",
      );
    // `spending` may also hold wait options (analyze() passes everything
    // through); spendingOptions reads only the cost fields.
    const limits = spendingOptions(spending);
    const stableKey = key(idempotencyKey);
    let data, retryAfterMs;
    try {
      ({ data, retryAfterMs } = await this.#request("POST", "/v1/analyses", {
        body: {
          media,
          ...(instructions !== undefined ? { instructions } : {}),
          ...(refreshSource !== undefined
            ? { refresh_source: refreshSource }
            : {}),
          ...limits,
        },
        signal,
        idempotencyKey: stableKey,
      }));
      if (typeof data.job_id !== "string" || !UUID.test(data.job_id))
        throw new TldwError("The API returned an invalid accepted job ID.", {
          code: "INVALID_RESPONSE",
        });
      object(data.job, "accepted job");
      if (data.job.id !== data.job_id)
        throw new TldwError("Accepted job IDs do not match.", {
          code: "INVALID_RESPONSE",
        });
      this.#job(data.job, data.job_id);
      this.#rememberPollHint(
        data.job_id,
        "job",
        data.next_poll_after_ms,
        retryAfterMs,
      );
      return data;
    } catch (error) {
      if (error && typeof error === "object") {
        error.idempotencyKey = stableKey;
        if (typeof data?.job_id === "string" && UUID.test(data.job_id)) {
          error.jobId = data.job_id;
          error.receipt = safeErrorResource(data, this.#token);
        }
      }
      throw error;
    }
  }
  // Remember the server's polling guidance (next_poll_after_ms and
  // Retry-After) for a just-accepted resource, so the next wait on it does
  // not poll earlier or more often than asked. The table is capped at 256
  // entries; Map iteration order makes the first key the oldest to evict.
  #rememberPollHint(id, kind, suggested, retryAfterMs) {
    const delay = Math.max(
      Number.isFinite(suggested) && suggested > 0
        ? Math.min(3_600_000, suggested)
        : 0,
      retryAfterMs ?? 0,
    );
    if (!delay) return;
    if (this.#pollHints.size >= 256)
      this.#pollHints.delete(this.#pollHints.keys().next().value);
    this.#pollHints.set(`${kind}:${id}`, {
      notBefore: Date.now() + delay,
      interval: delay,
    });
  }
  /**
   * Read a job's current state once, without waiting.
   *
   * @param {string} id Job UUID.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Job>}
   * @throws {TypeError} When `id` is not a UUID.
   * @throws {TldwError} For example a 404 for an unknown or foreign job.
   */
  async getJob(id, { signal } = {}) {
    id = identifier(id);
    const { data } = await this.#request("GET", `/v1/jobs/${id}`, { signal });
    return this.#job(data, id);
  }
  /** One bounded server wait (0-10 seconds); use waitForJob() to wait until terminal. */
  async waitJob(id, { waitSeconds = 8, includeResult = false, signal } = {}) {
    id = identifier(id);
    if (
      typeof waitSeconds !== "number" ||
      !Number.isFinite(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds > 10
    )
      throw new TypeError("waitSeconds must be between 0 and 10.");
    if (typeof includeResult !== "boolean")
      throw new TypeError("includeResult must be a boolean.");
    const { data, retryAfterMs } = await this.#request(
      "GET",
      `/v1/jobs/${id}/wait?wait_seconds=${waitSeconds}&include_result=${includeResult}`,
      { signal },
    );
    if (
      data.job_id !== id ||
      typeof data.terminal !== "boolean" ||
      typeof data.result_available !== "boolean"
    )
      throw new TldwError("API returned an invalid job receipt.", {
        code: "INVALID_RESPONSE",
        jobId: id,
      });
    this.#job(data.job, id);
    if (
      data.terminal !==
      ["completed", "failed", "canceled"].includes(data.job.status)
    )
      throw new TldwError("API returned an inconsistent job receipt.", {
        code: "INVALID_RESPONSE",
        jobId: id,
      });
    this.#rememberPollHint(id, "job", data.next_poll_after_ms, retryAfterMs);
    return data;
  }
  /**
   * Read one authenticated job-event stream. It never reconnects or starts work.
   * The overall deadline defaults to requestTimeoutMs; a longer stream may use
   * timeoutMs up to 610000 (the server closes each stream after ten minutes).
   * Breaking iteration or aborting closes only this local connection.
   *
   * @param {string} id Job UUID.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {AsyncIterableIterator<JobEvent>}
   */
  streamJobEvents(id, { signal, timeoutMs = this.requestTimeoutMs } = {}) {
    id = identifier(id);
    this.#requireOperation("GET", `/v1/jobs/${id}/events`);
    integer(timeoutMs, "timeoutMs", 1, 610_000);
    const state = { controller: new AbortController(), closing: false };
    const iterator = this.#jobEvents(id, signal, timeoutMs, state);
    // AsyncGenerator.return() alone queues behind a pending read. Abort first
    // so a caller can close an iterator even while next() is waiting for data.
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(value) {
        return iterator.next(value);
      },
      return(value) {
        state.closing = true;
        state.controller.abort();
        return iterator.return(value);
      },
      throw(error) {
        state.closing = true;
        state.controller.abort();
        return iterator.throw(error);
      },
    };
  }
  async *#jobEvents(id, signal, timeoutMs, state) {
    const { controller } = state;
    let expired = false;
    let reader;
    let response;
    const relay = () => controller.abort(abortError(signal));
    const cancelReader = () => {
      if (reader) void reader.cancel().catch(() => {});
    };
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener("abort", relay, { once: true });
    controller.signal.addEventListener("abort", cancelReader);
    const closeStream = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
      controller.signal.removeEventListener("abort", cancelReader);
      // An injected source's cancel promise must not extend our deadline.
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        reader = undefined;
      } else if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => {});
      }
    };
    try {
      if (signal?.aborted) throw abortError(signal);
      const fetching = Promise.resolve(
        this.#fetch(`${this.apiUrl}/v1/jobs/${id}/events`, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
          },
          signal: controller.signal,
          redirect: "manual",
          cache: "no-store",
        }),
      );
      // Clean up a late injected response even if its fetch ignored our abort.
      void fetching.then(
        (value) => {
          if (controller.signal.aborted && value?.body && !value.body.locked)
            void value.body.cancel().catch(() => {});
        },
        () => {},
      );
      response = await abortable(fetching, controller.signal);
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      )
        throw new TldwError(
          "The API answered with a redirect; redirects are not followed. Check apiUrl.",
          { code: "HTTP_ERROR", status: response.status || null, jobId: id },
        );
      if (!response.ok) {
        let data;
        try {
          data = await abortable(
            readJson(response, controller.signal),
            controller.signal,
          );
        } catch (error) {
          if (!(error instanceof TldwError)) throw error;
          data = {};
        }
        const detail = safeErrorResource(data?.error, this.#token);
        throw new TldwError(
          typeof detail?.message === "string"
            ? detail.message
            : `API request failed (${response.status}).`,
          {
            code: typeof detail?.code === "string" ? detail.code : "HTTP_ERROR",
            status: response.status,
            requestId:
              typeof detail?.request_id === "string"
                ? detail.request_id
                : safeErrorResource(
                    response.headers.get("x-request-id"),
                    this.#token,
                  ),
            retryAfterMs: retryDelay(response.headers.get("retry-after")),
            details:
              detail?.details &&
              typeof detail.details === "object" &&
              !Array.isArray(detail.details)
                ? detail.details
                : null,
            jobId: id,
          },
        );
      }
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "text/event-stream" ||
        !response.body?.getReader
      )
        throw new TldwError("API returned an invalid job event stream.", {
          code: "INVALID_RESPONSE",
          jobId: id,
        });
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parser = {
        buffer: "",
        bytes: 0,
        data: [],
        event: "message",
        id: null,
      };
      const decode = (chunk, final) => {
        try {
          return final
            ? decoder.decode()
            : decoder.decode(chunk, { stream: true });
        } catch {
          throw new TldwError("API returned invalid UTF-8 job events.", {
            code: "INVALID_RESPONSE",
            jobId: id,
          });
        }
      };
      const validate = (frame) => {
        if (!JOB_EVENTS.has(frame.event))
          throw new TldwError("API returned an unknown job event.", {
            code: "INVALID_RESPONSE",
            jobId: id,
          });
        let data;
        try {
          data = JSON.parse(frame.text);
        } catch {
          throw new TldwError("API returned an invalid JSON job event.", {
            code: "INVALID_RESPONSE",
            jobId: id,
          });
        }
        this.#job(data, id);
        const terminal = ["completed", "failed", "canceled"].includes(
          data.status,
        );
        if (
          (data.job_id !== undefined && data.job_id !== id) ||
          (frame.event === "status" && terminal) ||
          (frame.event !== "snapshot" &&
            frame.event !== "status" &&
            frame.event !== data.status)
        )
          throw new TldwError("API returned an inconsistent job event.", {
            code: "INVALID_RESPONSE",
            jobId: id,
          });
        return { event: frame.event, id: frame.id, data };
      };
      while (true) {
        const chunk = await abortable(reader.read(), controller.signal);
        // cancel() can resolve a read before the abort rejection wins the race.
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (chunk.done) {
          closeStream();
          for (const frame of eventFrames(
            parser,
            decode(undefined, true),
            true,
          ))
            yield validate(frame);
          return;
        }
        if (!(chunk.value instanceof Uint8Array))
          throw new TldwError("API returned invalid job event bytes.", {
            code: "INVALID_RESPONSE",
            jobId: id,
          });
        for (let start = 0; start < chunk.value.byteLength; start += 16_384) {
          for (const frame of eventFrames(
            parser,
            decode(chunk.value.subarray(start, start + 16_384), false),
          )) {
            if (controller.signal.aborted) throw abortError(controller.signal);
            const event = validate(frame);
            const terminal = ["completed", "failed", "canceled"].includes(
              event.data.status,
            );
            if (terminal) closeStream();
            yield event;
            if (terminal) return;
          }
        }
      }
    } catch (error) {
      if (state.closing) return;
      if (signal?.aborted) throw abortError(signal);
      if (expired)
        error = new TldwTimeoutError(
          "The job event stream timed out. Accepted work continues on the server.",
          { jobId: id },
        );
      if (error instanceof TldwError) {
        error.jobId ??= id;
        error.status ??= response?.status ?? null;
        error.requestId ??= safeErrorResource(
          response?.headers.get("x-request-id") ?? null,
          this.#token,
        );
        throw error;
      }
      throw new TldwError(
        "Could not read the configured tldw API job stream. Check the connection before retrying.",
        { code: "NETWORK_ERROR", jobId: id },
      );
    } finally {
      closeStream();
    }
  }
  /**
   * List your jobs, newest first, one page at a time. Listing never starts
   * or changes work.
   *
   * @param {object} [options]
   * @param {number} [options.limit=20] Page size, 1-100.
   * @param {string} [options.cursor] `next_cursor` from the previous page.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<JobList>} `items` and `next_cursor` (null on the last
   *   page).
   * @throws {TypeError|TldwError}
   * @example
   * let page = await client.listJobs({ limit: 50 });
   * while (page.next_cursor)
   *   page = await client.listJobs({ limit: 50, cursor: page.next_cursor });
   */
  async listJobs({ limit = 20, cursor, signal } = {}) {
    integer(limit, "limit", 1, 100);
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !cursor || cursor.length > 1000)
        throw new TypeError("cursor must be a bounded non-empty string.");
      query.set("cursor", cursor);
    }
    const { data } = await this.#request("GET", `/v1/jobs?${query}`, {
      signal,
    });
    if (
      !Array.isArray(data.items) ||
      (data.next_cursor !== null &&
        (typeof data.next_cursor !== "string" ||
          !data.next_cursor ||
          data.next_cursor.length > 1000))
    )
      throw new TldwError("API returned an invalid job list.", {
        code: "INVALID_RESPONSE",
      });
    for (const item of data.items) {
      if (!item || typeof item.id !== "string" || !UUID.test(item.id))
        throw new TldwError("API returned an invalid job list.", {
          code: "INVALID_RESPONSE",
        });
      this.#job(item, item.id);
    }
    return data;
  }
  /**
   * Explicitly stop an owned job; waiting or aborting a local wait never calls this.
   *
   * @param {string} id Job UUID.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<CancelResult>} The job's terminal state. It can be
   *   `completed` or `failed` when the job finished before the cancel.
   * @throws {TypeError|TldwError}
   */
  async cancelJob(id, { signal } = {}) {
    id = identifier(id);
    const { data } = await this.#request("POST", `/v1/jobs/${id}/cancel`, {
      signal,
    });
    if (
      data.id !== id ||
      !["completed", "failed", "canceled"].includes(data.status)
    )
      throw new TldwError("API returned an invalid cancellation result.", {
        code: "INVALID_RESPONSE",
        jobId: id,
      });
    return data;
  }
  // Validate a job object: the expected ID, a known status, an integer
  // progress from 0 to 100 and a known output mode. A completed job must
  // name its result: transcript_id for transcript-mode jobs, otherwise
  // summary_id.
  #job(data, id) {
    object(data, "job");
    if (
      data.id !== id ||
      !JOB_STATES.has(data.status) ||
      !Number.isInteger(data.progress) ||
      data.progress < 0 ||
      data.progress > 100 ||
      (data.output_mode !== undefined &&
        !["summary", "analysis", "transcript"].includes(data.output_mode))
    )
      throw new TldwError("API returned an invalid job.", {
        code: "INVALID_RESPONSE",
        jobId: id,
      });
    if (
      data.status === "completed" &&
      (typeof (data.output_mode === "transcript"
        ? data.transcript_id
        : data.summary_id) !== "string" ||
        !UUID.test(
          data.output_mode === "transcript"
            ? data.transcript_id
            : data.summary_id,
        ))
    )
      throw new TldwError(
        `Completed job has no valid ${data.output_mode === "transcript" ? "transcript" : "summary"} ID.`,
        {
          code: "INVALID_RESPONSE",
          jobId: id,
        },
      );
    return data;
  }
  /**
   * Read a generated summary or analysis. Reading a saved result again is
   * free.
   *
   * @template [TContent=Record<string, unknown>]
   * @param {string} id Summary UUID, usually `job.summary_id`.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Summary<TContent>>} The summary; its `content` object
   *   holds the generated output.
   * @throws {TypeError|TldwError}
   */
  async getSummary(id, { signal } = {}) {
    id = identifier(id);
    const { data } = await this.#request("GET", `/v1/summaries/${id}`, {
      signal,
    });
    if (
      data.id !== id ||
      !data.content ||
      typeof data.content !== "object" ||
      Array.isArray(data.content)
    )
      throw new TldwError("API returned an invalid summary.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  /** Read current public feature/configuration metadata; starts no processing. */
  async getPublicConfig({ signal } = {}) {
    const { data } = await this.#request("GET", "/v1/public/config", {
      signal,
    });
    return data;
  }
  /** Read current public enrollment/verification and Free allowance policy. */
  async getPublicSecurity({ signal } = {}) {
    const { data } = await this.#request("GET", "/v1/public/security", {
      signal,
    });
    return data;
  }
  /** Read the public plan/credit catalog, including published prices and offers. */
  async getBillingCatalog({ signal } = {}) {
    const { data } = await this.#request("GET", "/v1/billing/catalog", {
      signal,
    });
    return data;
  }
  /**
   * Read the account's plan, credit usage and limits (GET /v1/me). Requires
   * the `account:read` scope; the response is returned as-is.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Record<string, unknown>>}
   * @throws {TldwError} A 403 when the key lacks `account:read`.
   */
  async getUsage({ signal } = {}) {
    return (await this.#request("GET", "/v1/me", { signal })).data;
  }
  /**
   * Fetch saved source text separately; never follows URLs from a job/result.
   *
   * Returns the original source behind a summary, not generated text. Timed
   * video sources return `segments` (with `text` null); text and X sources
   * return `blocks` and `text`, and X caption blocks keep their timestamps.
   * Starts no processing. Requires `summaries:read`.
   *
   * @param {string} summaryId Summary UUID, usually `job.summary_id`.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<TranscriptContent>}
   * @throws {TypeError|TldwError}
   */
  async getTranscript(summaryId, { signal } = {}) {
    summaryId = identifier(summaryId);
    const { data } = await this.#request(
      "GET",
      `/v1/summaries/${summaryId}/transcript`,
      { signal },
    );
    return this.#transcript(data);
  }
  /** Read one bounded source page behind a summary; never starts processing. */
  async getTranscriptPage(summaryId, { offset = 0, limit = 100, signal } = {}) {
    summaryId = identifier(summaryId);
    integer(offset, "offset", 0, 1_000_000_000);
    integer(limit, "limit", 1, 500);
    const { data } = await this.#request(
      "GET",
      `/v1/summaries/${summaryId}/transcript/page?offset=${offset}&limit=${limit}`,
      { signal },
    );
    return this.#transcriptPage(data, offset, limit);
  }
  // Validate a transcript body. Timed (video) sources carry segments and a
  // null `text`; untimed (text and X) sources carry `text` and blocks.
  #transcript(data, expectedId) {
    object(data, "transcript");
    if (
      typeof data.transcript_id !== "string" ||
      !UUID.test(data.transcript_id) ||
      (expectedId !== undefined && data.transcript_id !== expectedId) ||
      typeof data.timed !== "boolean" ||
      typeof data.source !== "string" ||
      (data.language !== null && typeof data.language !== "string") ||
      !Array.isArray(data.segments) ||
      !Array.isArray(data.blocks) ||
      (data.timed ? data.text !== null : typeof data.text !== "string")
    )
      throw new TldwError("API returned an invalid transcript.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  #transcriptPage(data, offset, limit, expectedId) {
    this.#transcript(data, expectedId);
    const count = data.timed ? data.segments.length : data.blocks.length;
    const total = data.timed ? data.total_segments : data.total_blocks;
    const next = data.next_offset;
    if (
      !Number.isSafeInteger(data.total_segments) ||
      data.total_segments < 0 ||
      !Number.isSafeInteger(data.total_blocks) ||
      data.total_blocks < 0 ||
      count > limit ||
      count > Math.max(0, total - offset) ||
      (data.timed ? data.total_blocks !== 0 : data.total_segments !== 0) ||
      (data.timed ? data.blocks.length !== 0 : data.segments.length !== 0) ||
      (next === null
        ? offset + count < total
        : !Number.isSafeInteger(next) ||
          next !== offset + count ||
          next <= offset ||
          next >= total)
    )
      throw new TldwError("API returned an invalid transcript page.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  /**
   * List metadata of your saved source transcripts, most recently requested
   * first. Returns metadata only and never marks anything read. Follow
   * `next_cursor` with the same filters. Requires `summaries:read`.
   *
   * @param {object} [options]
   * @param {number} [options.limit=50] Page size, 1-100.
   * @param {string} [options.cursor] `next_cursor` from the previous page.
   * @param {string} [options.since] Inclusive ISO 8601 lower bound on the
   *   latest request time.
   * @param {string} [options.until] Exclusive ISO 8601 upper bound.
   * @param {boolean} [options.unreadOnly=false] Only transcripts not yet
   *   marked read.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<TranscriptList>}
   * @throws {TypeError|TldwError}
   */
  async listTranscripts({
    limit = 50,
    cursor,
    since,
    until,
    unreadOnly = false,
    signal,
  } = {}) {
    integer(limit, "limit", 1, 100);
    if (typeof unreadOnly !== "boolean")
      throw new TypeError("unreadOnly must be a boolean.");
    const query = new URLSearchParams({
      limit: String(limit),
      unread_only: String(unreadOnly),
    });
    for (const [name, value] of Object.entries({ cursor, since, until })) {
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        !value ||
        value.length > (name === "cursor" ? 1024 : 128)
      )
        throw new TypeError(`${name} must be a bounded non-empty string.`);
      query.set(name, value);
    }
    const { data } = await this.#request("GET", `/v1/transcripts?${query}`, {
      signal,
    });
    if (
      !Array.isArray(data.items) ||
      (data.next_cursor !== null && typeof data.next_cursor !== "string")
    )
      throw new TldwError("API returned an invalid transcript list.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  /**
   * Read a full saved source transcript by its transcript ID (from
   * listTranscripts() or `job.transcript_id`). Never marks it read.
   *
   * @param {string} transcriptId Transcript UUID.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<TranscriptContent>}
   * @throws {TypeError|TldwError}
   */
  async getSavedTranscript(transcriptId, { signal } = {}) {
    transcriptId = identifier(transcriptId);
    const { data } = await this.#request(
      "GET",
      `/v1/transcripts/${transcriptId}`,
      { signal },
    );
    return this.#transcript(data, transcriptId);
  }
  /**
   * Read a saved transcript's metadata (source video, counts, read state)
   * without loading its text, starting work or marking it read.
   *
   * @param {string} transcriptId Transcript UUID.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<SavedTranscript>}
   * @throws {TypeError|TldwError}
   */
  async getSavedTranscriptMetadata(transcriptId, { signal } = {}) {
    transcriptId = identifier(transcriptId);
    const { data } = await this.#request(
      "GET",
      `/v1/transcripts/${transcriptId}/metadata`,
      { signal },
    );
    if (
      data.id !== transcriptId ||
      typeof data.unread !== "boolean" ||
      !data.video ||
      typeof data.video.id !== "string"
    )
      throw new TldwError("API returned invalid transcript metadata.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  /**
   * Read one bounded page of a saved transcript, for sources too long to
   * load at once. Continue from `next_offset` until it is null. Never marks
   * the transcript read.
   *
   * @param {string} transcriptId Transcript UUID.
   * @param {object} [options]
   * @param {number} [options.offset=0] First segment or block to return.
   * @param {number} [options.limit=100] Items per page, 1-500.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<TranscriptPage>}
   * @throws {TypeError|TldwError}
   * @example
   * let offset = 0;
   * do {
   *   const page = await client.getSavedTranscriptPage(id, { offset });
   *   handle(page.segments, page.blocks);
   *   offset = page.next_offset;
   * } while (offset !== null);
   */
  async getSavedTranscriptPage(
    transcriptId,
    { offset = 0, limit = 100, signal } = {},
  ) {
    transcriptId = identifier(transcriptId);
    integer(offset, "offset", 0, 1_000_000_000);
    integer(limit, "limit", 1, 500);
    const { data } = await this.#request(
      "GET",
      `/v1/transcripts/${transcriptId}/page?offset=${offset}&limit=${limit}`,
      { signal },
    );
    return this.#transcriptPage(data, offset, limit, transcriptId);
  }
  /**
   * Mark a saved transcript read or unread. Repeating the same mark is
   * harmless.
   *
   * @param {string} transcriptId Transcript UUID.
   * @param {boolean} [read=true] false marks it unread again.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<TranscriptReadResult>}
   * @throws {TypeError|TldwError}
   */
  async markTranscriptRead(transcriptId, read = true, { signal } = {}) {
    transcriptId = identifier(transcriptId);
    if (typeof read !== "boolean")
      throw new TypeError("read must be a boolean.");
    const { data } = await this.#request(
      "PATCH",
      `/v1/transcripts/${transcriptId}/read`,
      { body: { read }, signal },
    );
    if (
      data.id !== transcriptId ||
      typeof data.unread !== "boolean" ||
      (data.read_at !== null && typeof data.read_at !== "string")
    )
      throw new TldwError("API returned an invalid transcript read state.", {
        code: "INVALID_RESPONSE",
      });
    return data;
  }
  /**
   * Poll a job until it completes, fails or is canceled.
   *
   * Polls are spaced at least `pollIntervalMs` apart; the server's
   * `next_poll_after_ms` and Retry-After can only lengthen the spacing.
   * Timing out or aborting ends the local wait only: the job keeps running
   * and can be resumed with another waitForJob() call.
   *
   * @param {string} id Job UUID.
   * @param {object} [options]
   * @param {number} [options.timeoutMs=180000] Total wait budget in
   *   milliseconds, 1-3600000.
   * @param {number} [options.pollIntervalMs=1500] Minimum time between
   *   polls, 250-30000 ms.
   * @param {AbortSignal} [options.signal] Stops waiting (not the job).
   * @param {(job: Job) => void | Promise<void>} [options.onProgress] Called
   *   with the job after every poll, terminal ones included, and awaited. An
   *   exception thrown here ends the wait.
   * @returns {Promise<Job>} The completed job.
   * @throws {TldwJobError} The job failed or was canceled.
   * @throws {TldwTimeoutError} The budget ran out first.
   * @throws {TypeError|TldwError} Every error carries `jobId`.
   * @example
   * const job = await client.waitForJob(jobId, {
   *   timeoutMs: 600_000,
   *   onProgress: (j) => console.error(j.status, j.progress),
   * });
   */
  async waitForJob(id, options = {}) {
    return this.#wait(identifier(id), "job", options);
  }
  async #wait(
    id,
    kind,
    { timeoutMs = 180_000, signal, onProgress, pollIntervalMs = 1500 } = {},
  ) {
    const deadline = Date.now() + integer(timeoutMs, "timeoutMs", 1, 3_600_000);
    integer(pollIntervalMs, "pollIntervalMs", 250, 30_000);
    if (onProgress !== undefined && typeof onProgress !== "function")
      throw new TypeError("onProgress must be a function.");
    const details = { jobId: id };
    try {
      // Honor the guidance from the submission before the first poll, and
      // never poll faster than the interval the server asked for.
      const remembered = this.#pollHints.get(`${kind}:${id}`);
      if (remembered) {
        pollIntervalMs = Math.max(pollIntervalMs, remembered.interval);
        const delay = Math.max(0, remembered.notBefore - Date.now());
        if (Date.now() + delay >= deadline) throw new TldwTimeoutError();
        if (delay) await sleep(delay, signal);
      }
      while (true) {
        if (Date.now() >= deadline) throw new TldwTimeoutError();
        // Each poll may use the rest of the wait's budget, so a slow GET is
        // retried inside the wait instead of failing at requestTimeoutMs.
        const { data, retryAfterMs } = await this.#request(
          "GET",
          `/v1/jobs/${id}`,
          { signal, deadline },
        );
        const resource = this.#job(data, id);
        if (onProgress) await onProgress(resource);
        if (resource.status === "completed") {
          this.#pollHints.delete(`${kind}:${id}`);
          return resource;
        }
        if (["failed", "canceled"].includes(resource.status)) {
          this.#pollHints.delete(`${kind}:${id}`);
          throw new TldwJobError(
            safeErrorResource(resource, this.#token),
            kind,
          );
        }
        const suggested = resource.next_poll_after_ms;
        const interval = Math.max(
          pollIntervalMs,
          retryAfterMs ?? 0,
          Number.isFinite(suggested) && suggested > 0
            ? Math.min(3_600_000, suggested)
            : 0,
        );
        // Fail now rather than sleep past the deadline for a poll that
        // could not happen in time.
        if (Date.now() + interval >= deadline) throw new TldwTimeoutError();
        await sleep(interval, signal);
      }
    } catch (error) {
      // Tag every failure, abort reasons included, with the job ID so the
      // caller can resume.
      if (error && typeof error === "object") Object.assign(error, details);
      throw error;
    }
  }
  /**
   * Submit media, wait for the job and read its summary in one call.
   *
   * Wait options are validated before submitting, so a bad option never
   * creates a job. If anything fails after the job was accepted, the error
   * carries `jobId` and a redacted `receipt`: resume with
   * waitForJob(error.jobId) instead of submitting again.
   *
   * @template [TContent=Record<string, unknown>]
   * @param {Media} media See submitAnalysis().
   * @param {object} [options] Every submitAnalysis() option plus the
   *   waitForJob() options `timeoutMs`, `pollIntervalMs` and `onProgress`.
   * @returns {Promise<{ receipt: AnalysisAccepted, job: Job, summary: Summary<TContent> }>}
   * @throws {TypeError|TldwError|TldwJobError|TldwTimeoutError}
   * @example
   * try {
   *   const { summary } = await client.analyze(url, { maxCredits: 30 });
   *   console.log(summary.content);
   * } catch (error) {
   *   if (error instanceof TldwTimeoutError && error.jobId)
   *     console.error("Still running; resume job", error.jobId);
   *   else throw error;
   * }
   */
  async analyze(media, options = {}) {
    integer(options.timeoutMs ?? 180_000, "timeoutMs", 1, 3_600_000);
    integer(options.pollIntervalMs ?? 1500, "pollIntervalMs", 250, 30_000);
    if (
      options.onProgress !== undefined &&
      typeof options.onProgress !== "function"
    )
      throw new TypeError("onProgress must be a function.");
    const receipt = await this.submitAnalysis(media, options);
    try {
      const job = await this.waitForJob(receipt.job_id, options);
      if (job.output_mode === "transcript")
        throw new TldwError(
          "Expected an analysis result, received a transcript job.",
          { code: "INVALID_RESPONSE" },
        );
      const summary = await this.getSummary(job.summary_id, options);
      return { receipt, job, summary };
    } catch (error) {
      if (error && typeof error === "object") {
        error.jobId = receipt.job_id;
        error.receipt = safeErrorResource(receipt, this.#token);
      }
      throw error;
    }
  }
  /**
   * Analyze once, wait, then read the saved original transcript instead of
   * the generated summary.
   *
   * This is a normal analysis submission and uses normal processing
   * credits; the summary is saved too and can be read later with
   * getSummary(job.summary_id). Caption language preferences are not
   * supported and are rejected before submitting. Failure handling matches
   * analyze(): errors after acceptance carry `jobId` and `receipt`.
   *
   * @param {Media} media See submitAnalysis().
   * @param {object} [options] submitAnalysis() and waitForJob() options.
   * @returns {Promise<{ receipt: AnalysisAccepted, job: Job, transcript: TranscriptContent }>}
   * @throws {TypeError|TldwError|TldwJobError|TldwTimeoutError}
   */
  async extractTranscript(media, options = {}) {
    if (options.preferredCaptionLanguages !== undefined)
      throw new TypeError(
        "preferredCaptionLanguages is unavailable for analysis submissions.",
      );
    integer(options.timeoutMs ?? 180_000, "timeoutMs", 1, 3_600_000);
    integer(options.pollIntervalMs ?? 1500, "pollIntervalMs", 250, 30_000);
    const paged = options.offset !== undefined || options.limit !== undefined;
    if (paged) {
      integer(
        options.offset === undefined ? 0 : options.offset,
        "offset",
        0,
        1_000_000_000,
      );
      integer(
        options.limit === undefined ? 100 : options.limit,
        "limit",
        1,
        500,
      );
    }
    if (
      options.onProgress !== undefined &&
      typeof options.onProgress !== "function"
    )
      throw new TypeError("onProgress must be a function.");
    const receipt = await this.submitAnalysis(media, options);
    try {
      const job = await this.waitForJob(receipt.job_id, options);
      if (job.output_mode === "transcript")
        throw new TldwError(
          "Expected an analysis result, received a transcript job.",
          {
            code: "INVALID_RESPONSE",
          },
        );
      const transcript = paged
        ? await this.getTranscriptPage(job.summary_id, options)
        : await this.getTranscript(job.summary_id, options);
      return { receipt, job, transcript };
    } catch (error) {
      if (error && typeof error === "object") {
        error.jobId = receipt.job_id;
        error.receipt = safeErrorResource(receipt, this.#token);
      }
      throw error;
    }
  }
}

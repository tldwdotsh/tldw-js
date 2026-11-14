import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_STATES = new Set([
  "queued",
  "fetching_metadata",
  "fetching_transcript",
  "downloading_audio",
  "transcribing",
  "summarizing",
  "completed",
  "failed",
  "canceled",
]);
const COMPARISON_STATES = new Set([
  "queued",
  "waiting",
  "processing",
  "completed",
  "failed",
  "canceled",
]);
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class TldwError extends Error {
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
export class TldwTimeoutError extends TldwError {
  constructor(
    message = "The wait ended. Accepted work continues on the server.",
    details = {},
  ) {
    super(message, { code: "WAIT_TIMEOUT", ...details });
    this.name = "TldwTimeoutError";
  }
}
export class TldwJobError extends TldwError {
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
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
  return value;
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TldwError(`Invalid ${label} response.`, {
      code: "INVALID_RESPONSE",
    });
  return value;
}
function identifier(value, label = "ID") {
  if (typeof value !== "string" || !UUID.test(value))
    throw new TypeError(`${label} must be a UUID.`);
  return value.toLowerCase();
}
export function validateApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      "apiUrl must be an absolute HTTPS URL, or HTTP loopback URL for local development.",
    );
  }
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
function key(value) {
  const result = value === undefined ? randomUUID() : value;
  if (typeof result !== "string" || !/^[\x21-\x7e]{1,128}$/.test(result))
    throw new TypeError(
      "idempotencyKey must contain 1–128 printable ASCII characters without whitespace.",
    );
  return result;
}
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
function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "The wait was canceled. Accepted work continues on the server.",
        "AbortError",
      );
}
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
async function readJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
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
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new TldwError("API response exceeded the client size limit.", {
            code: "INVALID_RESPONSE",
          });
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      text = parts.join("");
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
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

/** A scoped-key client. Constructor values are explicit; credentials are never read or logged automatically. */
function spendingOptions({ transcription, maxCredits, forceAsr } = {}) {
  if (
    transcription !== undefined &&
    !["never", "if_needed"].includes(transcription)
  )
    throw new TypeError("transcription must be never or if_needed.");
  if (forceAsr !== undefined && typeof forceAsr !== "boolean")
    throw new TypeError("forceAsr must be a boolean.");
  if (forceAsr && transcription !== "if_needed")
    throw new TypeError("forceAsr requires explicit transcription=if_needed.");
  let cap;
  if (maxCredits !== undefined) {
    if (!["number", "string"].includes(typeof maxCredits))
      throw new TypeError(
        "maxCredits must be a positive decimal with at most two decimal places.",
      );
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

export class TldwClient {
  #token;
  #fetch;
  #pollHints = new Map();
  constructor({
    apiUrl,
    token,
    allowAnonymous = false,
    fetch: fetcher = globalThis.fetch,
    requestTimeoutMs = 30_000,
  } = {}) {
    const { origin, loopback } = validateApiUrl(apiUrl);
    if (!token && !(allowAnonymous && loopback))
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
    Object.defineProperty(this, "apiUrl", { value: origin, enumerable: true });
    Object.defineProperty(this, "requestTimeoutMs", {
      value: integer(requestTimeoutMs, "requestTimeoutMs", 1, 120_000),
      enumerable: true,
    });
    this.#token = token;
    this.#fetch = fetcher;
  }
  async #request(
    method,
    path,
    { body, signal, idempotencyKey, deadline } = {},
  ) {
    // Paths are constructed exclusively from validated UUIDs; server-supplied URLs are never followed.
    const operationDeadline = deadline ?? Date.now() + this.requestTimeoutMs;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      const remaining = operationDeadline - Date.now();
      if (remaining <= 0) throw new TldwTimeoutError();
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
        const response = await this.#fetch(this.apiUrl + path, {
          method,
          headers: {
            Accept: "application/json",
            ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
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
        });
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
          data = await readJson(response);
        } catch (error) {
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
          if (!TRANSIENT.has(response.status) || attempt === 3) throw error;
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
      if (Date.now() + retry >= operationDeadline) {
        if (lastError?.status) throw lastError;
        throw new TldwTimeoutError();
      }
      await sleep(retry, signal);
    }
    throw lastError;
  }
  async submitAnalysis(media, options = {}) {
    return this.#submitMedia("/v1/analyses", media, options);
  }
  /** Extract original source only; no summary or LLM work is requested. */
  async submitTranscript(media, options = {}) {
    if (options.instructions !== undefined)
      throw new TypeError(
        "Transcript extraction does not accept analysis instructions.",
      );
    return this.#submitMedia("/v1/transcripts", media, options);
  }
  async #submitMedia(
    path,
    media,
    {
      instructions,
      idempotencyKey,
      signal,
      refreshSource,
      uploadId,
      preferredCaptionLanguages,
      ...spending
    } = {},
  ) {
    if (refreshSource !== undefined && typeof refreshSource !== "boolean")
      throw new TypeError("refreshSource must be a boolean.");
    if (path === "/v1/transcripts") {
      if ((media != null) === (uploadId !== undefined))
        throw new TypeError("Provide exactly one media or uploadId.");
      if (uploadId !== undefined) uploadId = identifier(uploadId, "Upload ID");
      if (
        preferredCaptionLanguages !== undefined &&
        (!Array.isArray(preferredCaptionLanguages) ||
          preferredCaptionLanguages.length > 10 ||
          preferredCaptionLanguages.some(
            (value) =>
              typeof value !== "string" ||
              !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value),
          ))
      )
        throw new TypeError(
          "preferredCaptionLanguages must contain at most 10 BCP-47 language tags.",
        );
    }
    const limits = spendingOptions(spending);
    const stableKey = key(idempotencyKey);
    let data, retryAfterMs;
    try {
      ({ data, retryAfterMs } = await this.#request("POST", path, {
        body: {
          ...(path === "/v1/transcripts" && uploadId !== undefined
            ? { upload_id: uploadId }
            : { media }),
          ...(path === "/v1/transcripts" &&
          preferredCaptionLanguages !== undefined
            ? { preferred_caption_languages: preferredCaptionLanguages }
            : {}),
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
      if (
        path === "/v1/transcripts" &&
        (data.output_mode !== "transcript" ||
          data.job.output_mode !== "transcript")
      )
        throw new TldwError("API returned a non-transcript extraction job.", {
          code: "INVALID_RESPONSE",
        });
      this.#rememberPollHint(
        data.job_id,
        "job",
        data.next_poll_after_ms,
        retryAfterMs,
      );
      return data;
    } catch (error) {
      if (error && typeof error === "object") error.idempotencyKey = stableKey;
      throw error;
    }
  }
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
  async getJob(id, { signal } = {}) {
    id = identifier(id);
    const { data } = await this.#request("GET", `/v1/jobs/${id}`, { signal });
    return this.#job(data, id);
  }
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
  async getUsage({ signal } = {}) {
    return (await this.#request("GET", "/v1/me", { signal })).data;
  }
  /** Fetch saved source text separately; never follows URLs from a job/result. */
  async getTranscript(summaryId, { signal } = {}) {
    summaryId = identifier(summaryId);
    const { data } = await this.#request(
      "GET",
      `/v1/summaries/${summaryId}/transcript`,
      { signal },
    );
    return this.#transcript(data);
  }
  #transcript(data) {
    object(data, "transcript");
    if (
      typeof data.transcript_id !== "string" ||
      !UUID.test(data.transcript_id) ||
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
  async getSavedTranscript(transcriptId, { signal } = {}) {
    transcriptId = identifier(transcriptId);
    const { data } = await this.#request(
      "GET",
      `/v1/transcripts/${transcriptId}`,
      { signal },
    );
    return this.#transcript(data);
  }
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
    return this.#transcript(data);
  }
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
    const details = kind === "job" ? { jobId: id } : { comparisonId: id };
    try {
      const remembered = this.#pollHints.get(`${kind}:${id}`);
      if (remembered) {
        pollIntervalMs = Math.max(pollIntervalMs, remembered.interval);
        const delay = Math.max(0, remembered.notBefore - Date.now());
        if (Date.now() + delay >= deadline) throw new TldwTimeoutError();
        if (delay) await sleep(delay, signal);
      }
      while (true) {
        if (Date.now() >= deadline) throw new TldwTimeoutError();
        const { data, retryAfterMs } = await this.#request(
          "GET",
          `/v1/${kind === "job" ? "jobs" : "comparisons"}/${id}`,
          { signal, deadline },
        );
        const resource =
          kind === "job" ? this.#job(data, id) : this.#comparison(data, id);
        if (onProgress) await onProgress(resource);
        if (resource.status === "completed") {
          this.#pollHints.delete(`${kind}:${id}`);
          if (kind === "comparison" && !resource.result)
            throw new TldwError(
              "The comparison completed but result access is unavailable; summaries:read is required.",
              { code: "RESULT_SCOPE_REQUIRED", comparisonId: id },
            );
          if (kind === "comparison")
            object(resource.result, "comparison result");
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
        if (Date.now() + interval >= deadline) throw new TldwTimeoutError();
        await sleep(interval, signal);
      }
    } catch (error) {
      if (error && typeof error === "object") Object.assign(error, details);
      throw error;
    }
  }
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
  async extractTranscript(media, options = {}) {
    integer(options.timeoutMs ?? 180_000, "timeoutMs", 1, 3_600_000);
    integer(options.pollIntervalMs ?? 1500, "pollIntervalMs", 250, 30_000);
    if (
      options.onProgress !== undefined &&
      typeof options.onProgress !== "function"
    )
      throw new TypeError("onProgress must be a function.");
    const receipt = await this.submitTranscript(media, options);
    try {
      const job = await this.waitForJob(receipt.job_id, options);
      if (job.output_mode !== "transcript")
        throw new TldwError("Expected a transcript extraction result.", {
          code: "INVALID_RESPONSE",
        });
      const transcript = await this.getSavedTranscript(
        job.transcript_id,
        options,
      );
      return { receipt, job, transcript };
    } catch (error) {
      if (error && typeof error === "object") {
        error.jobId = receipt.job_id;
        error.receipt = safeErrorResource(receipt, this.#token);
      }
      throw error;
    }
  }
  async compareTikToks(
    urls,
    { instructions, idempotencyKey, signal, ...spending } = {},
  ) {
    if (!Array.isArray(urls) || urls.length < 2 || urls.length > 20)
      throw new TypeError("Supply between 2 and 20 TikTok URLs.");
    const stableKey = key(idempotencyKey);
    const limits = spendingOptions(spending);
    let data, retryAfterMs;
    try {
      ({ data, retryAfterMs } = await this.#request("POST", "/v1/comparisons", {
        body: {
          urls,
          ...(instructions !== undefined ? { instructions } : {}),
          ...limits,
        },
        signal,
        idempotencyKey: stableKey,
      }));
      const id = data.comparison?.id;
      if (typeof id !== "string" || !UUID.test(id))
        throw new TldwError("The API returned an invalid comparison ID.", {
          code: "INVALID_RESPONSE",
        });
      this.#rememberPollHint(
        id,
        "comparison",
        data.comparison.next_poll_after_ms,
        retryAfterMs,
      );
      return this.#comparison(data, id);
    } catch (error) {
      if (error && typeof error === "object") error.idempotencyKey = stableKey;
      throw error;
    }
  }
  #comparison(data, id) {
    const resource = object(data.comparison, "comparison");
    if (resource.id !== id || !COMPARISON_STATES.has(resource.status))
      throw new TldwError("API returned an invalid comparison.", {
        code: "INVALID_RESPONSE",
        comparisonId: id,
      });
    return resource;
  }
  async getComparison(id, { signal } = {}) {
    id = identifier(id);
    const { data } = await this.#request("GET", `/v1/comparisons/${id}`, {
      signal,
    });
    return this.#comparison(data, id);
  }
  async waitForComparison(id, options = {}) {
    return this.#wait(identifier(id), "comparison", options);
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TldwClient,
  TldwError,
  TldwTimeoutError,
  TldwJobError,
} from "../src/index.mjs";

const jobId = "00000000-0000-4000-8000-000000000101";
const summaryId = "00000000-0000-4000-8000-000000000102";
const token = "tldw_fixture_not_a_real_secret";
const transcriptId = "00000000-0000-4000-8000-000000000104";
const job = (status = "queued", extra = {}) => ({
  id: jobId,
  status,
  progress: status === "completed" ? 100 : 20,
  summary_id: status === "completed" ? summaryId : null,
  ...extra,
});
const receipt = () => ({
  job_id: jobId,
  job: job(),
  status_url: "https://evil.invalid/capture",
  result_url: "https://evil.invalid/capture",
});
const response = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
function make(fetch, options = {}) {
  return new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch,
    ...options,
  });
}

test("fetches saved transcripts separately, including timed video and X source blocks", async () => {
  for (const timed of [true, false]) {
    const source = {
      transcript_id: transcriptId,
      language: "en",
      source: "platform_auto",
      timed,
      segments: timed ? [{ start_ms: 0, end_ms: 1000, text: "Hello." }] : [],
      blocks: timed
        ? []
        : [
            {
              id: "caption-1",
              label: "Video captions",
              text: "Hello.",
              start_s: 0,
              end_s: 1,
            },
          ],
      text: timed ? null : "Hello.",
    };
    const client = make(async (url, init) => {
      assert.equal(
        url,
        `https://api.example.test/v1/summaries/${summaryId}/transcript`,
      );
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.redirect, "manual");
      return response(source);
    });
    assert.deepEqual(await client.getTranscript(summaryId), source);
  }
});

test("transcript helpers reject URL IDs and malformed success envelopes", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return response({ transcript_id: transcriptId });
  });
  await assert.rejects(
    client.getTranscript("https://evil.invalid/steal"),
    TypeError,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    client.getTranscript(summaryId),
    (e) => e.code === "INVALID_RESPONSE",
  );
});

test("transcript authorization failures remain errors rather than source text", async () => {
  const client = make(async () =>
    response({ error: { code: "TOKEN_SCOPE_REQUIRED" } }, 403),
  );
  await assert.rejects(
    client.getTranscript(summaryId),
    (e) => e.code === "TOKEN_SCOPE_REQUIRED" && e.status === 403,
  );
});

test("accepts only origins and requires an explicit local-only anonymous mode", () => {
  for (const apiUrl of [
    "http://example.test",
    "https://name:password@example.test",
    "https://example.test/path",
    "https://example.test?token=x",
    "https://example.test#x",
    "file:///tmp/app",
    "http://localhost.evil.test",
  ]) {
    assert.throws(() => new TldwClient({ apiUrl, token }), TypeError);
  }
  assert.throws(
    () =>
      new TldwClient({
        apiUrl: "https://api.example.test",
        allowAnonymous: true,
      }),
    TypeError,
  );
  assert.throws(
    () => new TldwClient({ apiUrl: "http://localhost:8000" }),
    TypeError,
  );
  assert.doesNotThrow(
    () =>
      new TldwClient({ apiUrl: "http://localhost:8000", allowAnonymous: true }),
  );
  assert.throws(
    () => make(async () => {}, { token: "key\r\nInjected: header" }),
    TypeError,
  );
});
test("uses exact async request contract and does not follow receipt URLs", async () => {
  const calls = [];
  const client = make(async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === "POST") return response(receipt(), 202);
    if (url.endsWith(`/jobs/${jobId}`)) return response(job("completed"));
    return response({
      id: summaryId,
      content: { answer: "Source-cited answer" },
    });
  });
  const out = await client.analyze("A complete source", {
    instructions: "Extract claims",
    idempotencyKey: "stable-analysis-1",
  });
  assert.equal(out.summary.content.answer, "Source-cited answer");
  assert.deepEqual(JSON.parse(calls[0].body), {
    media: "A complete source",
    instructions: "Extract claims",
  });
  assert.equal(calls[0].headers["Idempotency-Key"], "stable-analysis-1");
  assert.equal(calls[0].headers.Authorization, `Bearer ${token}`);
  assert.ok(
    calls.every(
      (call) =>
        call.url.startsWith("https://api.example.test/v1/") &&
        call.redirect === "manual",
    ),
  );
  assert.equal(JSON.stringify(client).includes(token), false);
});
test("retried POST has stable body and idempotency key", async () => {
  const calls = [];
  const source = { type: "text", text: "original" };
  const client = make(async (_url, init) => {
    calls.push(init);
    if (calls.length === 1) {
      source.text = "changed externally";
      return response(
        { error: { code: "RATE_LIMITED", message: "Slow down" } },
        429,
        {
          "Retry-After": "0",
        },
      );
    }
    return response(receipt(), 202);
  });
  await client.submitAnalysis(source);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(
    calls[0].headers["Idempotency-Key"],
    calls[1].headers["Idempotency-Key"],
  );
});
test("a Retry-After outside the retry budget preserves actionable rate-limit metadata", async () => {
  let calls = 0;
  const client = make(
    async () => {
      calls++;
      return response({ error: { code: "RATE_LIMITED" } }, 429, {
        "Retry-After": "60",
      });
    },
    { requestTimeoutMs: 10 },
  );
  await assert.rejects(
    client.submitAnalysis("source", { idempotencyKey: "resume-me" }),
    (error) =>
      error.status === 429 &&
      error.retryAfterMs === 60_000 &&
      error.idempotencyKey === "resume-me",
  );
  assert.equal(calls, 1);
});
test("a waiter remembers submission polling hints without extra early GETs", async () => {
  const calls = [];
  const client = make(async (_url, init) => {
    calls.push(init.method);
    return response({ ...receipt(), next_poll_after_ms: 3000 }, 202);
  });
  const accepted = await client.submitAnalysis("source");
  await assert.rejects(
    client.waitForJob(accepted.job_id, { timeoutMs: 10 }),
    (error) => error instanceof TldwTimeoutError && error.jobId === jobId,
  );
  assert.deepEqual(calls, ["POST"]);
});
test("invalid wait options never submit paid work", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return response(receipt(), 202);
  });
  await assert.rejects(client.analyze("source", { timeoutMs: -1 }), TypeError);
  await assert.rejects(
    client.analyze("source", { onProgress: "invalid" }),
    TypeError,
  );
  assert.equal(calls, 0);
});
test("HTTP failures preserve safe code, reference and retry metadata without echoing tokens", async () => {
  const client = make(async () =>
    response(
      {
        error: {
          code: "SCOPE_REQUIRED",
          message: `Missing scope ${token}`,
          request_id: "request-123",
        },
      },
      403,
    ),
  );
  await assert.rejects(
    client.getUsage(),
    (error) =>
      error instanceof TldwError &&
      error.status === 403 &&
      error.code === "SCOPE_REQUIRED" &&
      error.requestId === "request-123" &&
      !error.message.includes(token),
  );
});
test("polling follows real progress and fetches output only after completion", async () => {
  let polls = 0;
  const seen = [];
  const client = make(async () =>
    response(job(++polls === 1 ? "summarizing" : "completed")),
  );
  const done = await client.waitForJob(jobId, {
    pollIntervalMs: 250,
    onProgress: (value) => seen.push(value.status),
  });
  assert.equal(done.summary_id, summaryId);
  assert.deepEqual(seen, ["summarizing", "completed"]);
});
test("a job queued for a concurrency slot is not terminal; the wait continues", async () => {
  let polls = 0;
  const seen = [];
  const client = make(async () =>
    response(
      ++polls === 1
        ? job("queued_for_slot", { queue_position: 1, max_concurrent_jobs: 1 })
        : job("completed"),
    ),
  );
  const done = await client.waitForJob(jobId, {
    pollIntervalMs: 250,
    onProgress: (value) => seen.push(value.status),
  });
  assert.equal(done.summary_id, summaryId);
  assert.deepEqual(seen, ["queued_for_slot", "completed"]);
  assert.equal((await make(async () => response(job("queued_for_slot"))).getJob(jobId)).status, "queued_for_slot");
});
test("wait honors Retry-After and server next_poll_after_ms without excessive polling", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return response(job("queued", { next_poll_after_ms: 3000 }), 200, {
      "Retry-After": "10",
    });
  });
  await assert.rejects(
    client.waitForJob(jobId, { timeoutMs: 50, pollIntervalMs: 250 }),
    (error) => error instanceof TldwTimeoutError && error.jobId === jobId,
  );
  assert.equal(calls, 1);
});
test("failed and canceled jobs remain terminal and carry the durable ID", async () => {
  for (const status of ["failed", "canceled"]) {
    const client = make(async () =>
      response(
        job(status, {
          error: { code: "SOURCE_UNAVAILABLE", message: "Source was removed" },
        }),
      ),
    );
    await assert.rejects(
      client.waitForJob(jobId),
      (error) =>
        error instanceof TldwJobError &&
        error.jobId === jobId &&
        error.code === "SOURCE_UNAVAILABLE",
    );
  }
});
test("terminal errors redact a reflected API key", async () => {
  const client = make(async () =>
    response(
      job("failed", {
        error: { code: "SOURCE_UNAVAILABLE", message: `Debug ${token}` },
      }),
    ),
  );
  await assert.rejects(
    client.waitForJob(jobId),
    (error) =>
      !error.message.includes(token) &&
      !JSON.stringify(error.resource).includes(token),
  );
});
test("aborting the waiter never sends a cancellation or another submission", async () => {
  const controller = new AbortController();
  const calls = [];
  const client = make(async (url, init) => {
    calls.push({ url, method: init.method });
    return response(job());
  });
  await assert.rejects(
    client.waitForJob(jobId, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    (error) => error.name === "AbortError" && error.jobId === jobId,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
  );
});
test("a timed-out convenience call retains its accepted receipt", async () => {
  const client = make(async (_url, init) =>
    response(
      init.method === "POST" ? receipt() : job(),
      init.method === "POST" ? 202 : 200,
    ),
  );
  await assert.rejects(
    client.analyze("source", { timeoutMs: 5 }),
    (error) =>
      error instanceof TldwTimeoutError &&
      error.jobId === jobId &&
      error.receipt.job_id === jobId,
  );
});
test("a malformed completed job cannot fetch arbitrary paths", async () => {
  const calls = [];
  const client = make(async (url) => {
    calls.push(url);
    return response(
      job("completed", { summary_id: "https://evil.invalid/secret" }),
    );
  });
  await assert.rejects(
    client.waitForJob(jobId),
    (error) => error.code === "INVALID_RESPONSE",
  );
  await assert.rejects(client.getJob("../admin"), TypeError);
  assert.equal(calls.length, 1);
});
test("client exposes no comparison methods", () => {
  const client = make(async () => response({}));
  for (const name of ["compareTikToks", "getComparison", "waitForComparison"])
    assert.equal(name in client, false, name);
});
test("oversized and non-JSON API output fails safely", async () => {
  const huge = make(
    async () =>
      new Response("{}", { headers: { "Content-Length": "9000000" } }),
  );
  await assert.rejects(
    huge.getUsage(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  const invalid = make(async () => new Response("not json"));
  await assert.rejects(
    invalid.getUsage(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("spending permission and decimal ceiling reach REST without implicit ASR consent", async () => {
  const bodies = [];
  const client = make(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response(receipt(), 202);
  });
  await client.submitAnalysis("source", {
    transcription: "if_needed",
    maxCredits: "12.30",
    forceAsr: true,
  });
  assert.deepEqual(bodies[0], {
    media: "source",
    transcription: "if_needed",
    max_credits: "12.30",
    force_asr: true,
  });
  for (const maxCredits of [0, -1, NaN, Infinity, "1.001", "1000000.01", true])
    await assert.rejects(
      client.submitAnalysis("source", { maxCredits }),
      TypeError,
    );
  await assert.rejects(
    client.submitAnalysis("source", { forceAsr: true }),
    TypeError,
  );
  await assert.rejects(
    client.submitAnalysis("source", { transcription: "auto" }),
    TypeError,
  );
  assert.equal(
    bodies.length,
    1,
    "invalid limits must not submit processing work",
  );
});

test("omitted transcription caps reach the authenticated server without an account lookup", async () => {
  const calls = [];
  const client = make(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return response(receipt(), 202);
  });
  await client.submitAnalysis("source", { transcription: "if_needed" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v1/analyses"));
  assert.deepEqual(calls[0].body, {
    media: "source",
    transcription: "if_needed",
  });
});
test("ordinary account missing-cap policy errors remain actionable and are not retried", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return response(
      {
        error: {
          code: "TRANSCRIPTION_NOT_ALLOWED",
          message: "A credit ceiling is required.",
        },
      },
      422,
    );
  });
  await assert.rejects(
    client.submitAnalysis("source", { transcription: "if_needed" }),
    (error) =>
      error.code === "TRANSCRIPTION_NOT_ALLOWED" && error.status === 422,
  );
  assert.equal(calls, 1);
});

test("API error details are exposed, redacted, and give the active job ID", async () => {
  const activeId = "00000000-0000-4000-8000-000000000199";
  const client = make(async () =>
    response(
      {
        error: {
          code: "DUPLICATE_ACTIVE_JOB",
          message: "That video is already processing.",
          details: { job_id: activeId, note: `seen ${token}` },
        },
      },
      409,
    ),
  );
  const error = await client
    .submitAnalysis("A complete source")
    .catch((e) => e);
  assert.ok(error instanceof TldwError);
  assert.equal(error.code, "DUPLICATE_ACTIVE_JOB");
  assert.equal(error.jobId, activeId);
  assert.deepEqual(error.details, {
    job_id: activeId,
    note: "seen [REDACTED]",
  });
});

test("one slow poll does not end a longer wait", async () => {
  let calls = 0;
  const client = make(
    async (url, init) => {
      calls++;
      if (calls === 1)
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        );
      return response(job("completed"));
    },
    { requestTimeoutMs: 50 },
  );
  const done = await client.waitForJob(jobId, { timeoutMs: 5000 });
  assert.equal(done.status, "completed");
  assert.ok(calls >= 2);
});

test("redirects are reported at once and never followed or retried", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { Location: "https://elsewhere.example/v1/" },
    });
  });
  const error = await client.getSummary(summaryId).catch((e) => e);
  assert.ok(error instanceof TldwError);
  assert.equal(error.code, "HTTP_ERROR");
  assert.equal(error.status, 302);
  assert.equal(calls, 1);
});

test("a malformed accepted job ID is an INVALID_RESPONSE error", async () => {
  const client = make(async () =>
    response({ ...receipt(), job_id: "../../admin" }, 202),
  );
  const error = await client
    .submitAnalysis("A complete source")
    .catch((e) => e);
  assert.ok(error instanceof TldwError);
  assert.equal(error.code, "INVALID_RESPONSE");
});

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
  assert.equal(
    (await make(async () => response(job("queued_for_slot"))).getJob(jobId))
      .status,
    "queued_for_slot",
  );
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
  for (const name of ["getComparison", "waitForComparison"])
    assert.equal(name in client, false, name);
});
test("only supported explicit media types are admitted before POST", async () => {
  const bodies = [];
  const client = make(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response(receipt(), 202);
  });
  for (const media of [
    42,
    true,
    [],
    { type: "legacy", url: "https://youtu.be/dQw4w9WgXcQ" },
    { type: ["x"] },
  ])
    await assert.rejects(client.submitAnalysis(media), TypeError);
  assert.equal(bodies.length, 0);
  for (const media of [
    "A complete supplied source",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://x.com/example/status/1234567890",
    { type: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" },
    {
      type: "x",
      url: "https://x.com/example/status/1234567890",
      scope: "article",
    },
    { type: "text", text: "A complete supplied source" },
  ]) {
    await client.submitAnalysis(media);
    assert.deepEqual(bodies.at(-1).media, media);
  }
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

test("default and auto analysis never add fresh-ASR permission, including when a cap is supplied", async () => {
  const bodies = [];
  const media = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const client = make(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response(receipt(), 202);
  });
  await client.submitAnalysis(media);
  await client.submitAnalysis(media, { transcription: "auto" });
  await client.submitAnalysis(media, { maxCredits: "30.00" });
  await client.submitAnalysis(media, { transcription: "never" });
  assert.deepEqual(bodies, [
    { media },
    { media, transcription: "auto" },
    { media, max_credits: "30.00" },
    { media, transcription: "never" },
  ]);
});

test("missing captions remain structured and nonretryable rather than authorizing fresh ASR", async () => {
  const details = { platform: "youtube", reason: "captions_unavailable" };
  for (const status of [422, 503]) {
    const bodies = [];
    const client = make(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response(
        {
          error: {
            code: "CAPTIONS_UNAVAILABLE",
            message: "No accessible captions were found.",
            details,
          },
        },
        status,
      );
    });
    await assert.rejects(
      client.submitAnalysis("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        maxCredits: "30.00",
      }),
      (error) => {
        assert(error instanceof TldwError);
        assert.equal(error.code, "CAPTIONS_UNAVAILABLE");
        assert.equal(error.status, status);
        assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].transcription, undefined);
    assert.equal(bodies[0].force_asr, undefined);
  }
});

test("accepted caption-only jobs fail once with their source error and never create an ASR replacement", async () => {
  for (const operation of ["analyze", "extractTranscript"]) {
    const calls = [];
    const client = make(async (url, init) => {
      calls.push({ url, init });
      if (init.method === "POST") return response(receipt(), 202);
      return response(
        job("failed", {
          error: {
            code: "CAPTIONS_UNAVAILABLE",
            message: "No accessible captions were found.",
            details: { platform: "youtube", reason: "captions_unavailable" },
          },
        }),
      );
    });
    await assert.rejects(
      client[operation]("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      (error) => {
        assert(error instanceof TldwJobError);
        assert.equal(error.code, "CAPTIONS_UNAVAILABLE");
        assert.equal(error.jobId, jobId);
        assert.equal(error.receipt.job_id, jobId);
        assert.equal(
          error.resource.error.details.reason,
          "captions_unavailable",
        );
        return true;
      },
    );
    assert.deepEqual(
      calls.map(({ init }) => init.method),
      ["POST", "GET"],
    );
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      media: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.equal(calls[1].url, `https://api.example.test/v1/jobs/${jobId}`);
  }
});

test("deprecated audio fields remain compatible while decimal ceilings are enforced", async () => {
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
  await client.submitAnalysis("source", { forceAsr: true });
  assert.deepEqual(bodies[1], { media: "source", force_asr: true });
  await client.submitAnalysis("source", {
    transcription: "never",
    forceAsr: true,
  });
  assert.deepEqual(bodies[2], {
    media: "source",
    transcription: "never",
    force_asr: true,
  });
  await client.submitAnalysis("source", { transcription: "auto" });
  assert.deepEqual(bodies[3], { media: "source", transcription: "auto" });
  await assert.rejects(
    client.submitAnalysis("source", { transcription: "sometimes" }),
    TypeError,
  );
  assert.equal(
    bodies.length,
    4,
    "invalid limits must not submit processing work",
  );
});

test("deprecated if_needed forwards without an account lookup or artificial cap requirement", async () => {
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
test("normal credit-ceiling errors remain actionable and are not retried", async () => {
  let calls = 0;
  const client = make(async () => {
    calls++;
    return response(
      {
        error: {
          code: "MAX_CREDITS_EXCEEDED",
          message: "The source exceeds the credit ceiling.",
        },
      },
      422,
    );
  });
  await assert.rejects(
    client.submitAnalysis("source", { maxCredits: "1.00" }),
    (error) => error.code === "MAX_CREDITS_EXCEEDED" && error.status === 422,
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

test(
  "a fetch ignoring abort cannot exceed a submission deadline or lose its replay key",
  { timeout: 1000 },
  async () => {
    let calls = 0;
    let resolveFetch;
    let canceled = false;
    const client = make(
      () => {
        calls++;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
      { requestTimeoutMs: 10 },
    );
    await assert.rejects(
      client.submitAnalysis("source", { idempotencyKey: "same-intent" }),
      (error) =>
        error instanceof TldwTimeoutError &&
        error.idempotencyKey === "same-intent",
    );
    assert.equal(calls, 1);
    resolveFetch(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(canceled, true);
  },
);

test(
  "a stalled JSON stream and its cancel promise cannot exceed the request deadline",
  { timeout: 1000 },
  async () => {
    let canceled = false;
    const client = make(
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              canceled = true;
              return new Promise(() => {});
            },
          }),
        ),
      { requestTimeoutMs: 10 },
    );
    await assert.rejects(client.getUsage(), TldwTimeoutError);
    assert.equal(canceled, true);
  },
);

test(
  "a JSON text fallback ignoring abort still honors the request deadline",
  { timeout: 1000 },
  async () => {
    const client = make(
      async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => new Promise(() => {}),
      }),
      { requestTimeoutMs: 10 },
    );
    await assert.rejects(client.getUsage(), TldwTimeoutError);
  },
);

test(
  "caller cancellation bounds a fetch ignoring abort without retrying",
  { timeout: 1000 },
  async () => {
    let calls = 0;
    const client = make(() => {
      calls++;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const pending = client.getUsage({ signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(calls, 1);
  },
);

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

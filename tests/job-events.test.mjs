import assert from "node:assert/strict";
import { test } from "node:test";
import { TldwClient, TldwError, TldwTimeoutError } from "../src/index.mjs";

const jobId = "00000000-0000-4000-8000-000000000101";
const summaryId = "00000000-0000-4000-8000-000000000102";
const otherId = "00000000-0000-4000-8000-000000000103";
const token = "tldw_stream_fixture_not_a_real_secret";
const encoder = new TextEncoder();
const job = (status = "queued", extra = {}) => ({
  id: jobId,
  job_id: jobId,
  status,
  progress: status === "completed" ? 100 : 20,
  summary_id: status === "completed" ? summaryId : null,
  ...extra,
});
const frame = (event = "snapshot", data = job(), id, ending = "\n") =>
  `${id === undefined ? "" : `id: ${id}${ending}`}event: ${event}${ending}data: ${JSON.stringify(data)}${ending}${ending}`;

function fixture(
  text = "",
  { fragment = 4096, finish = false, ...options } = {},
) {
  const bytes = encoder.encode(text);
  const state = { canceled: false, calls: [] };
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += fragment)
        controller.enqueue(bytes.subarray(offset, offset + fragment));
      if (finish) controller.close();
    },
    cancel() {
      state.canceled = true;
    },
  });
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async (url, init) => {
      state.calls.push({ url, ...init });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    ...options,
  });
  return { client, state };
}

test("one owned stream parses fragmented UTF-8, CRLF, heartbeats and terminal events", async () => {
  const { client, state } = fixture(
    "\ufeff: ready\r\n\r\n" +
      frame(
        "snapshot",
        job("queued", { detail: "🧠 saved source" }),
        undefined,
        "\r\n",
      ) +
      ": ping\r\n\r\n" +
      frame("status", job("summarizing"), "12", "\r") +
      frame(
        "completed",
        job("completed", { result_url: "https://evil.invalid/steal" }),
        "13",
      ) +
      "unread after terminal",
    { fragment: 1 },
  );
  const events = [];
  for await (const event of client.streamJobEvents(jobId.toUpperCase()))
    events.push(event);
  assert.deepEqual(
    events.map(({ event, id }) => [event, id]),
    [
      ["snapshot", null],
      ["status", "12"],
      ["completed", "13"],
    ],
  );
  assert.equal(events[0].data.detail, "🧠 saved source");
  assert.equal(state.canceled, true);
  assert.equal(state.calls.length, 1);
  assert.equal(
    state.calls[0].url,
    `https://api.example.test/v1/jobs/${jobId}/events`,
  );
  assert.equal(state.calls[0].method, "GET");
  assert.equal(state.calls[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(state.calls[0].headers.Accept, "text/event-stream");
  assert.equal(state.calls[0].redirect, "manual");
});

test("multiline JSON and clean disconnect yield once without reconnecting", async () => {
  const text =
    "retry: 10\nunknown: ignored\nevent: snapshot\n" +
    JSON.stringify(job(), null, 2)
      .split("\n")
      .map((line) => `data: ${line}\n`)
      .join("") +
    "\n";
  const { client, state } = fixture(text, { finish: true });
  const events = [];
  for await (const event of client.streamJobEvents(jobId)) events.push(event);
  assert.deepEqual(events[0].data, job());
  assert.equal(events.length, 1);
  assert.equal(state.calls.length, 1);
});

test("terminal snapshot releases the connection before returning the event", async () => {
  const { client, state } = fixture(frame("snapshot", job("completed")));
  const events = client.streamJobEvents(jobId);
  assert.equal((await events.next()).value.data.status, "completed");
  assert.equal(state.canceled, true);
  await events.return();
});

test("a final lone CR closes the exhausted source before terminal delivery", async () => {
  let fetchSignal;
  const bytes = encoder.encode(
    frame("snapshot", job("completed"), undefined, "\r"),
  );
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async (_url, init) => {
      fetchSignal = init.signal;
      return new Response(bytes, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const events = client.streamJobEvents(jobId);
  assert.equal((await events.next()).value.data.status, "completed");
  assert.equal(fetchSignal.aborted, true);
  await events.return();
});

test("an injected cancel promise cannot hold terminal delivery past its deadline", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame("snapshot", job("completed"))));
    },
    cancel() {
      canceled = true;
      return new Promise(() => {});
    },
  });
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const iterator = client.streamJobEvents(jobId, { timeoutMs: 100 });
  assert.equal((await iterator.next()).value.data.status, "completed");
  assert.equal(canceled, true);
  await iterator.return();
});

test("return interrupts an already pending next and releases the connection", async () => {
  const { client, state } = fixture(frame());
  const events = client.streamJobEvents(jobId);
  await events.next();
  const pending = events.next();
  const closing = events.return();
  assert.equal((await pending).done, true);
  assert.equal((await closing).done, true);
  assert.equal(state.canceled, true);
  assert.equal(state.calls.length, 1);
});

test("abort and a single overall deadline close pending reads without retries", async () => {
  const signal = new AbortController();
  const first = fixture(frame());
  const events = first.client.streamJobEvents(jobId, { signal: signal.signal });
  await events.next();
  const pending = events.next();
  signal.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(first.state.canceled, true);
  assert.equal(first.state.calls.length, 1);
  const second = fixture();
  await assert.rejects(
    second.client.streamJobEvents(jobId, { timeoutMs: 5 }).next(),
    TldwTimeoutError,
  );
  assert.equal(second.state.canceled, true);
  assert.equal(second.state.calls.length, 1);
});

test("invalid or oversized event data is rejected and the connection is released", async () => {
  for (const text of [
    "event: snapshot\ndata: not-json\n\n",
    "event: snapshot\ndata: {}",
    frame("snapshot", job("queued", { id: otherId })),
    frame("snapshot", job("queued", { job_id: otherId })),
    frame("snapshot", job("queued", { progress: true })),
    frame("status", job("completed")),
    frame("failed", job("summarizing")),
    frame("unexpected"),
    frame("snapshot", job(), "0"),
    frame("snapshot", job(), "bad"),
    "data: " + "x".repeat(256 * 1024) + "\n\n",
    "event: snapshot\n" +
      "data: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(8000),
  ]) {
    const { client, state } = fixture(text, { finish: text.endsWith("{}") });
    await assert.rejects(
      client.streamJobEvents(jobId).next(),
      (error) => error.code === "INVALID_RESPONSE" && error.jobId === jobId,
    );
    // Closed EOF streams do not invoke an underlying cancel callback.
    if (!text.endsWith("{}")) assert.equal(state.canceled, true);
    assert.equal(state.calls.length, 1);
  }
});

test("API refusals preserve error metadata and redact credentials without reconnecting", async () => {
  let calls = 0;
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            code: "SPEND_LIMIT_REACHED",
            message: "limit " + token,
            details: { echoed: token },
          },
        }),
        {
          status: 503,
          headers: { "Retry-After": "12", "X-Request-Id": "request-1" },
        },
      );
    },
  });
  await assert.rejects(client.streamJobEvents(jobId).next(), (error) => {
    assert.ok(error instanceof TldwError);
    assert.equal(error.code, "SPEND_LIMIT_REACHED");
    assert.equal(error.status, 503);
    assert.equal(error.requestId, "request-1");
    assert.equal(error.retryAfterMs, 12_000);
    assert.equal(error.jobId, jobId);
    assert.equal(
      (String(error) + JSON.stringify(error.details)).includes(token),
      false,
    );
    return true;
  });
  assert.equal(calls, 1);
});

test("a stalled HTTP error body is canceled within the stream deadline", async () => {
  let canceled = false;
  const body = new ReadableStream({
    cancel() {
      canceled = true;
      return new Promise(() => {});
    },
  });
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async () => new Response(body, { status: 503 }),
  });
  await assert.rejects(
    client.streamJobEvents(jobId, { timeoutMs: 5 }).next(),
    (error) => error instanceof TldwTimeoutError && error.status === 503,
  );
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test("invalid arguments send no request and redirects are refused", async () => {
  let calls = 0;
  const client = new TldwClient({
    apiUrl: "https://api.example.test",
    token,
    fetch: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.invalid/steal" },
      });
    },
  });
  assert.throws(
    () => client.streamJobEvents("https://evil.invalid/steal"),
    TypeError,
  );
  for (const timeoutMs of [0, null, true, Infinity, 610001])
    assert.throws(
      () => client.streamJobEvents(jobId, { timeoutMs }),
      TypeError,
    );
  assert.equal(calls, 0);
  await assert.rejects(
    client.streamJobEvents(jobId).next(),
    (error) => error.code === "HTTP_ERROR" && error.status === 302,
  );
  assert.equal(calls, 1);
});

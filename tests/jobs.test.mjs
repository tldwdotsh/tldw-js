import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_API_URL, defaultApiUrl, TldwClient } from "../src/index.mjs";

const id = "00000000-0000-4000-8000-000000000101";
const job = { id, status: "queued", progress: 0, summary_id: null };
const apiUrl = "https://api.example.test";
const response = (value, status = 200) => Response.json(value, { status });

test("production origin defaults and explicit overrides never source credentials automatically", () => {
  const before = {
    url: process.env.TLDW_API_URL,
    token: process.env.TLDW_API_TOKEN,
  };
  try {
    delete process.env.TLDW_API_URL;
    process.env.TLDW_API_TOKEN = "private-env-sentinel";
    assert.equal(defaultApiUrl(), DEFAULT_API_URL);
    assert.equal(new TldwClient({ token: "explicit" }).apiUrl, DEFAULT_API_URL);
    assert.throws(() => new TldwClient(), TypeError);
    process.env.TLDW_API_URL = apiUrl;
    assert.equal(new TldwClient({ token: "explicit" }).apiUrl, apiUrl);
    assert.equal(
      new TldwClient({
        token: "explicit",
        apiUrl: "https://other.example.test",
      }).apiUrl,
      "https://other.example.test",
    );
  } finally {
    for (const [key, value] of [
      ["TLDW_API_URL", before.url],
      ["TLDW_API_TOKEN", before.token],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("job listing is an owned bounded page and treats cursors as opaque query data", async () => {
  const calls = [];
  const sdk = new TldwClient({
    apiUrl,
    token: "explicit",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ items: [job], next_cursor: "next+/=" });
    },
  });
  const page = await sdk.listJobs({
    limit: 7,
    cursor: "opaque+/=?&cursor=other",
  });
  assert.deepEqual(page.items, [job]);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, apiUrl + "/v1/jobs");
  assert.equal(url.searchParams.get("limit"), "7");
  assert.equal(url.searchParams.get("cursor"), "opaque+/=?&cursor=other");
  assert.equal(calls[0].init.headers.Authorization, "Bearer explicit");
  assert.equal(calls[0].init.method, "GET");
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { limit: true },
    { cursor: "" },
    { cursor: "x".repeat(1025) },
  ])
    await assert.rejects(sdk.listJobs(options), TypeError);
  assert.equal(calls.length, 1);
});

test("malformed job pages do not escape response validation", async () => {
  for (const page of [
    null,
    [],
    { items: [], next_cursor: [] },
    { items: [], next_cursor: "" },
    { items: [{}], next_cursor: null },
    { items: [{ ...job, status: "unknown" }], next_cursor: null },
    { items: [job] },
  ]) {
    const sdk = new TldwClient({
      apiUrl,
      token: "explicit",
      fetch: async () => response(page),
    });
    await assert.rejects(
      sdk.listJobs(),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
});

test("explicit cancellation accepts terminal races and never follows a returned URL", async () => {
  const calls = [];
  let status = "canceled";
  const sdk = new TldwClient({
    apiUrl,
    token: "explicit",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ id, status });
    },
  });
  for (status of ["canceled", "completed", "failed"]) {
    assert.equal((await sdk.cancelJob(id)).status, status);
    assert.equal(calls.at(-1).url, `${apiUrl}/v1/jobs/${id}/cancel`);
    assert.equal(calls.at(-1).init.method, "POST");
    assert.equal(calls.at(-1).init.body, undefined);
  }
  await assert.rejects(
    sdk.cancelJob("https://untrusted.invalid/job"),
    TypeError,
  );
  assert.equal(calls.length, 3);
  status = "queued";
  await assert.rejects(
    sdk.cancelJob(id),
    (error) => error.code === "INVALID_RESPONSE" && error.jobId === id,
  );
});

test("cancel scope denial is surfaced once without polling or resubmission", async () => {
  let calls = 0;
  const sdk = new TldwClient({
    apiUrl,
    token: "explicit",
    fetch: async () => {
      calls++;
      return response(
        {
          error: {
            code: "TOKEN_SCOPE_REQUIRED",
            message: "jobs:write required",
          },
        },
        403,
      );
    },
  });
  await assert.rejects(
    sdk.cancelJob(id),
    (error) => error.code === "TOKEN_SCOPE_REQUIRED",
  );
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { TldwClient } from "../src/index.mjs";

const id = "00000000-0000-4000-8000-000000000103";
const content = {
  transcript_id: id,
  source: "platform_manual",
  language: "en",
  timed: true,
  segments: [{ start_ms: 0, end_ms: 1000, text: "Original source." }],
  blocks: [],
  text: null,
};

function client(calls) {
  return new TldwClient({
    apiUrl: "https://api.example.test",
    token: "fixture",
    fetch: async (url, init) => {
      calls.push({
        url: new URL(url),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : null,
      });
      const value =
        init.method === "PATCH"
          ? {
              id,
              unread: !JSON.parse(init.body).read,
              read_at: JSON.parse(init.body).read
                ? "2026-01-10T12:00:00Z"
                : null,
            }
          : new URL(url).pathname === "/v1/transcripts"
            ? { items: [{ id }], next_cursor: "next+cursor/==" }
            : {
                ...content,
                total_segments: 1,
                total_blocks: 0,
                next_offset: null,
              };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

test("catalog wrappers encode filters and keep reading separate from marking", async () => {
  const calls = [];
  const sdk = client(calls);
  const list = await sdk.listTranscripts({
    cursor: "next+cursor/==",
    since: "2026-01-10T12:00:00+00:00",
    until: "2026-01-11T12:00:00Z",
    unreadOnly: true,
  });
  assert.equal(list.items[0].id, id);
  assert.equal(calls[0].url.searchParams.get("limit"), "50");
  assert.equal(calls[0].url.searchParams.get("cursor"), "next+cursor/==");
  assert.equal(
    calls[0].url.searchParams.get("since"),
    "2026-01-10T12:00:00+00:00",
  );
  assert.equal(calls[0].url.searchParams.get("unread_only"), "true");
  assert.equal((await sdk.getSavedTranscript(id)).transcript_id, id);
  assert.equal(
    (await sdk.getSavedTranscriptPage(id, { offset: 12, limit: 25 }))
      .next_offset,
    null,
  );
  assert.equal(calls[2].url.pathname, `/v1/transcripts/${id}/page`);
  assert.equal(calls[2].url.searchParams.get("offset"), "12");
  assert.equal(calls[2].url.searchParams.get("limit"), "25");
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal((await sdk.markTranscriptRead(id)).unread, false);
  assert.equal((await sdk.markTranscriptRead(id, false)).unread, true);
  assert.deepEqual(
    calls.slice(3).map((call) => call.body),
    [{ read: true }, { read: false }],
  );
});

test("invalid catalog options never send an HTTP request", async () => {
  const calls = [];
  const sdk = client(calls);
  for (const options of [
    { limit: 101 },
    { limit: true },
    { unreadOnly: "true" },
    { cursor: "" },
    { since: {} },
  ])
    await assert.rejects(sdk.listTranscripts(options), TypeError);
  await assert.rejects(sdk.getSavedTranscript("not-an-id"), TypeError);
  await assert.rejects(
    sdk.getSavedTranscriptPage(id, { offset: -1 }),
    TypeError,
  );
  await assert.rejects(
    sdk.getSavedTranscriptPage(id, { limit: 501 }),
    TypeError,
  );
  await assert.rejects(sdk.markTranscriptRead(id, "true"), TypeError);
  assert.equal(calls.length, 0);
});

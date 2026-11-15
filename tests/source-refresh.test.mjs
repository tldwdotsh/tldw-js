import assert from "node:assert/strict";
import { test } from "node:test";
import { TldwClient } from "../src/index.mjs";

const jobId = "00000000-0000-4000-8000-000000000101";
const summaryId = "00000000-0000-4000-8000-000000000102";

function client(calls) {
  return new TldwClient({
    apiUrl: "https://api.example.test",
    token: "fixture",
    fetch: async (url, init) => {
      let value;
      if (init.method === "POST") {
        calls.push(JSON.parse(init.body));
        value = {
          job_id: jobId,
          job: { id: jobId, status: "queued", progress: 0 },
        };
      } else if (url.includes("/v1/jobs/")) {
        value = {
          id: jobId,
          status: "completed",
          progress: 100,
          summary_id: summaryId,
        };
      } else {
        value = {
          id: summaryId,
          content: { answer: "Stored source analysis." },
        };
      }
      return new Response(JSON.stringify(value), {
        status: init.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

test("source refresh reaches analysis without implicitly authorizing ASR", async () => {
  const calls = [];
  const sdk = client(calls);
  const url = "https://x.com/user/status/1234567890";
  await sdk.submitAnalysis(url);
  await sdk.submitAnalysis(url, { refreshSource: false });
  await sdk.analyze(url, { refreshSource: true });
  assert.equal("refresh_source" in calls[0], false);
  assert.equal(calls[1].refresh_source, false);
  assert.equal(calls[2].refresh_source, true);
  assert.ok(
    calls.every((body) => !("transcription" in body) && !("force_asr" in body)),
  );
});

test("invalid source refresh never submits", async () => {
  const calls = [];
  const sdk = client(calls);
  for (const refreshSource of ["true", "false", 1, 0, null, [], {}]) {
    await assert.rejects(
      sdk.submitAnalysis("source", { refreshSource }),
      TypeError,
    );
  }
  assert.equal(calls.length, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { TldwClient, TldwTimeoutError } from "../src/index.mjs";
import { runCli } from "../src/cli.mjs";

const jobId = "00000000-0000-4000-8000-000000000101";
const summaryId = "00000000-0000-4000-8000-000000000103";
const transcriptId = "00000000-0000-4000-8000-000000000102";
const completed = {
  id: jobId,
  status: "completed",
  progress: 100,
  output_mode: "analysis",
  summary_id: summaryId,
  transcript_id: transcriptId,
  result_url: "https://untrusted.example/never-follow",
};
const accepted = {
  job_id: jobId,
  job: { id: jobId, output_mode: "analysis", status: "queued", progress: 0 },
  output_mode: "analysis",
  status_url: "https://untrusted.example/never-follow",
};
const source = {
  transcript_id: transcriptId,
  source: "platform_manual",
  language: "en",
  timed: true,
  segments: [{ start_ms: 0, end_ms: 1000, text: "Original spoken words." }],
  blocks: [],
  text: null,
};
const response = (body, status = 200) => Response.json(body, { status });
function client(fetch) {
  return new TldwClient({
    apiUrl: "https://api.example.test",
    token: "fixture",
    fetch,
  });
}

test("analyzes once then reads original source without following returned URLs", async () => {
  const calls = [];
  const sdk = client(async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === "POST") return response(accepted, 202);
    if (url.endsWith(`/jobs/${jobId}`)) return response(completed);
    assert.equal(
      url,
      `https://api.example.test/v1/summaries/${summaryId}/transcript`,
    );
    return response(source);
  });
  const result = await sdk.extractTranscript("https://youtu.be/dQw4w9WgXcQ", {
    idempotencyKey: "extract-once",
  });
  assert.deepEqual(result.transcript, source);
  assert.equal(result.job.summary_id, summaryId);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/v1/analyses",
      `/v1/jobs/${jobId}`,
      `/v1/summaries/${summaryId}/transcript`,
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    media: "https://youtu.be/dQw4w9WgXcQ",
  });
  assert.equal(calls[0].headers["Idempotency-Key"], "extract-once");
});

test("extraction forwards deprecated audio fields and caps through one analysis submission", async () => {
  const calls = [];
  const sdk = client(async (url, init) => {
    if (init.method === "POST") {
      assert.equal(url, "https://api.example.test/v1/analyses");
      calls.push(JSON.parse(init.body));
      return response(accepted, 202);
    }
    return response(url.includes("/jobs/") ? completed : source);
  });
  await sdk.extractTranscript("https://x.com/user/status/1234567890", {
    transcription: "never",
    maxCredits: "9.00",
    forceAsr: true,
    refreshSource: true,
  });
  assert.deepEqual(calls, [
    {
      media: "https://x.com/user/status/1234567890",
      transcription: "never",
      max_credits: "9.00",
      force_asr: true,
      refresh_source: true,
    },
  ]);
  assert.equal("submitTranscript" in sdk, false);
});

test("rejects removed caption preferences and invalid extraction inputs before submission", async () => {
  let requests = 0;
  const sdk = client(async () => {
    requests++;
    return response(accepted, 202);
  });
  for (const [media, options] of [
    ["source", { preferredCaptionLanguages: [] }],
    [null, {}],
    ["source", { preferredCaptionLanguages: ["invalid tag"] }],
    ["source", { refreshSource: "true" }],
    ["source", { forceAsr: "true" }],
  ])
    await assert.rejects(sdk.extractTranscript(media, options), TypeError);
  assert.equal(requests, 0);
  await assert.rejects(
    sdk.extractTranscript("source", { timeoutMs: -1 }),
    TypeError,
  );
  assert.equal(requests, 0);
});

test("completed transcript jobs require transcript IDs; ordinary summary jobs still require summaries", async () => {
  for (const transcript_id of [null, "https://bad.example/source", 42]) {
    const sdk = client(async () =>
      response({
        ...completed,
        output_mode: "transcript",
        summary_id: null,
        transcript_id,
      }),
    );
    await assert.rejects(
      sdk.waitForJob(jobId),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
  const sdk = client(async () => response({ ...completed, summary_id: null }));
  await assert.rejects(
    sdk.waitForJob(jobId),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("source access denial retains the accepted receipt and durable job ID", async () => {
  const sdk = client(async (url, init) => {
    if (init.method === "POST") return response(accepted, 202);
    if (url.includes("/jobs/")) return response(completed);
    return response(
      {
        error: {
          code: "TOKEN_SCOPE_REQUIRED",
          message: "summaries:read required",
        },
      },
      403,
    );
  });
  await assert.rejects(
    sdk.extractTranscript("source"),
    (error) =>
      error.code === "TOKEN_SCOPE_REQUIRED" &&
      error.jobId === jobId &&
      error.receipt.job_id === jobId,
  );
});

test("an extraction wait timeout preserves accepted work without cancellation or resubmission", async () => {
  const calls = [];
  const sdk = client(async (url, init) => {
    calls.push({ url, ...init });
    return response({ ...accepted, next_poll_after_ms: 3000 }, 202);
  });
  await assert.rejects(
    sdk.extractTranscript("source", { timeoutMs: 1 }),
    (error) =>
      error instanceof TldwTimeoutError &&
      error.jobId === jobId &&
      error.receipt.job_id === jobId,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("invalid extraction receipt retains the stable submission key", async () => {
  const sdk = client(async () =>
    response({ ...accepted, job: { id: transcriptId } }, 202),
  );
  await assert.rejects(
    sdk.submitAnalysis("source", { idempotencyKey: "stable-key" }),
    (error) =>
      error.code === "INVALID_RESPONSE" &&
      error.idempotencyKey === "stable-key",
  );
});

test("CLI extract reads the analysis transcript and wait can read a saved transcript job", async () => {
  for (const args of [
    ["extract", "--media", "Original text"],
    ["wait", jobId],
  ]) {
    let out = "",
      err = "";
    const calls = [];
    class FakeClient {
      async submitAnalysis(media, options) {
        calls.push({ media, options });
        return accepted;
      }
      async waitForJob(id) {
        assert.equal(id, jobId);
        return args[0] === "wait"
          ? { ...completed, output_mode: "transcript", summary_id: null }
          : completed;
      }
      async getTranscript(id) {
        assert.equal(id, summaryId);
        return source;
      }
      async getSavedTranscript(id) {
        assert.equal(id, transcriptId);
        return source;
      }
      async getSummary() {
        assert.fail("Transcript-only work must not read a summary");
      }
    }
    const status = await runCli(
      [...args, "--api-url", "https://api.example.test"],
      {
        env: { TLDW_API_TOKEN: "fixture" },
        clientFactory: FakeClient,
        stdout: {
          write: (value) => {
            out += value;
          },
        },
        stderr: {
          write: (value) => {
            err += value;
          },
        },
      },
    );
    assert.equal(status, 0, err);
    assert.deepEqual(JSON.parse(out).transcript, source);
    assert.equal("summary" in JSON.parse(out), false);
    if (args[0] === "extract") {
      assert.equal("instructions" in calls[0].options, false);
      assert.equal(JSON.parse(out).summary_id, summaryId);
    }
  }
});

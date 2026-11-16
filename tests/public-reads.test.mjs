import assert from "node:assert/strict";
import test from "node:test";
import { TldwClient, TldwError } from "../src/index.mjs";
import { runCli } from "../src/cli.mjs";

const API = "https://fixture.invalid";
const ID = "00000000-0000-4000-8000-000000000101";
const reads = [
  [
    "getPublicConfig",
    "/v1/public/config",
    { features: { x_search: true }, api_url: "https://untrusted.invalid" },
  ],
  [
    "getPublicSecurity",
    "/v1/public/security",
    {
      trial_enabled: true,
      free_monthly_credits: 240,
      trial_max_video_minutes: 70,
    },
  ],
  [
    "getBillingCatalog",
    "/v1/billing/catalog",
    {
      billing_enabled: true,
      plans: [{ tier: "hobby", price_usd: "20.00", checkout_available: true }],
      credit_packs: [{ credits: 1000, price_usd: "20.00" }],
      credit_unit: "processing_credit",
    },
  ],
];

test("public-only is explicit and does not relax default authentication or origin validation", () => {
  assert.throws(() => new TldwClient({ apiUrl: API }), TypeError);
  for (const publicOnly of [null, 1, "true"])
    assert.throws(() => new TldwClient({ apiUrl: API, publicOnly }), TypeError);
  assert.throws(
    () => new TldwClient({ apiUrl: API, publicOnly: true, token: "fixture" }),
    TypeError,
  );
  for (const apiUrl of [
    "http://remote.example",
    "https://user:password@api.example",
    "https://api.example/path",
    "https://api.example/?key=value",
  ])
    assert.throws(
      () => new TldwClient({ apiUrl, publicOnly: true }),
      TypeError,
    );
});

test("all public reads preserve full JSON, use their own origin and omit auth in public-only mode", async () => {
  for (const publicOnly of [true, false]) {
    const calls = [];
    const client = new TldwClient({
      apiUrl: API,
      ...(publicOnly ? { publicOnly: true } : { token: "fixture" }),
      fetch: async (url, init) => {
        calls.push({ url, init });
        const entry = reads.find(([, path]) => url === API + path);
        assert(entry);
        return Response.json(entry[2]);
      },
    });
    for (const [method, , value] of reads)
      assert.deepEqual(await client[method](), value);
    assert.equal(calls.length, 3);
    for (const { init } of calls) {
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(
        init.headers.Authorization,
        publicOnly ? undefined : "Bearer fixture",
      );
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, publicOnly ? "omit" : undefined);
    }
  }
});

test("public-only clients reject account, processing, saved-source and event operations before any transport", async () => {
  let calls = 0;
  const client = new TldwClient({
    apiUrl: API,
    publicOnly: true,
    fetch: async () => {
      calls++;
      throw new Error("No private request may reach transport");
    },
  });
  const operations = [
    () => client.getUsage(),
    () => client.getJob(ID),
    () => client.waitJob(ID),
    () => client.listJobs(),
    () => client.submitAnalysis("source"),
    () => client.searchVideos("query"),
    () => client.cancelJob(ID),
    () => client.getSummary(ID),
    () => client.getTranscript(ID),
    () => client.getSavedTranscriptPage(ID),
    () => client.markTranscriptRead(ID),
  ];
  for (const operation of operations)
    await assert.rejects(
      operation(),
      (e) => e instanceof TldwError && e.code === "PUBLIC_READ_ONLY",
    );
  assert.throws(
    () => client.streamJobEvents(ID),
    (e) => e.code === "PUBLIC_READ_ONLY",
  );
  assert.equal(calls, 0);
});

test("public metadata refuses redirects and keeps structured API failures", async () => {
  for (const redirect of [true, false]) {
    let calls = 0;
    const client = new TldwClient({
      apiUrl: API,
      publicOnly: true,
      fetch: async () => {
        calls++;
        return redirect
          ? new Response(null, {
              status: 302,
              headers: { Location: "https://other.invalid/data" },
            })
          : Response.json(
              {
                error: {
                  code: "FEATURE_DISABLED",
                  message: "Fixture policy",
                  details: { reason: "policy" },
                },
              },
              { status: 403 },
            );
      },
    });
    await assert.rejects(
      client.getPublicConfig(),
      (e) =>
        e.code === (redirect ? "HTTP_ERROR" : "FEATURE_DISABLED") &&
        e.status === (redirect ? 302 : 403),
    );
    assert.equal(calls, 1);
  }
});

test("public metadata keeps body limits, request deadline and cancellation", async () => {
  const huge = new TldwClient({
    apiUrl: API,
    publicOnly: true,
    fetch: async () =>
      new Response("{}", {
        headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
      }),
  });
  await assert.rejects(
    huge.getBillingCatalog(),
    (e) => e.code === "INVALID_RESPONSE",
  );
  const slow = new TldwClient({
    apiUrl: API,
    publicOnly: true,
    requestTimeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    slow.getPublicConfig(),
    (e) => e.code === "WAIT_TIMEOUT",
  );
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  const canceled = new TldwClient({
    apiUrl: API,
    publicOnly: true,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    canceled.getPublicSecurity({ signal: controller.signal }),
    (e) => e === reason,
  );
  assert.equal(calls, 0);
});

test("CLI public commands work without a key and never forward an environment key", async () => {
  const commands = [
    ["public-config", reads[0]],
    ["public-security", reads[1]],
    ["billing-catalog", reads[2]],
  ];
  for (const [command, [, path, value]] of commands)
    for (const env of [{}, { TLDW_API_TOKEN: "fixture-private-key" }]) {
      const out = [],
        err = [],
        calls = [];
      const status = await runCli([command, "--api-url", API], {
        env,
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return Response.json(value);
        },
      });
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(out.join("")), value);
      assert.equal(err.join(""), "");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, API + path);
      assert.equal(calls[0].init.method, "GET");
      assert.equal(calls[0].init.headers.Authorization, undefined);
      assert.equal(calls[0].init.credentials, "omit");
    }
});

test("CLI public reads reject submission arguments and private commands still require a key", async () => {
  for (const argv of [
    ["public-config", "extra"],
    ["billing-catalog", "--media", "source"],
    ["doctor"],
  ]) {
    const out = [],
      err = [];
    let calls = 0;
    const status = await runCli(argv, {
      env: {},
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      fetchImpl: async () => {
        calls++;
        throw new Error("No request");
      },
    });
    assert.equal(status, 1);
    assert.equal(calls, 0);
    assert.equal(out.join(""), "");
  }
});

test("CLI public reads retain bounded deadlines and interruption without sending a key", async () => {
  class BoundedPublicClient extends TldwClient {
    constructor(options) {
      super({ ...options, requestTimeoutMs: 5 });
    }
  }
  const out = [],
    err = [];
  let calls = 0;
  const status = await runCli(["public-config", "--api-url", API], {
    env: { TLDW_API_TOKEN: "fixture-private-key" },
    stdout: { write: (value) => out.push(value) },
    stderr: { write: (value) => err.push(value) },
    clientFactory: BoundedPublicClient,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.credentials, "omit");
      return new Promise(() => {});
    },
  });
  assert.equal(status, 1);
  assert.equal(calls, 1);
  assert.equal(out.join(""), "");
  assert.equal(JSON.parse(err.join("")).code, "WAIT_TIMEOUT");
  assert(!err.join("").includes("fixture-private-key"));
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const canceled = [];
  const interrupted = await runCli(["billing-catalog", "--api-url", API], {
    env: {},
    signal: controller.signal,
    stdout: {
      write: () => assert.fail("Interrupted command emitted a result"),
    },
    stderr: { write: (value) => canceled.push(value) },
    fetchImpl: async () => assert.fail("Interrupted command reached transport"),
  });
  assert.equal(interrupted, 130);
  assert.equal(JSON.parse(canceled.join("")).code, "INTERRUPTED");
});

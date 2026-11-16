import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { checkMcp, runCli } from "../src/cli.mjs";
import { installPlugin, shellQuote, validateOrigin } from "../src/install.mjs";

const API = "https://api.operator.test";
const SOURCE = resolve(import.meta.dirname, "../plugin");
async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "tldw-cli-test-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function outputs() {
  const lines = { out: "", err: "" };
  return {
    lines,
    stdout: {
      write: (s) => {
        lines.out += s;
      },
    },
    stderr: {
      write: (s) => {
        lines.err += s;
      },
    },
  };
}
function rpcFetch({
  failing = [],
  tools = [
    "account_usage",
    "analyze_media",
    "get_job",
    "get_summary",
    "list_jobs",
  ],
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    let result;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "tldw", version: "1" },
      };
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "tools/list")
      result = { tools: tools.map((name) => ({ name })) };
    if (body.method === "tools/call")
      result = {
        content: [],
        structuredContent: { items: [] },
        isError: failing.includes(body.params.name),
      };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  return { calls, fetchImpl };
}

test("origin validation rejects credential URLs, non-loopback HTTP, query and command data", () => {
  for (const value of [
    "https://user:private@api.test",
    "http://api.test",
    "https://api.test/path",
    "https://api.test?token=private",
    "https://api.test#fragment",
    "https://api.test\n",
    "https://api.test\\path",
    "https://api.test:0",
    "https://$(bad).test",
    "https://api.test?",
    "https://api.test#",
  ])
    assert.throws(() => validateOrigin(value), { code: "INVALID_ORIGIN" });
  assert.equal(validateOrigin("https://api.test/"), "https://api.test");
  assert.equal(
    validateOrigin("http://localhost:8000"),
    "http://localhost:8000",
  );
  assert.equal(validateOrigin("http://[::1]:8000"), "http://[::1]:8000");
});

test("init materializes the reviewed plugin with endpoint-only native configs and verifies new hashes", async (t) => {
  const parent = await temporary(t),
    target = join(parent, "configured plugin");
  const result = await installPlugin({
    apiUrl: API,
    directory: target,
    webUrl: "https://app.operator.test",
    source: SOURCE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.onboarding_url, "https://app.operator.test/agents");
  assert.equal(result.credentials_saved, false);
  assert.equal(result.global_settings_changed, false);
  const claude = JSON.parse(await readFile(join(target, ".mcp.json"), "utf8"));
  // The endpoint is literal: no environment variable may redirect the token.
  assert.equal(claude.mcpServers.tldw.url, API + "/mcp");
  assert.ok(!JSON.stringify(claude).includes("TLDW_MCP_URL"));
  assert.deepEqual(claude.mcpServers.tldw, { type: "http", url: API + "/mcp" });
  const codex = JSON.parse(
    await readFile(join(target, "codex.mcp.json"), "utf8"),
  );
  assert.equal(codex.mcpServers.tldw.url, API + "/mcp");
  assert.deepEqual(codex.mcpServers.tldw, { url: API + "/mcp" });
  const build = JSON.parse(await readFile(join(target, "BUILD.json"), "utf8"));
  for (const [name, checksum] of Object.entries(build.sha256))
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(target, name)))
        .digest("hex"),
      checksum,
    );
  assert.deepEqual(Object.keys(result.commands).sort(), [
    "claude_code",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "vscode",
  ]);
  assert.match(result.commands.codex.commands[0], /codex mcp add tldw --url/);
  assert.equal(result.commands.cursor.config.mcpServers.tldw.url, API + "/mcp");
  assert.equal(
    result.commands.opencode.config.mcp.servers.tldw.url,
    API + "/mcp",
  );
  assert.equal(result.commands.vscode.config.mcpServers.tldw.url, API + "/mcp");
  for (const client of ["codex", "grok"]) {
    assert.match(result.commands[client].config_toml, /\[mcp_servers\.tldw\]/);
    assert.ok(result.commands[client].config_toml.includes(API + "/mcp"));
  }
  // Guidance and packaged examples are one reviewed connection contract.
  for (const [client, file] of [
    ["cursor", "cursor/mcp.json"],
    ["opencode", "opencode/opencode.json"],
    ["vscode", "vscode/mcp-config.json"],
  ]) {
    const expected = JSON.parse(
      (await readFile(join(SOURCE, "examples", file), "utf8")).replaceAll(
        "https://api.tldw.invalid",
        API,
      ),
    );
    assert.deepEqual(result.commands[client].config, expected);
  }
  for (const [client, file] of [
    ["codex", "codex/config.toml"],
    ["grok", "grok/grok-config.example.toml"],
  ]) {
    const expected = (await readFile(join(SOURCE, "examples", file), "utf8"))
      .replaceAll("https://api.tldw.invalid", API)
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join("\n");
    assert.equal(result.commands[client].config_toml.trim(), expected);
  }
  assert.equal("generic_mcp" in result.commands, false);
  assert.equal("oauth" in result.commands.grok, false);
  assert(!JSON.stringify(result).includes("--trust"));
});

test("init never replaces an existing directory, file or symlink", async (t) => {
  const parent = await temporary(t);
  const target = join(parent, "existing");
  await writeFile(target, "keep this");
  await assert.rejects(
    installPlugin({ apiUrl: API, directory: target, source: SOURCE }),
    {
      code: "DESTINATION_EXISTS",
    },
  );
  assert.equal(await readFile(target, "utf8"), "keep this");
  const link = join(parent, "link");
  await symlink(target, link);
  await assert.rejects(
    installPlugin({ apiUrl: API, directory: link, source: SOURCE }),
    {
      code: "DESTINATION_EXISTS",
    },
  );
});

test("CLI init defaults to production API/web origins without exposing environment credentials", async (t) => {
  const parent = await temporary(t);
  const out = outputs();
  const code = await runCli(["init", "--dir", join(parent, "plugin")], {
    ...out,
    env: { TLDW_API_TOKEN: "private-environment-sentinel" },
  });
  assert.equal(code, 0, out.lines.err);
  const result = JSON.parse(out.lines.out);
  assert.equal(result.api_url, "https://api.tldw.sh");
  assert.equal(result.mcp_url, "https://api.tldw.sh/mcp");
  assert.equal(result.onboarding_url, "https://tldw.sh/agents");
  assert.equal(Object.keys(result.commands).length, 6);
  assert.equal(result.credentials_saved, false);
  assert.ok(!out.lines.out.includes("private-environment-sentinel"));
});

test("npm's reviewed .gitignore rename is restored, but changed or additional aliases are refused", async (t) => {
  const parent = await temporary(t);
  const npmSource = join(parent, "npm-source");
  await installPlugin({ apiUrl: API, directory: npmSource, source: SOURCE });
  const expected = await readFile(join(npmSource, ".gitignore"));
  await rename(join(npmSource, ".gitignore"), join(npmSource, ".npmignore"));
  const target = join(parent, "restored");
  await installPlugin({ apiUrl: API, directory: target, source: npmSource });
  assert.deepEqual(await readFile(join(target, ".gitignore")), expected);
  await assert.rejects(readFile(join(target, ".npmignore")), {
    code: "ENOENT",
  });
  await writeFile(
    join(npmSource, ".npmignore"),
    "changed byte-for-byte contents\n",
  );
  await assert.rejects(
    installPlugin({
      apiUrl: API,
      directory: join(parent, "bad"),
      source: npmSource,
    }),
    { code: "INVALID_BUNDLE" },
  );
  await writeFile(join(npmSource, ".npmignore"), expected);
  await writeFile(join(npmSource, ".gitignore"), expected);
  await assert.rejects(
    installPlugin({
      apiUrl: API,
      directory: join(parent, "extra"),
      source: npmSource,
    }),
    { code: "INVALID_BUNDLE" },
  );
});

test("init refuses symlink parents and tampered bundles before creating a destination", async (t) => {
  const parent = await temporary(t);
  const link = join(parent, "link");
  await symlink(parent, link);
  await assert.rejects(
    installPlugin({
      apiUrl: API,
      directory: join(link, "new"),
      source: SOURCE,
    }),
    { code: "UNSAFE_DIRECTORY" },
  );
  const copied = join(parent, "copied");
  await installPlugin({ apiUrl: API, directory: copied, source: SOURCE });
  await writeFile(join(copied, "README.md"), "tampered");
  await assert.rejects(
    installPlugin({
      apiUrl: API,
      directory: join(parent, "new"),
      source: copied,
    }),
    { code: "INVALID_BUNDLE" },
  );
  assert.deepEqual((await readdir(parent)).sort(), ["copied", "link"]);
});

test("npm-omitted ignore files are recovered only from the exact reviewed template", async (t) => {
  const parent = await temporary(t);
  const copied = join(parent, "source");
  await installPlugin({ apiUrl: API, directory: copied, source: SOURCE });
  const expected = await readFile(join(copied, ".gitignore"));
  await rm(join(copied, ".gitignore"));
  const target = join(parent, "recovered");
  await installPlugin({ apiUrl: API, directory: target, source: copied });
  assert.deepEqual(await readFile(join(target, ".gitignore")), expected);
  const metadata = JSON.parse(
    await readFile(join(copied, "BUILD.json"), "utf8"),
  );
  metadata.sha256[".gitignore"] = "0".repeat(64);
  await writeFile(join(copied, "BUILD.json"), JSON.stringify(metadata));
  await assert.rejects(
    installPlugin({
      apiUrl: API,
      directory: join(parent, "invalid"),
      source: copied,
    }),
    { code: "INVALID_BUNDLE" },
  );
});

test("init handles shell-sensitive output paths without executing native commands", () => {
  assert.equal(shellQuote("folder's plugin"), "'folder'\"'\"'s plugin'");
});

test("doctor uses only initialize, list and account_usage against one pinned endpoint", async () => {
  const { calls, fetchImpl } = rpcFetch();
  const result = await checkMcp({
    apiUrl: API,
    token: "fixture-token",
    fetchImpl,
  });
  assert(result.connected);
  assert.equal(result.tools_available, 5);
  assert.equal(result.read_only_check, "account_usage");
  assert(
    calls.every(
      (call) =>
        call.url === API + "/mcp" &&
        call.options.redirect === "error" &&
        call.options.headers.Authorization === "Bearer fixture-token",
    ),
  );
  assert.deepEqual(
    calls.map((call) => call.body.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  assert.equal(calls.at(-1).body.params.name, "account_usage");
});

test("doctor falls back to list_jobs when account_usage is rejected or absent", async () => {
  const rejected = rpcFetch({ failing: ["account_usage"] });
  const result = await checkMcp({
    apiUrl: API,
    token: "fixture-token",
    fetchImpl: rejected.fetchImpl,
  });
  assert.equal(result.read_only_check, "list_jobs");
  const called = rejected.calls
    .filter((call) => call.body.method === "tools/call")
    .map((call) => call.body.params.name);
  assert.deepEqual(called, ["account_usage", "list_jobs"]);
  assert(
    rejected.calls.every(
      (call) =>
        call.body.method !== "tools/call" ||
        !["analyze_media", "extract_transcript", "cancel_job"].includes(
          call.body.params.name,
        ),
    ),
  );
  const absent = rpcFetch({
    tools: ["analyze_media", "get_job", "get_summary", "list_jobs"],
  });
  const fallback = await checkMcp({
    apiUrl: API,
    token: "fixture-token",
    fetchImpl: absent.fetchImpl,
  });
  assert.equal(fallback.read_only_check, "list_jobs");
  assert.equal(
    absent.calls.filter((call) => call.body.method === "tools/call").length,
    1,
  );
});

test("doctor does not require hidden legacy tools", async () => {
  const { fetchImpl } = rpcFetch({
    tools: ["analyze_media", "get_job", "get_summary"],
  });
  await assert.rejects(
    checkMcp({ apiUrl: API, token: "fixture-token", fetchImpl }),
    { code: "MCP_CHECK_FAILED" },
  );
  const missing = rpcFetch({
    tools: ["analyze_media", "get_job", "list_jobs"],
  });
  await assert.rejects(
    checkMcp({
      apiUrl: API,
      token: "fixture-token",
      fetchImpl: missing.fetchImpl,
    }),
    { code: "MCP_TOOLS_MISSING" },
  );
});

test("doctor rejects protocol failures and authorization errors without source execution", async () => {
  const { fetchImpl } = rpcFetch({ failing: ["account_usage", "list_jobs"] });
  await assert.rejects(
    checkMcp({ apiUrl: API, token: "fixture-token", fetchImpl }),
    {
      code: "MCP_CHECK_FAILED",
    },
  );
  await assert.rejects(
    checkMcp({
      apiUrl: API,
      token: "fixture-token",
      fetchImpl: async () => new Response("no", { status: 401 }),
    }),
    { code: "UNAUTHORIZED", status: 401 },
  );
});

test("CLI rejects token arguments and non-local anonymous mode without invoking a client", async () => {
  for (const argv of [
    ["doctor", "--api-url", API, "--token", "fixture-secret"],
    ["doctor", "--api-url", API, "--local"],
  ]) {
    const out = outputs();
    assert.equal(await runCli(argv, { ...out, env: {} }), 1);
    assert(
      !out.lines.out.includes("fixture-secret") &&
        !out.lines.err.includes("fixture-secret"),
    );
  }
});

test("CLI doctor can verify an analysis-only key without optional account:read", async () => {
  class Client {
    async getUsage() {
      throw { status: 403 };
    }
  }
  const out = outputs();
  const { fetchImpl } = rpcFetch();
  const exit = await runCli(["doctor", "--api-url", API], {
    ...out,
    env: { TLDW_API_TOKEN: "fixture-token" },
    clientFactory: Client,
    fetchImpl,
  });
  assert.equal(exit, 0);
  const result = JSON.parse(out.lines.out);
  assert.equal(result.account.available, false);
  assert.equal(result.analyses_consumed, 0);
  assert.equal(result.processing_submitted, false);
  assert(!out.lines.out.includes("fixture-token"));
});

test("CLI emits accepted job ID before waiting, and never resubmits a timed-out job", async () => {
  const out = outputs();
  const calls = [];
  class Client {
    async submitAnalysis(media, options) {
      calls.push({ media, options });
      return {
        job_id: "fixture-job",
        status_url: "https://external.test/fixture-token",
      };
    }
    async waitForJob(id) {
      assert.equal(id, "fixture-job");
      assert.match(out.lines.err, /accepted/);
      throw { code: "WAIT_TIMEOUT", jobId: id };
    }
  }
  const exit = await runCli(
    [
      "analyze",
      "--api-url",
      API,
      "--media",
      "https://youtu.be/fixture",
      "--instructions",
      "Cite evidence",
      "--idempotency-key",
      "stable-001",
    ],
    { ...out, env: { TLDW_API_TOKEN: "fixture-token" }, clientFactory: Client },
  );
  assert.equal(exit, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.idempotencyKey, "stable-001");
  assert.match(out.lines.err, /WAIT_TIMEOUT/);
  assert.match(out.lines.err, /fixture-job/);
  assert(!out.lines.err.includes("fixture-token"));
});

test("CLI wait resumes existing job and prints result without submission", async () => {
  const out = outputs();
  const calls = [];
  class Client {
    async waitForJob(id) {
      calls.push(id);
      return { id, status: "completed", summary_id: "fixture-summary" };
    }
    async getSummary(id) {
      return { id, content: { answer: "Cited result" } };
    }
  }
  const exit = await runCli(
    ["wait", "fixture-job", "--api-url", "http://localhost:8000", "--local"],
    { ...out, env: {}, clientFactory: Client },
  );
  assert.equal(exit, 0);
  assert.deepEqual(calls, ["fixture-job"]);
  assert.equal(
    JSON.parse(out.lines.out).summary.content.answer,
    "Cited result",
  );
});

test("CLI interruption retains the accepted job ID and exits without canceling server work", async () => {
  const out = outputs();
  const controller = new AbortController();
  class Client {
    async submitAnalysis() {
      return { job_id: "fixture-job" };
    }
    async waitForJob() {
      controller.abort();
      throw { code: "ABORTED" };
    }
  }
  const exit = await runCli(
    ["analyze", "--api-url", API, "--media", "Source text"],
    {
      ...out,
      env: { TLDW_API_TOKEN: "fixture-token" },
      clientFactory: Client,
      signal: controller.signal,
    },
  );
  assert.equal(exit, 130);
  assert.match(out.lines.err, /INTERRUPTED/);
  assert.match(out.lines.err, /fixture-job/);
});

test("CLI prints a generated stable key before POST and preserves it after an unknown outcome", async () => {
  const out = outputs();
  let submittedKey;
  class Client {
    constructor({ fetch }) {
      this.fetch = fetch;
    }
    async submitAnalysis(_media, options) {
      submittedKey = options.idempotencyKey;
      // The key is announced as the POST goes out, before any reply.
      await this.fetch(API + "/v1/analyses", { method: "POST" });
      assert.equal(
        JSON.parse(out.lines.err.trim()).idempotency_key,
        submittedKey,
      );
      throw { code: "NETWORK_ERROR" };
    }
  }
  const exit = await runCli(
    ["analyze", "--api-url", API, "--media", "Source text"],
    {
      ...out,
      env: { TLDW_API_TOKEN: "fixture-token" },
      clientFactory: Client,
      fetchImpl: async () => new Response(null, { status: 599 }),
    },
  );
  assert.equal(exit, 1);
  assert.match(submittedKey, /^tldw-cli-/);
  const events = out.lines.err.trim().split("\n").map(JSON.parse);
  assert.equal(events[0].event, "submission");
  assert.equal(events[1].idempotency_key, submittedKey);
  assert(!out.lines.err.includes("fixture-token"));
});

test("CLI reports invalid options without announcing an unsent submission", async () => {
  for (const args of [
    ["--transcription", "sometimes"],
    ["--max-credits", "abc", "--transcription", "if_needed"],
  ]) {
    const out = outputs();
    let fetched = 0;
    const exit = await runCli(
      ["analyze", "--api-url", API, "--media", "Source text", ...args],
      {
        ...out,
        env: { TLDW_API_TOKEN: "fixture-token" },
        fetchImpl: async () => {
          fetched++;
          return new Response(null, { status: 500 });
        },
      },
    );
    assert.equal(exit, 1);
    assert.equal(fetched, 0);
    const events = out.lines.err.trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].code, "INVALID_ARGUMENT");
    assert.doesNotMatch(events[0].message, /did not finish/);
    assert.equal(events[0].idempotency_key, undefined);
  }
});

test("CLI never echoes an API token hidden in an explicit key or progress response", async () => {
  for (const key of ["fixture-token", "prefix-fixture-token-suffix"]) {
    const out = outputs();
    let submitted = false;
    class Client {
      async submitAnalysis() {
        submitted = true;
      }
    }
    assert.equal(
      await runCli(
        [
          "analyze",
          "--api-url",
          API,
          "--media",
          "Source",
          "--idempotency-key",
          key,
        ],
        {
          ...out,
          env: { TLDW_API_TOKEN: "fixture-token" },
          clientFactory: Client,
        },
      ),
      1,
    );
    assert.equal(submitted, false);
    assert(!out.lines.err.includes("fixture-token"));
    assert.match(out.lines.err, /INVALID_IDEMPOTENCY_KEY/);
  }
  const out = outputs();
  class Client {
    async waitForJob(_id, options) {
      options.onProgress({ status: "fixture-token", progress: 50 });
      throw { code: "WAIT_TIMEOUT" };
    }
  }
  await runCli(["wait", "fixture-job", "--api-url", API], {
    ...out,
    env: { TLDW_API_TOKEN: "fixture-token" },
    clientFactory: Client,
  });
  assert(!out.lines.err.includes("fixture-token"));
  assert.match(out.lines.err, /REDACTED/);
});

test("CLI help explains automatic audio and ignored legacy flags", async () => {
  const io = outputs();
  const status = await runCli(["--help"], {
    ...io,
    env: {},
    clientFactory() {
      throw new Error("Help must not create a client");
    },
  });
  assert.equal(status, 0);
  assert.match(
    io.lines.out,
    /server reuses saved source or captions, then automatic audio when enabled/,
  );
  assert.match(io.lines.out, /cannot disable or force audio/);
  assert.match(
    io.lines.out,
    /--transcription and --force-asr are deprecated, ignored flags/,
  );
  assert.match(
    io.lines.out,
    /Automatic audio needs no opt-in or cap; --max-credits still caps processing credits/,
  );
});

test("CLI default analysis forwards the cap without opting in to fresh ASR", async () => {
  const io = outputs();
  let received;
  class Client {
    async submitAnalysis(_media, options) {
      received = options;
      return { job_id: "00000000-0000-4000-8000-000000000101" };
    }
    async waitForJob() {
      return { summary_id: "00000000-0000-4000-8000-000000000102" };
    }
    async getSummary() {
      return { content: { answer: "done" } };
    }
  }
  const status = await runCli(
    [
      "analyze",
      "--api-url",
      API,
      "--media",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "--max-credits",
      "30.00",
    ],
    { ...io, env: { TLDW_API_TOKEN: "fixture" }, clientFactory: Client },
  );
  assert.equal(status, 0);
  assert.equal(received.maxCredits, "30.00");
  assert.equal(received.transcription, undefined);
  assert.equal(received.forceAsr, undefined);
});

test("CLI forwards deprecated audio compatibility flags and the normal credit ceiling", async () => {
  const io = outputs();
  let received;
  class Client {
    async submitAnalysis(_media, options) {
      received = options;
      return { job_id: "00000000-0000-4000-8000-000000000101" };
    }
    async waitForJob() {
      return { summary_id: "00000000-0000-4000-8000-000000000102" };
    }
    async getSummary() {
      return { content: { answer: "done" } };
    }
  }
  const status = await runCli(
    [
      "analyze",
      "--api-url",
      API,
      "--media",
      "https://youtu.be/dQw4w9WgXcQ",
      "--transcription",
      "if_needed",
      "--max-credits",
      "30.00",
      "--force-asr",
    ],
    {
      ...io,
      env: { TLDW_API_TOKEN: "fixture" },
      clientFactory: Client,
    },
  );
  assert.equal(status, 0);
  assert.equal(received.transcription, "if_needed");
  assert.equal(received.maxCredits, "30.00");
  assert.equal(received.forceAsr, true);
});

test("CLI source refresh is independent of ASR permission", async () => {
  const io = outputs();
  let received;
  class Client {
    async submitAnalysis(_media, options) {
      received = options;
      return { job_id: "00000000-0000-4000-8000-000000000101" };
    }
    async waitForJob() {
      return { summary_id: "00000000-0000-4000-8000-000000000102" };
    }
    async getSummary() {
      return { content: { answer: "done" } };
    }
  }
  const status = await runCli(
    [
      "analyze",
      "--api-url",
      API,
      "--media",
      "https://x.com/user/status/1234567890",
      "--refresh-source",
    ],
    { ...io, env: { TLDW_API_TOKEN: "fixture" }, clientFactory: Client },
  );
  assert.equal(status, 0);
  assert.equal(received.refreshSource, true);
  assert.equal(received.forceAsr, undefined);
  assert.equal(received.transcription, undefined);
});

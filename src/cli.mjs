import { lstat, readFile } from "node:fs/promises";
import {
  installPlugin,
  isLoopback,
  makeIdempotencyKey,
  SetupError,
  validateOrigin,
} from "./install.mjs";

const HELP = `tldw — connect agents to the tldw.sh API

init --api-url ORIGIN [--web-url ORIGIN] [--dir ./tldw-agent-plugin]
  Prepare a new configured plugin directory. Never writes a key or global settings.
doctor --api-url ORIGIN [--local]
  Check REST and MCP without creating a job or consuming an analysis.
analyze --api-url ORIGIN (--media URL_OR_TEXT | --file PATH) [--instructions TEXT]
        [--transcription never|if_needed] [--max-credits DECIMAL] [--force-asr]
        [--idempotency-key KEY] [--timeout-ms 180000] [--local]
  Submit once, preserve the job ID, poll, and fetch the result.
  A non-secret idempotency key is printed before POST. If the reply is lost,
  replay the exact media/instructions with that --idempotency-key.
wait JOB_ID --api-url ORIGIN [--timeout-ms 180000] [--local]
  Resume a durable job. A wait timeout or Ctrl-C does not cancel server work.

Set TLDW_API_URL and TLDW_API_TOKEN in your private environment instead of flags.
Tokens are never accepted as command arguments or saved by this tool.
--local explicitly permits anonymous HTTP/HTTPS loopback development only.
Free includes 500 monthly caption/text credits; Hobby USD20/1000 and Pro USD100/5000.
Captions/text or cached transcripts cost 1 credit/minute; fresh ASR costs 3.
Fresh ASR requires --transcription if_needed and an eligible paid plan.
Plan allowance is used before non-expiring purchased credits. --max-credits caps a job.
`;

function parseArguments(args) {
  const command = args.shift();
  const options = {};
  const positional = [];
  const valued = new Set([
    "api-url",
    "web-url",
    "dir",
    "media",
    "file",
    "instructions",
    "idempotency-key",
    "timeout-ms",
    "transcription",
    "max-credits",
  ]);
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--local" || item === "--force-asr") {
      const flag = item.slice(2);
      if (options[flag])
        throw new SetupError("INVALID_ARGUMENT", `Duplicate ${item} flag.`);
      options[flag] = true;
    } else if (item.startsWith("--")) {
      const key = item.slice(2);
      if (
        !valued.has(key) ||
        options[key] !== undefined ||
        index + 1 >= args.length ||
        args[index + 1].startsWith("--")
      )
        throw new SetupError(
          "INVALID_ARGUMENT",
          "Unknown, missing or duplicate option. Run tldw --help.",
        );
      options[key] = args[++index];
    } else positional.push(item);
  }
  return { command, options, positional };
}

function timeout(value) {
  const milliseconds = value === undefined ? 180000 : Number(value);
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds < 1000 ||
    milliseconds > 3600000
  )
    throw new SetupError(
      "INVALID_ARGUMENT",
      "--timeout-ms must be an integer from 1000 to 3600000.",
    );
  return milliseconds;
}

function redactFailure(error, jobId, token, submissionKey) {
  const safe = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
    (!token || !value.includes(token))
      ? value
      : undefined;
  return {
    ok: false,
    code:
      safe(error?.code) ||
      (error?.name === "AbortError" ? "INTERRUPTED" : "CLIENT_ERROR"),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(safe(error?.requestId) ? { request_id: error.requestId } : {}),
    ...(safe(error?.jobId || jobId) ? { job_id: error.jobId || jobId } : {}),
    ...(safe(submissionKey || error?.idempotencyKey)
      ? { idempotency_key: submissionKey || error.idempotencyKey }
      : {}),
    ...(error instanceof SetupError
      ? { message: error.message }
      : {
          message:
            "The operation did not finish. Keep any accepted job ID; check your connection, key scopes, account limits and the API documentation before retrying.",
        }),
  };
}

async function responseJson(response, maxBytes = 1048576) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new SetupError(
      "INVALID_MCP_RESPONSE",
      "MCP returned an empty response.",
    );
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes)
        throw new SetupError(
          "INVALID_MCP_RESPONSE",
          "MCP response exceeded the connection-check size limit.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SetupError("INVALID_MCP_RESPONSE", "MCP returned invalid JSON.");
  }
}

/** Scope discovery is read-only; this never runs an analysis or sends support. */
export async function checkMcp({ apiUrl, token, fetchImpl = fetch, signal }) {
  let protocol = "2025-03-26";
  let sessionId;
  async function rpc(id, method, params) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(method !== "initialize" ? { "MCP-Protocol-Version": protocol } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    let response;
    try {
      response = await fetchImpl(apiUrl + "/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id === null ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      throw new SetupError(
        signal?.aborted ? "INTERRUPTED" : "MCP_UNREACHABLE",
        "MCP could not be reached. Check the configured origin and connectivity.",
      );
    }
    if (!response.ok) {
      const error = new SetupError(
        response.status === 401
          ? "UNAUTHORIZED"
          : response.status === 403
            ? "FORBIDDEN"
            : "MCP_HTTP_ERROR",
        "MCP rejected the connection check. Check the key, account verification and client transport.",
      );
      error.status = response.status;
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    sessionId = response.headers.get("Mcp-Session-Id") || sessionId;
    if (id === null) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await responseJson(response);
    if (body.jsonrpc !== "2.0" || body.id !== id || body.error || !body.result)
      throw new SetupError(
        "MCP_PROTOCOL_ERROR",
        "MCP did not return the expected connection-check result.",
      );
    return body.result;
  }
  const initialized = await rpc(1, "initialize", {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: "tldw-cli", version: "0.2.0" },
  });
  if (
    typeof initialized.protocolVersion !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(initialized.protocolVersion)
  )
    throw new SetupError(
      "MCP_PROTOCOL_ERROR",
      "MCP returned an invalid protocol version.",
    );
  protocol = initialized.protocolVersion;
  await rpc(null, "notifications/initialized");
  const listing = await rpc(2, "tools/list");
  if (!Array.isArray(listing.tools))
    throw new SetupError(
      "MCP_PROTOCOL_ERROR",
      "MCP returned an invalid tool listing.",
    );
  const expected = ["analyze_media", "get_job", "get_summary", "list_styles"];
  if (
    !expected.every((name) => listing.tools.some((tool) => tool.name === name))
  )
    throw new SetupError(
      "MCP_TOOLS_MISSING",
      "The endpoint does not expose the required tldw tools.",
    );
  const checked = await rpc(3, "tools/call", {
    name: "list_styles",
    arguments: {},
  });
  if (checked.isError)
    throw new SetupError(
      "MCP_CHECK_FAILED",
      "The read-only MCP connection check was rejected.",
    );
  return {
    connected: true,
    protocol,
    tools_available: listing.tools.length,
    required_tools_present: true,
    read_only_check: "list_styles",
  };
}

export async function runCli(
  argv,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
    clientFactory,
    signal,
  } = {},
) {
  let jobId;
  let token;
  let submissionKey;
  const event = (value) =>
    stderr.write(
      JSON.stringify(value, (_name, item) =>
        typeof item === "string" && token
          ? item.replaceAll(token, "[REDACTED]")
          : item,
      ) + "\n",
    );
  try {
    if (!argv.length || ["help", "--help", "-h"].includes(argv[0])) {
      stdout.write(HELP);
      return 0;
    }
    const { command, options, positional } = parseArguments([...argv]);
    if (!["init", "doctor", "analyze", "wait"].includes(command))
      throw new SetupError(
        "INVALID_ARGUMENT",
        "Choose init, doctor, analyze or wait. Run tldw --help.",
      );
    const origin = validateOrigin(options["api-url"] || env.TLDW_API_URL);
    if (options.local && !isLoopback(new URL(origin).hostname))
      throw new SetupError(
        "LOCAL_ONLY",
        "--local is limited to loopback development origins.",
      );
    if (command === "init") {
      if (
        positional.length ||
        Object.keys(options).some(
          (key) => !["api-url", "web-url", "dir"].includes(key),
        )
      )
        throw new SetupError(
          "INVALID_ARGUMENT",
          "init accepts only --api-url, --web-url and --dir.",
        );
      const result = await installPlugin({
        apiUrl: origin,
        directory: options.dir,
        webUrl: options["web-url"],
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    const allowed =
      command === "doctor"
        ? ["api-url", "local"]
        : command === "wait"
          ? ["api-url", "local", "timeout-ms"]
          : [
              "api-url",
              "local",
              "timeout-ms",
              "media",
              "file",
              "instructions",
              "idempotency-key",
              "transcription",
              "max-credits",
              "force-asr",
            ];
    if (
      Object.keys(options).some((key) => !allowed.includes(key)) ||
      (command === "wait" ? positional.length !== 1 : positional.length)
    )
      throw new SetupError(
        "INVALID_ARGUMENT",
        "The command has unsupported arguments. Run tldw --help.",
      );
    token = options.local ? undefined : env.TLDW_API_TOKEN;
    if (!token && !options.local)
      throw new SetupError(
        "TOKEN_REQUIRED",
        "Set TLDW_API_TOKEN privately, or use --local for explicitly enabled anonymous loopback development.",
      );
    if (token && (token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(token)))
      throw new SetupError(
        "INVALID_TOKEN",
        "TLDW_API_TOKEN has an invalid format.",
      );
    const Client = clientFactory || (await import("./index.mjs")).TldwClient;
    const client = new Client({
      apiUrl: origin,
      token,
      allowAnonymous: !!options.local,
      fetch: fetchImpl,
    });
    if (command === "doctor") {
      let account;
      try {
        const me = await client.getUsage();
        const available =
          me?.usage?.total_minutes_available ?? me?.usage?.minutes_remaining;
        account = {
          available: true,
          plan: ["free", "hobby", "pro", "business"].includes(me?.plan?.tier)
            ? me.plan.tier
            : "unknown",
          minutes_available:
            typeof available === "number" &&
            Number.isFinite(available) &&
            available >= 0
              ? available
              : null,
        };
      } catch (error) {
        if (error?.status !== 403) throw error;
        account = {
          available: false,
          reason: "account:read is optional; add it to read account usage.",
        };
      }
      const mcp = await checkMcp({ apiUrl: origin, token, fetchImpl, signal });
      stdout.write(
        JSON.stringify(
          {
            ok: true,
            api_url: origin,
            mcp,
            account,
            processing_submitted: false,
            analyses_consumed: 0,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const timeoutMs = timeout(options["timeout-ms"]);
    if (command === "wait") jobId = positional[0];
    else {
      if (!!options.media === !!options.file)
        throw new SetupError(
          "INVALID_ARGUMENT",
          "analyze needs exactly one --media or --file.",
        );
      let media = options.media;
      if (options.file) {
        const info = await lstat(options.file);
        if (!info.isFile() || info.size > 1024 * 1024)
          throw new SetupError(
            "INVALID_ARGUMENT",
            "Source files must be regular files up to 1 MiB; the server may enforce a lower source limit.",
          );
        const bytes = await readFile(options.file);
        if (bytes.length > 1024 * 1024)
          throw new SetupError(
            "INVALID_ARGUMENT",
            "Source files must not exceed 1 MiB; the server may enforce a lower source limit.",
          );
        try {
          media = {
            type: "text",
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          };
        } catch {
          throw new SetupError(
            "INVALID_ARGUMENT",
            "The source file must be UTF-8 text.",
          );
        }
      }
      const candidateKey = options["idempotency-key"] ?? makeIdempotencyKey();
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(candidateKey) ||
        (token && candidateKey.includes(token))
      )
        throw new SetupError(
          "INVALID_IDEMPOTENCY_KEY",
          "Use a non-secret idempotency key of 1–128 letters, digits, dots, underscores, colons or hyphens. Never use an API token as an idempotency key.",
        );
      submissionKey = candidateKey;
      // Print before POST: an accepted request whose reply is lost must remain
      // safely replayable with the exact media, instructions and stable key.
      event({ event: "submission", idempotency_key: submissionKey });
      const receipt = await client.submitAnalysis(media, {
        instructions: options.instructions,
        idempotencyKey: submissionKey,
        signal,
        ...(options.transcription
          ? { transcription: options.transcription }
          : {}),
        ...(options["max-credits"]
          ? { maxCredits: options["max-credits"] }
          : {}),
        ...(options["force-asr"] ? { forceAsr: true } : {}),
      });
      jobId = receipt.job_id;
      event({
        accepted: true,
        job_id: jobId,
        status_url: "/v1/jobs/" + jobId,
        idempotency_key: submissionKey,
      });
    }
    const job = await client.waitForJob(jobId, {
      timeoutMs,
      signal,
      onProgress: (value) =>
        event({
          job_id: jobId,
          status: value.status,
          progress: value.progress,
        }),
    });
    const summary = await client.getSummary(job.summary_id, { signal });
    stdout.write(JSON.stringify({ job, summary }, null, 2) + "\n");
    return 0;
  } catch (error) {
    const result = redactFailure(error, jobId, token, submissionKey);
    if (signal?.aborted) result.code = "INTERRUPTED";
    event(result);
    return result.code === "INTERRUPTED" ? 130 : 1;
  }
}

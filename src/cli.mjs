/**
 * The `tldw` command-line tool shipped in @tldw/client. bin/tldw.mjs is the
 * executable wrapper; runCli() below does the work and is exported for tests
 * and embedding.
 *
 * Commands (`tldw --help` prints the full usage):
 *   init     Copy the bundled agent plugin into a new directory configured
 *            for an API origin (see install.mjs). Sends no request.
 *   doctor   Check an API key's REST and MCP access without creating a job.
 *   search   Search X posts with video (uses one of the plan's searches).
 *   analyze  Submit media, wait for the job, then print job and summary.
 *   extract  Like analyze, but print the saved original transcript.
 *   wait     Resume waiting on an accepted job by its ID.
 *
 * Output contract: the final result is pretty-printed JSON on stdout.
 * Events are JSON lines on stderr: the idempotency key just before a
 * submission is sent, the accepted job ID, progress while waiting, and any
 * failure. A wrapper can therefore save the job ID and resume with `wait`
 * even if this process dies. Exit codes: 0 success, 1 failure, 130
 * interrupted.
 *
 * Credentials: the API key is read only from TLDW_API_TOKEN, never from
 * arguments or files, and is redacted from everything written to stderr.
 * Failure events copy only codes and identifiers that match strict patterns,
 * never server-provided messages.
 */
import { lstat, readFile } from "node:fs/promises";
import { DEFAULT_API_URL } from "./index.mjs";
import {
  installPlugin,
  isLoopback,
  makeIdempotencyKey,
  SetupError,
  validateOrigin,
} from "./install.mjs";

// Printed for no arguments, `help`, `--help` or `-h` (first argument only).
// The plan and credit figures are static copy: update them with pricing.
const HELP = `tldw — connect agents to the tldw.sh API

init [--api-url ORIGIN] [--web-url ORIGIN] [--dir ./tldw-agent-plugin]
  Prepare a new configured plugin directory. Never writes a key or global settings.
doctor [--api-url ORIGIN] [--local]
  Check API-key REST/MCP access with TLDW_API_TOKEN without creating a job.
  Browser OAuth sessions in other clients are separate from this CLI.
search QUERY [--api-url ORIGIN] [--sort top|latest] [--limit 20] [--json] [--local]
  Search X posts with video: one page of up to 20, no next page. Prints length, views,
  author and link per result, or the full response with --json. Pass a link to analyze --media.
  Each new search uses one of your plan's monthly searches, and the count resets each billing
  period. The same search within 15 minutes does not count.
analyze [--api-url ORIGIN] (--media URL_OR_TEXT | --file PATH) [--instructions TEXT]
        [--transcription auto|never|if_needed] [--max-credits DECIMAL] [--force-asr] [--refresh-source]
        [--idempotency-key KEY] [--timeout-ms 180000] [--local]
  Analyze a YouTube/public X link or source text once, preserve the job ID,
  poll, and fetch the result.
  A non-secret idempotency key is printed before POST. If the reply is lost,
  replay the exact media/instructions/options with that --idempotency-key.
extract [--api-url ORIGIN] (--media URL_OR_TEXT | --file PATH)
        [--transcription auto|never|if_needed] [--max-credits DECIMAL] [--force-asr] [--refresh-source]
        [--idempotency-key KEY] [--timeout-ms 180000] [--offset 0] [--limit 100] [--local]
  Analyze once, wait, then retrieve the saved original transcript separately.
  This generates an analysis and uses normal processing credits.
  Omit offset/limit for the full source; either flag selects a bounded page.
transcript TRANSCRIPT_ID [--api-url ORIGIN] [--offset 0] [--limit 100] [--local]
  Read one saved source page without submitting or charging for processing.
  Continue from next_offset until null; reads never change read/unread state.
wait JOB_ID [--api-url ORIGIN] [--timeout-ms 180000] [--local]
  Resume a durable job. A wait timeout or Ctrl-C does not cancel server work.

The API defaults to https://api.tldw.sh; TLDW_API_URL or --api-url overrides it.
Set TLDW_API_TOKEN privately. --transcription may be omitted: the server decides (auto).
Tokens are never accepted as command arguments or saved by this tool.
--local explicitly permits anonymous HTTP/HTTPS loopback development only.
Launch offers: Free includes 100 monthly caption/text credits; Hobby USD20/1000.
Existing Pro subscriptions retain their account limits; Pro has no new checkout.
Captions/text or cached transcripts cost 1 credit/minute; fresh ASR costs 3.
Audio transcription depends on account and platform access. --force-asr requires explicit --transcription if_needed. --max-credits caps a job; the server enforces the current credit policy.
Included credits reset monthly. Manage purchases and subscriptions in Billing.
Re-asking a saved source is free; refreshing or transcribing a source can use credits.
X post and X Article sources may reuse a saved snapshot for 24 hours; --refresh-source fetches current content without forcing ASR.
`;

/**
 * Split CLI arguments into the command, options and positional arguments.
 *
 * Only `--name value` pairs for known valued options and the bare flags
 * --local, --force-asr, --refresh-source and --json are accepted.
 * `--name=value`, unknown or repeated options and values that start with
 * "--" are rejected; anything else is positional. Which options a command
 * allows is checked later, in runCli().
 *
 * @param {string[]} args Arguments after the executable; mutated (the
 *   command is shifted off), so callers pass a copy.
 * @returns {{ command: string|undefined, options: Record<string, string|true>, positional: string[] }}
 * @throws {SetupError} INVALID_ARGUMENT
 */
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
    "sort",
    "limit",
    "offset",
  ]);
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (
      ["--local", "--force-asr", "--refresh-source", "--json"].includes(item)
    ) {
      const flag = item.slice(2);
      if (options[flag])
        throw new SetupError("INVALID_ARGUMENT", `Duplicate ${item} flag.`);
      options[flag] = true;
    } else if (item.startsWith("--")) {
      const key = item.slice(2);
      // The value must exist and must not look like another option.
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

// Parse --timeout-ms: an integer from 1000 to 3600000 (one hour); the default
// is 180000 (three minutes).
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

// Format a server count such as 12345 as "12,345"; anything that is not a
// non-negative safe integer prints as "?".
function thousands(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-US")
    : "?";
}

// Format a duration in seconds as m:ss or h:mm:ss; "?" when unknown.
function videoLength(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return "?";
  const two = (value) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours
    ? `${hours}:${two(minutes)}:${two(seconds % 60)}`
    : `${minutes}:${two(seconds % 60)}`;
}

// Unlike JSON output, this view prints server strings raw: drop control and bidi characters.
// (\p{Cc} covers control characters such as ESC; \p{Cf} covers format
// characters, including bidirectional overrides that could disguise a link.)
function plain(value) {
  return typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, "")
    : "?";
}

/**
 * One line per result (length | views | author | link), then the period's search count.
 *
 * For example: `12:04 | 98,000 views | @someone | https://x.com/...`, with
 * "too long for your plan" appended when the video exceeds the plan's
 * duration limit. Columns are padded to line up.
 *
 * @param {VideoSearchResponse} response The searchVideos() result.
 * @returns {string} Newline-terminated text.
 */
function searchReport({ results, usage, replayed }) {
  const cells = results.map((result) => [
    videoLength(result.video?.duration_seconds),
    `${thousands(result.metrics?.views)} views`,
    typeof result.author?.username === "string"
      ? "@" + plain(result.author.username)
      : "?",
  ]);
  const widths = [0, 1, 2].map((column) =>
    Math.max(0, ...cells.map((row) => row[column].length)),
  );
  const lines = results.map((result, index) => {
    const [length, views, author] = cells[index];
    return [
      length.padStart(widths[0]),
      views.padStart(widths[1]),
      author.padEnd(widths[2]),
      plain(result.url),
      ...(result.video?.over_plan_limit === true
        ? ["too long for your plan"]
        : []),
    ].join(" | ");
  });
  if (!lines.length) lines.push("No videos found.");
  if (replayed === true)
    lines.push("This repeats a recent search, so it did not count.");
  lines.push(
    `${thousands(usage.searches_used)} of ${thousands(usage.searches_limit)} searches used this period.`,
  );
  return lines.join("\n") + "\n";
}

// A search creates no job, so its failures get their own advice.
// The upgrade link from the API is shown only when it is a plain, bounded
// https URL that does not contain the token.
function searchFailure(error, token) {
  if (error?.code === "SEARCH_QUOTA_EXCEEDED") {
    const url = error.details?.upgrade?.billing_url;
    const link =
      typeof url === "string" &&
      url.length <= 2048 &&
      /^https:\/\/[\x21-\x7e]+$/.test(url) &&
      (!token || !url.includes(token))
        ? ` Upgrade: ${url}`
        : "";
    return "No X searches left this period." + link;
  }
  if (error?.code === "FEATURE_DISABLED")
    return "X video search is not enabled.";
  return "The search did not finish. Check your connection, key scopes and account limits before retrying.";
}

/**
 * Build the JSON failure event written to stderr.
 *
 * Only values that match a strict identifier pattern and do not contain the
 * token are copied from the error: code, HTTP status, request ID, job ID and
 * idempotency key. The message is the CLI's own text for setup and argument
 * errors and a fixed recovery hint otherwise, so server-provided text never
 * reaches the terminal.
 *
 * @param {unknown} error The caught error.
 * @param {string} [jobId] Accepted job ID, when one exists.
 * @param {string} [token] API key, kept out of every copied value.
 * @param {string} [submissionKey] Idempotency key of a POST that was sent.
 * @param {boolean} [searching=false] Use search-specific advice.
 * @returns {{ ok: false, code: string, status?: number, request_id?: string, job_id?: string, idempotency_key?: string, message: string }}
 */
function redactFailure(error, jobId, token, submissionKey, searching = false) {
  const safe = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
    (!token || !value.includes(token))
      ? value
      : undefined;
  // The SDK raises TypeError only for invalid caller input, with static messages.
  const invalidInput =
    error instanceof TypeError &&
    typeof error.message === "string" &&
    error.message.length <= 300 &&
    (!token || !error.message.includes(token));
  return {
    ok: false,
    // An AbortError DOMException has a numeric `code`, which safe() rejects,
    // so it falls through to INTERRUPTED.
    code: invalidInput
      ? "INVALID_ARGUMENT"
      : safe(error?.code) ||
        (error?.name === "AbortError" ? "INTERRUPTED" : "CLIENT_ERROR"),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(safe(error?.requestId) ? { request_id: error.requestId } : {}),
    ...(safe(error?.jobId || jobId) ? { job_id: error.jobId || jobId } : {}),
    ...(safe(submissionKey || error?.idempotencyKey)
      ? { idempotency_key: submissionKey || error.idempotencyKey }
      : {}),
    ...(error instanceof SetupError || invalidInput
      ? { message: error.message }
      : {
          message: searching
            ? searchFailure(error, token)
            : "The operation did not finish. Keep any accepted job ID; check your connection, key scopes, account limits and the API documentation before retrying.",
        }),
  };
}

// Read a JSON response body from the MCP endpoint, refusing more than
// `maxBytes` (1 MiB by default). The reader is always canceled afterwards,
// which releases the connection.
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

/**
 * Scope discovery is read-only; this never runs an analysis or sends support.
 *
 * Performs the MCP Streamable HTTP handshake against `${apiUrl}/mcp`
 * (initialize, the initialized notification, tools/list), requires the
 * analyze_media, get_job and get_summary tools, then makes one read-only
 * tool call: account_usage, or list_jobs for a key without account:read.
 * Responses must be plain JSON; an event-stream reply is reported as
 * INVALID_MCP_RESPONSE.
 *
 * @param {object} options
 * @param {string} options.apiUrl Validated API origin (no trailing slash).
 * @param {string} [options.token] API key; omitted for --local checks.
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ connected: true, protocol: string, tools_available: number, required_tools_present: true, read_only_check: string }>}
 * @throws {SetupError} MCP_UNREACHABLE, INTERRUPTED, UNAUTHORIZED, FORBIDDEN,
 *   MCP_HTTP_ERROR, INVALID_MCP_RESPONSE, MCP_PROTOCOL_ERROR,
 *   MCP_TOOLS_MISSING or MCP_CHECK_FAILED.
 */
export async function checkMcp({ apiUrl, token, fetchImpl = fetch, signal }) {
  // Requested at initialize; replaced by the version the server negotiates.
  let protocol = "2025-03-26";
  let sessionId;
  // Send one JSON-RPC message. `id === null` sends a notification: no id in
  // the message, and the response body is discarded.
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
        // A redirect fails the request, so the token never reaches another host.
        redirect: "error",
        // Bound each call to 30 s, and stop early when the caller aborts.
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
    // Echo the session the server assigned (if any) on every later message.
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
    clientInfo: { name: "tldw-cli", version: "0.2.11" },
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
  const listed = new Set(listing.tools.map((tool) => tool?.name));
  const expected = ["analyze_media", "get_job", "get_summary"];
  if (!expected.every((name) => listed.has(name)))
    throw new SetupError(
      "MCP_TOOLS_MISSING",
      "The endpoint does not expose the required tldw tools.",
    );
  // account_usage needs account:read; an analysis-only key falls back to
  // list_jobs. Both are read-only and submit nothing.
  const candidates = [
    ["account_usage", {}],
    ["list_jobs", { limit: 1 }],
  ].filter(([name]) => listed.has(name));
  let readOnlyCheck = null;
  let id = 3;
  for (const [name, args] of candidates) {
    const checked = await rpc(id++, "tools/call", { name, arguments: args });
    if (!checked.isError) {
      readOnlyCheck = name;
      break;
    }
  }
  if (!readOnlyCheck)
    throw new SetupError(
      "MCP_CHECK_FAILED",
      "The read-only MCP connection check was rejected.",
    );
  return {
    connected: true,
    protocol,
    tools_available: listing.tools.length,
    required_tools_present: true,
    read_only_check: readOnlyCheck,
  };
}

/**
 * Run the tldw CLI and return its exit code; never throws.
 *
 * @param {string[]} argv Arguments after the executable, for example
 *   `["wait", jobId, "--timeout-ms", "600000"]`.
 * @param {object} [io] Injection points, mainly for tests.
 * @param {Record<string, string|undefined>} [io.env=process.env] Source of
 *   TLDW_API_URL and TLDW_API_TOKEN.
 * @param {{ write(text: string): unknown }} [io.stdout=process.stdout]
 *   Receives help or the final JSON result.
 * @param {{ write(text: string): unknown }} [io.stderr=process.stderr]
 *   Receives JSON-line events and the failure event.
 * @param {typeof fetch} [io.fetchImpl=globalThis.fetch]
 * @param {Function} [io.clientFactory] Replaces the TldwClient class.
 * @param {AbortSignal} [io.signal] Interrupts the command (exit code 130).
 *   Server work that was already accepted keeps running.
 * @returns {Promise<number>} 0 on success, 1 on failure, 130 when
 *   interrupted.
 */
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
  let searching = false;
  // Idempotency key of a submission that was actually sent.
  let submissionKey;
  // Set once arguments validate; announced only when the POST is really sent.
  let pendingKey;
  // Write one JSON event line to stderr, redacting the token from every
  // string in it.
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
    if (
      ![
        "init",
        "doctor",
        "search",
        "analyze",
        "extract",
        "transcript",
        "wait",
      ].includes(command)
    )
      throw new SetupError(
        "INVALID_ARGUMENT",
        "Choose init, doctor, search, analyze, extract, transcript or wait. Run tldw --help.",
      );
    // --api-url wins over TLDW_API_URL, which wins over the default.
    const origin = validateOrigin(
      options["api-url"] || env.TLDW_API_URL || DEFAULT_API_URL,
    );
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
      // init only writes local files. The onboarding link defaults to the
      // public site only for the production API; other deployments need
      // --web-url.
      const result = await installPlugin({
        apiUrl: origin,
        directory: options.dir,
        webUrl:
          options["web-url"] ||
          (origin === DEFAULT_API_URL ? "https://tldw.sh" : undefined),
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    // Options each remaining command accepts.
    const allowed =
      command === "doctor"
        ? ["api-url", "local"]
        : command === "wait"
          ? ["api-url", "local", "timeout-ms"]
          : command === "search"
            ? ["api-url", "local", "sort", "limit", "json"]
            : command === "transcript"
              ? ["api-url", "local", "offset", "limit"]
              : [
                  "api-url",
                  "local",
                  "timeout-ms",
                  "media",
                  "file",
                  ...(command === "analyze" ? ["instructions"] : []),
                  ...(command === "extract" ? ["offset", "limit"] : []),
                  "idempotency-key",
                  "transcription",
                  "max-credits",
                  "force-asr",
                  "refresh-source",
                ];
    // Read/resume/search commands take exactly one positional; the
    // others take none.
    if (
      Object.keys(options).some((key) => !allowed.includes(key)) ||
      (["wait", "search", "transcript"].includes(command)
        ? positional.length !== 1
        : positional.length)
    )
      throw new SetupError(
        "INVALID_ARGUMENT",
        "The command has unsupported arguments. Run tldw --help.",
      );
    const transcriptPage =
      command === "transcript" ||
      (command === "extract" &&
        (options.offset !== undefined || options.limit !== undefined))
        ? {
            offset: Number(options.offset ?? 0),
            limit: Number(options.limit ?? 100),
          }
        : null;
    if (
      transcriptPage &&
      (!Number.isInteger(transcriptPage.offset) ||
        transcriptPage.offset < 0 ||
        transcriptPage.offset > 1_000_000_000 ||
        !Number.isInteger(transcriptPage.limit) ||
        transcriptPage.limit < 1 ||
        transcriptPage.limit > 500)
    )
      throw new SetupError(
        "INVALID_ARGUMENT",
        "Use offset 0-1000000000 and limit 1-500.",
      );
    // --local never sends the token, even when one is set.
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
      // Print the idempotency key immediately before the first POST: an accepted
      // request whose reply is lost stays replayable, and a request rejected by
      // local validation never prints a key for a submission that was not sent.
      fetch: (url, init) => {
        if (pendingKey && init?.method === "POST" && !submissionKey) {
          submissionKey = pendingKey;
          event({ event: "submission", idempotency_key: submissionKey });
        }
        return fetchImpl(url, init);
      },
    });
    if (command === "doctor") {
      let account;
      try {
        // Prefer total_minutes_available and fall back to minutes_remaining.
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
        // 403: the key lacks the optional account:read scope. Report it and
        // continue with the MCP check; anything else is a real failure.
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
    if (command === "search") {
      searching = true;
      const found = await client.searchVideos(positional[0], {
        sort: options.sort,
        limit: options.limit === undefined ? undefined : Number(options.limit),
        signal,
      });
      stdout.write(
        options.json
          ? JSON.stringify(found, null, 2) + "\n"
          : searchReport(found),
      );
      return 0;
    }
    if (command === "transcript") {
      const page = await client.getSavedTranscriptPage(positional[0], {
        ...transcriptPage,
        signal,
      });
      stdout.write(JSON.stringify(page, null, 2) + "\n");
      return 0;
    }
    const timeoutMs = timeout(options["timeout-ms"]);
    if (command === "wait") jobId = positional[0];
    else {
      // analyze or extract: submit first, then fall through to the wait.
      if (!!options.media === !!options.file)
        throw new SetupError(
          "INVALID_ARGUMENT",
          `${command} needs exactly one --media or --file.`,
        );
      let media = options.media;
      if (options.file) {
        // lstat refuses symlinks and non-regular files. The size is checked
        // again after reading in case the file grew in between.
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
      // Keys are limited to a conservative character set (stricter than the
      // API's) so they are safe to print and to paste into a shell.
      const candidateKey = options["idempotency-key"] ?? makeIdempotencyKey();
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(candidateKey) ||
        (token && candidateKey.includes(token))
      )
        throw new SetupError(
          "INVALID_IDEMPOTENCY_KEY",
          "Use a non-secret idempotency key of 1–128 letters, digits, dots, underscores, colons or hyphens. Never use an API token as an idempotency key.",
        );
      pendingKey = candidateKey;
      const receipt = await client.submitAnalysis(media, {
        ...(command === "analyze"
          ? { instructions: options.instructions }
          : {}),
        idempotencyKey: pendingKey,
        signal,
        ...(options.transcription
          ? { transcription: options.transcription }
          : {}),
        ...(options["max-credits"]
          ? { maxCredits: options["max-credits"] }
          : {}),
        ...(options["force-asr"] ? { forceAsr: true } : {}),
        ...(options["refresh-source"] ? { refreshSource: true } : {}),
      });
      jobId = receipt.job_id;
      // An accepted receipt proves the request was sent.
      submissionKey = pendingKey;
      event({
        accepted: true,
        job_id: jobId,
        status_url: "/v1/jobs/" + jobId,
        idempotency_key: submissionKey,
      });
    }
    // waitForJob validates the ID (a UUID) for `wait`.
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
    if (command === "extract" && job.output_mode === "transcript")
      throw new SetupError(
        "INVALID_RESPONSE",
        "Expected an analysis result, received a transcript job.",
      );
    // A transcript-mode job's result is its saved transcript. extract reads
    // the source behind the analysis; analyze and wait read the summary.
    const output =
      job.output_mode === "transcript"
        ? {
            transcript: await client.getSavedTranscript(job.transcript_id, {
              signal,
            }),
          }
        : command === "extract"
          ? {
              transcript: transcriptPage
                ? await client.getTranscriptPage(job.summary_id, {
                    ...transcriptPage,
                    signal,
                  })
                : await client.getTranscript(job.summary_id, { signal }),
              job_id: job.id,
              summary_id: job.summary_id,
            }
          : { summary: await client.getSummary(job.summary_id, { signal }) };
    stdout.write(
      JSON.stringify(
        command === "extract" ? output : { job, ...output },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } catch (error) {
    const result = redactFailure(error, jobId, token, submissionKey, searching);
    if (signal?.aborted) result.code = "INTERRUPTED";
    event(result);
    // 130 is the conventional exit status for a SIGINT interruption.
    return result.code === "INTERRUPTED" ? 130 : 1;
  }
}

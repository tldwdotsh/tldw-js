#!/usr/bin/env node
// Executable for the `tldw` command (the "bin" entry of @tldw/client). All
// logic lives in src/cli.mjs; run `tldw --help` for usage.
import { runCli } from "../src/cli.mjs";

// The first Ctrl-C aborts the running command: waiting stops, the CLI prints
// the job ID (or the submission's idempotency key) needed to resume, and
// exits with 130. Server work keeps running.
// The handler is registered once, so a second Ctrl-C uses Node's default and
// exits immediately.
const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new DOMException("Interrupted", "AbortError")));
// Set the exit code instead of calling process.exit(), so pending stdout and
// stderr writes are flushed before Node exits.
process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });

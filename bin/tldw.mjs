#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new DOMException("Interrupted", "AbortError")));
process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });

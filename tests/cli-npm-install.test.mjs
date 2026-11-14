import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const source = resolve(import.meta.dirname, "..");

test(
  "npm exec installs the real tarball and initializes a standalone plugin offline",
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tldw-npm-exec-test-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    for (const name of [
      "package.json",
      "LICENSE",
      "README.md",
      "src",
      "bin",
      "plugin",
    ])
      await cp(join(source, name), join(packageRoot, name), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    const packed = await execute(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--no-update-notifier",
        "--pack-destination",
        root,
      ],
      { cwd: packageRoot },
    );
    const archive = join(root, JSON.parse(packed.stdout)[0].filename);
    const result = await execute(
      "npm",
      [
        "exec",
        "--offline",
        "--no-update-notifier",
        "--yes",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(root, "cache"),
        "--package",
        archive,
        "--",
        "tldw",
        "init",
        "--api-url",
        "https://api.operator.test",
        "--web-url",
        "https://app.operator.test",
        "--dir",
        join(root, "installed"),
      ],
      {
        cwd: root,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TLDW_API_TOKEN: "fixture-no-real-key" },
      },
    );
    const initialized = JSON.parse(result.stdout);
    assert.equal(initialized.ok, true);
    assert.equal(initialized.credentials_saved, false);
    assert.equal(initialized.global_settings_changed, false);
    assert.equal(
      initialized.onboarding_url,
      "https://app.operator.test/agents",
    );
    assert(!result.stdout.includes("fixture-no-real-key"));
    const config = JSON.parse(
      await readFile(join(root, "installed", "codex.mcp.json"), "utf8"),
    );
    assert.equal(config.mcpServers.tldw.url, "https://api.operator.test/mcp");
    assert.equal(config.mcpServers.tldw.bearer_token_env_var, "TLDW_API_TOKEN");
    assert.equal(
      await readFile(join(root, "installed", ".gitignore"), "utf8"),
      await readFile(join(source, "plugin", ".gitignore"), "utf8"),
    );
  },
);

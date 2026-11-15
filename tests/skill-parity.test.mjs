import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { installPlugin } from "../src/install.mjs";

const exec = promisify(execFile);

test("configured bundles preserve canonical skill bytes during custom-origin CLI init", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "tldw-skill-parity-")),
  );
  try {
    const bundle = join(temp, "package");
    await cp(new URL("../src", import.meta.url), join(bundle, "src"), {
      recursive: true,
    });
    await cp(new URL("../bin", import.meta.url), join(bundle, "bin"), {
      recursive: true,
    });
    await installPlugin({
      apiUrl: "https://api.tldw.sh",
      directory: join(bundle, "plugin"),
    });
    const target = join(temp, "configured");
    await exec(
      process.execPath,
      [
        join(bundle, "bin/tldw.mjs"),
        "init",
        "--api-url",
        "http://localhost:9876",
        "--dir",
        target,
      ],
      {
        env: { ...process.env, TLDW_API_TOKEN: "" },
        timeout: 15_000,
      },
    );
    const build = JSON.parse(
      await readFile(join(bundle, "plugin/BUILD.json"), "utf8"),
    );
    const names = Object.keys(build.sha256).filter((name) =>
      name.startsWith("skills/tldw/"),
    );
    for (const name of names) {
      assert.deepEqual(
        await readFile(join(target, name)),
        await readFile(join(bundle, "plugin", name)),
      );
    }
    assert.equal(names.length, 8);
    const config = JSON.parse(
      await readFile(join(target, ".mcp.json"), "utf8"),
    );
    assert.equal(config.mcpServers.tldw.url, "http://localhost:9876/mcp");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

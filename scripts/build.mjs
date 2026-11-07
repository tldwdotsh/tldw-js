import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
mkdirSync(destination, { recursive: true });
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", destination], {cwd: root, encoding: "utf8"}));
const bytes = readFileSync(resolve(destination, packed.filename));
const manifest = {name: packed.name, version: packed.version, file: packed.filename,
  sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  registry_published: false, credentials_included: false};
writeFileSync(resolve(destination, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));

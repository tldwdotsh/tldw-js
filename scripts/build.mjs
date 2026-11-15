// Release build for the exported tldw-js repository, run with `npm run build`
// (the export sets package.json's "build" script to `node scripts/build.mjs`).
//
// Packs the package with `npm pack` (offline, without lifecycle scripts) into
// dist/, then writes dist/release-manifest.json with the tarball's name,
// version, file name, SHA-256 and size, and prints the manifest. Nothing is
// published and no credentials are read. Requires Node.js 20.11 or newer
// (import.meta.dirname).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// This file lives in scripts/, so the package root is one level up.
const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
mkdirSync(destination, { recursive: true });
// `npm pack --json` prints an array with one entry per packed package.
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", destination], {cwd: root, encoding: "utf8"}));
const bytes = readFileSync(resolve(destination, packed.filename));
const manifest = {name: packed.name, version: packed.version, file: packed.filename,
  sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  registry_published: false, credentials_included: false};
writeFileSync(resolve(destination, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));

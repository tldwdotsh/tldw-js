import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PLACEHOLDER = "https://api.tldw.invalid";
const SECRET_PATTERNS = [
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /(?:tldw|yta)_[A-Za-z0-9_-]{32,}/,
  /dev_admin_[A-Za-z0-9_-]{32,}/,
  /gsk_[A-Za-z0-9]{32,}/,
  /xai-[A-Za-z0-9_-]{32,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

export function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

/** An origin is configuration, never a capability URL carrying credentials. */
export function validateOrigin(value) {
  let url;
  try {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 2048 ||
      /[\s\\?#]/.test(value)
    )
      throw new Error();
    url = new URL(value);
    if (
      url.username ||
      url.password ||
      !url.hostname ||
      !["", "/"].includes(url.pathname) ||
      url.port === "0"
    )
      throw new Error();
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname))
    )
      throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      !isIP(host) &&
      (host.length > 253 ||
        !host
          .split(".")
          .every((part) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part),
          ))
    )
      throw new Error();
  } catch {
    throw new SetupError(
      "INVALID_ORIGIN",
      "Use an HTTPS origin with no path, credentials, query or fragment; HTTP is allowed only on loopback.",
    );
  }
  return url.origin;
}

async function assertRealDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute
    .slice(current.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new SetupError(
        "UNSAFE_DIRECTORY",
        "Installation parents must be existing directories without symlinks.",
      );
  }
}

function safeRelative(name) {
  return (
    typeof name === "string" &&
    name.length < 512 &&
    name
      .split("/")
      .every(
        (part) =>
          part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part),
      ) &&
    !name.startsWith("/")
  );
}

async function reviewedTree(source) {
  await assertRealDirectory(source);
  const files = new Map();
  let total = 0;
  async function visit(parent, prefix = "") {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (
        !safeRelative(name) ||
        (entry.name.startsWith(".env") && entry.name !== ".env.example")
      )
        throw new SetupError(
          "INVALID_BUNDLE",
          "The bundled plugin contains an unsupported resource.",
        );
      const full = join(parent, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink())
        throw new SetupError(
          "INVALID_BUNDLE",
          "Plugin resources cannot be symlinks.",
        );
      if (info.isDirectory()) await visit(full, name + "/");
      else {
        if (!info.isFile() || info.size > MAX_FILE_BYTES)
          throw new SetupError(
            "INVALID_BUNDLE",
            "Plugin resources must be bounded regular files.",
          );
        const data = await readFile(full);
        total += data.length;
        if (total > MAX_TOTAL_BYTES)
          throw new SetupError(
            "INVALID_BUNDLE",
            "The bundled plugin exceeds its size limit.",
          );
        if (
          SECRET_PATTERNS.some((pattern) => pattern.test(data.toString("utf8")))
        )
          throw new SetupError(
            "INVALID_BUNDLE",
            "Possible credentials were detected in the bundled plugin.",
          );
        files.set(name, data);
      }
    }
  }
  await visit(source);
  let build;
  try {
    build = JSON.parse(files.get("BUILD.json").toString("utf8"));
  } catch {
    throw new SetupError(
      "INVALID_BUNDLE",
      "Plugin build metadata is missing or invalid.",
    );
  }
  if (
    build.format_version !== 1 ||
    build.name !== "tldw" ||
    !build.sha256 ||
    typeof build.sha256 !== "object"
  )
    throw new SetupError(
      "INVALID_BUNDLE",
      "The plugin build contract is unsupported.",
    );
  // npm's tar extractor renames .gitignore to .npmignore, including nested
  // plugin directories. Accept only that exact byte-for-byte reviewed alias,
  // then restore its original name in the prepared standalone plugin.
  if (
    !files.has(".gitignore") &&
    files.has(".npmignore") &&
    Object.hasOwn(build.sha256, ".gitignore") &&
    !Object.hasOwn(build.sha256, ".npmignore") &&
    createHash("sha256").update(files.get(".npmignore")).digest("hex") ===
      build.sha256[".gitignore"]
  ) {
    files.set(".gitignore", files.get(".npmignore"));
    files.delete(".npmignore");
  }
  // npm pack can omit ignore files entirely. Restore the fixed public template
  // only if its bytes match the plugin's independently reviewed manifest hash.
  if (
    !files.has(".gitignore") &&
    !files.has(".npmignore") &&
    typeof build.sha256[".gitignore"] === "string"
  ) {
    const template = await readFile(
      new URL("./plugin-gitignore.txt", import.meta.url),
    );
    if (
      createHash("sha256").update(template).digest("hex") ===
      build.sha256[".gitignore"]
    )
      files.set(".gitignore", template);
  }
  const managed = new Map(files);
  managed.delete("BUILD.json");
  if (Object.keys(build.sha256).length !== managed.size)
    throw new SetupError(
      "INVALID_BUNDLE",
      "Plugin resources differ from the reviewed manifest.",
    );
  for (const [name, data] of managed) {
    if (createHash("sha256").update(data).digest("hex") !== build.sha256[name])
      throw new SetupError(
        "INVALID_BUNDLE",
        "A bundled plugin resource failed its integrity check.",
      );
  }
  for (const name of [
    "README.md",
    ".mcp.json",
    "codex.mcp.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    if (!managed.has(name))
      throw new SetupError(
        "INVALID_BUNDLE",
        "A required plugin resource is missing.",
      );
  }
  validateOrigin(build.api_origin);
  return { files: managed, build };
}

/** Install to a new, private directory; leave native clients/global settings alone. */
export async function installPlugin({
  apiUrl,
  directory = "./tldw-agent-plugin",
  webUrl,
  source = fileURLToPath(new URL("../plugin", import.meta.url)),
}) {
  const origin = validateOrigin(apiUrl);
  const appOrigin = webUrl ? validateOrigin(webUrl) : null;
  const target = resolve(directory);
  const parent = dirname(target);
  try {
    await assertRealDirectory(parent);
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(
      "MISSING_PARENT",
      "Create the destination's parent directory before installing.",
    );
  }
  try {
    await lstat(target);
    throw new SetupError(
      "DESTINATION_EXISTS",
      "The destination already exists. Choose a new directory; existing files are never replaced.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { files, build } = await reviewedTree(source);
  const replacements = [...new Set([build.api_origin, PLACEHOLDER])];
  const rendered = new Map();
  for (const [name, bytes] of files) {
    let data = bytes;
    if (!IMAGE_EXTENSIONS.has(extname(name))) {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const old of replacements) text = text.split(old).join(origin);
      data = Buffer.from(text);
    }
    rendered.set(name, data);
  }
  const metadata = {
    ...build,
    api_origin: origin,
    endpoint_configured: true,
    local_development: isLoopback(new URL(origin).hostname),
    sha256: Object.fromEntries(
      [...rendered].map(([name, bytes]) => [
        name,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    ),
  };
  rendered.set(
    "BUILD.json",
    Buffer.from(JSON.stringify(metadata, null, 2) + "\n"),
  );
  const staging = await mkdtemp(join(parent, ".tldw-install-"));
  let reserved;
  try {
    for (const [name, data] of rendered) {
      const destination = join(staging, name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { flag: "wx", mode: 0o644 });
    }
    // mkdir is exclusive even for an existing empty directory or dangling symlink.
    await assertRealDirectory(parent);
    await mkdir(target, { mode: 0o700 });
    reserved = await lstat(target);
    if ((await readdir(target)).length)
      throw new SetupError(
        "DESTINATION_CHANGED",
        "The destination changed while preparing the plugin.",
      );
    const current = await lstat(target);
    if (
      current.ino !== reserved.ino ||
      current.dev !== reserved.dev ||
      current.isSymbolicLink()
    )
      throw new SetupError(
        "DESTINATION_CHANGED",
        "The destination changed while preparing the plugin.",
      );
    await rename(staging, target);
    reserved = null;
  } catch (error) {
    if (reserved) {
      const current = await lstat(target).catch(() => null);
      if (current?.ino === reserved.ino && current?.dev === reserved.dev)
        await rmdir(target).catch(() => {});
    }
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      throw new SetupError(
        "DESTINATION_EXISTS",
        "The destination already exists. Choose a new directory; existing files are never replaced.",
      );
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    ok: true,
    directory: target,
    api_url: origin,
    mcp_url: origin + "/mcp",
    plugin_version: build.version,
    files: rendered.size,
    credentials_saved: false,
    global_settings_changed: false,
    onboarding_url: appOrigin ? appOrigin + "/agents" : null,
    next_steps: [
      "Sign up in your operator's web app and complete its one-time human verification. Free includes 100 monthly caption/text credits; Hobby and Pro add paid allowances.",
      "Create a key with jobs:write, jobs:read and summaries:read; account:read is optional for usage. Keep it in TLDW_API_TOKEN or your client's secret store.",
      "Install the prepared directory through your client's plugin settings, or use the native commands below. No client command has been executed.",
      "Run doctor to check the connection without submitting an analysis. Captions/text and cached transcripts cost 1 credit/minute. Fresh ASR costs 3 and requires server-authorized access and transcription=if_needed. Ordinary paid accounts require max_credits; server-confirmed exempt accounts may omit it.",
    ],
    commands: {
      claude_code: [
        "claude plugin validate " + shellQuote(target),
        "claude --plugin-dir " + shellQuote(target),
      ],
      codex: [
        "codex plugin marketplace add " + shellQuote(target),
        "codex plugin add tldw@tldw",
      ],
      generic_mcp: {
        url: origin + "/mcp",
        authorization_env_var: "TLDW_API_TOKEN",
        transport: "streamable-http",
        configuration_note:
          "Connection values, not a universal client configuration schema. Use your client's supported secret-backed Authorization header.",
      },
    },
  };
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function makeIdempotencyKey() {
  return "tldw-cli-" + randomUUID();
}

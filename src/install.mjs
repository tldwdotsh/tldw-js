/**
 * `tldw init`: prepare a configured copy of the agent plugin bundled with
 * @tldw/client, plus small validation helpers shared with the CLI.
 *
 * The package ships the plugin in ../plugin together with BUILD.json, a
 * manifest of SHA-256 hashes recorded when the package was built.
 * installPlugin() re-reads that tree and refuses it unless every file is a
 * bounded regular file (no symlinks, no .env files, nothing that looks like a
 * credential) whose hash matches the manifest. It then writes the chosen API
 * origin into the text files (the skill files are copied byte for byte),
 * records fresh hashes, and moves the result into a directory that did not
 * exist before.
 *
 * Nothing here contacts the network, runs a client's install command,
 * changes global client settings or stores a key. The returned object lists
 * the command or configuration snippet to use for each supported agent
 * client; the user applies it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Size limits for the bundled plugin, matching the plugin's own validator
// (scripts/validate.py in the plugin).
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
// Reserved origin left in an unconfigured plugin; init replaces it.
const PLACEHOLDER = "https://api.tldw.invalid";
// Shapes of common secrets: payment-provider secret and restricted keys,
// sk- style model-provider keys, tldw API keys (current and retired
// prefixes), development admin tokens, Groq and xAI keys, and PEM private
// keys. A bundle containing any of them is refused. Keep in sync with
// SECRET_PATTERNS in the plugin's scripts/validate.py.
const SECRET_PATTERNS = [
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /(?:tldw|yta)_[A-Za-z0-9_-]{32,}/,
  /dev_admin_[A-Za-z0-9_-]{32,}/,
  /gsk_[A-Za-z0-9]{32,}/,
  /xai-[A-Za-z0-9_-]{32,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
// Binary assets: copied unchanged, never decoded or rewritten.
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * Error with a stable, machine-readable `code`, such as INVALID_ARGUMENT,
 * INVALID_ORIGIN, DESTINATION_EXISTS or INVALID_BUNDLE. The CLI prints the
 * message verbatim, so messages are fixed text and never include secrets or
 * server output.
 */
export class SetupError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

/**
 * Whether a URL hostname is a loopback address: localhost, ::1 (with or
 * without brackets) or anything in 127.0.0.0/8. This is broader than
 * TldwClient's own check, which accepts only localhost, 127.0.0.1 and [::1].
 *
 * @param {string} hostname For example `new URL(origin).hostname`.
 * @returns {boolean}
 */
export function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

/**
 * An origin is configuration, never a capability URL carrying credentials.
 *
 * Accepts `https://host[:port]` with an optional trailing slash, and plain
 * HTTP only on a loopback host. Rejects credentials, a path, query or
 * fragment, whitespace or backslashes, port 0, values over 2048 characters
 * and host names that are not valid DNS labels.
 *
 * @param {string} value
 * @returns {string} The normalized origin, for example "https://api.tldw.sh".
 * @throws {SetupError} INVALID_ORIGIN
 * @example
 * validateOrigin("https://api.tldw.sh/"); // => "https://api.tldw.sh"
 * validateOrigin("http://localhost:8000"); // => "http://localhost:8000"
 */
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
    // Host names (not IP literals) must be valid DNS labels.
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

// Require every component of `path`, from the filesystem root down, to be an
// existing real directory rather than a symlink, so a planted link cannot
// redirect where files are read or written. A missing component surfaces as
// the underlying ENOENT error, which callers translate. (On macOS, /tmp and
// /var are themselves symlinks; pass their /private/... paths instead.)
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

// A relative bundle path made only of [A-Za-z0-9_.-] segments, with no "." or
// ".." segment and fewer than 512 characters, so it cannot escape the target.
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

/**
 * Load the bundled plugin from `source` and verify it against its BUILD.json
 * manifest: safe names, no symlinks or private .env files, bounded regular
 * files, no likely credentials, exactly the files listed in the manifest
 * with matching SHA-256 hashes, the required entry points present and a
 * valid recorded origin.
 *
 * @param {string} source Plugin directory.
 * @returns {Promise<{ files: Map<string, Buffer>, build: object }>} The
 *   verified files (without BUILD.json) and the parsed manifest.
 * @throws {SetupError} INVALID_BUNDLE or UNSAFE_DIRECTORY.
 */
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
  // The tree must contain exactly the manifest's files, each with its
  // recorded hash: nothing added, nothing missing, nothing modified.
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

function sameEntry(current, expected) {
  return (
    current &&
    expected &&
    !current.isSymbolicLink() &&
    current.ino === expected.ino &&
    current.dev === expected.dev
  );
}

/** Windows cannot rename a directory over the reserved empty destination. */
async function publishReservedFiles(target, rendered, reserved) {
  const directories = new Map([[target, reserved]]);
  const files = new Map();
  async function assertOwnedDirectory(path) {
    const current = await lstat(path);
    if (!sameEntry(current, directories.get(path)) || !current.isDirectory())
      throw new SetupError(
        "DESTINATION_CHANGED",
        "The destination changed during installation.",
      );
  }
  try {
    for (const [name, data] of rendered) {
      await assertRealDirectory(dirname(target));
      await assertOwnedDirectory(target);
      let parent = target;
      for (const component of name.split("/").slice(0, -1)) {
        await assertOwnedDirectory(parent);
        parent = join(parent, component);
        if (!directories.has(parent)) {
          await mkdir(parent, { mode: 0o700 });
          directories.set(parent, await lstat(parent));
        }
        await assertOwnedDirectory(parent);
      }
      // wx refuses existing files and symlinks. Record the opened inode before
      // writing, so failure cleanup cannot delete a replacement entry.
      const destination = join(target, name);
      const handle = await open(destination, "wx", 0o644);
      try {
        files.set(destination, await handle.stat());
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    }
    await assertOwnedDirectory(target);
  } catch (error) {
    const current = await lstat(target).catch(() => null);
    if (sameEntry(current, reserved)) {
      for (const [path, expected] of [...files].reverse()) {
        const entry = await lstat(path).catch(() => null);
        if (sameEntry(entry, expected)) await unlink(path).catch(() => {});
      }
      for (const [path, expected] of [...directories].reverse()) {
        if (path === target) continue;
        const entry = await lstat(path).catch(() => null);
        if (sameEntry(entry, expected)) await rmdir(path).catch(() => {});
      }
    }
    throw error;
  }
}

/**
 * Install to a new, private directory; leave native clients/global settings alone.
 *
 * Verifies the bundled plugin (see reviewedTree), rewrites its endpoints to
 * `apiUrl`, and claims `directory` exclusively. An existing file, directory
 * or symlink is never replaced. Windows publishes files into the reserved
 * directory with exclusive creation; POSIX publishes the staged tree at once.
 *
 * @param {object} options
 * @param {string} options.apiUrl API origin to configure, for example
 *   "https://api.tldw.sh"; the MCP endpoint becomes `${apiUrl}/mcp`.
 * @param {string} [options.directory="./tldw-agent-plugin"] Destination. It
 *   must not exist; its parent must be an existing directory reached
 *   without symlinks.
 * @param {string} [options.webUrl] Web app origin, used only for the returned
 *   `onboarding_url`.
 * @param {string} [options.source] Bundled plugin directory; defaults to the
 *   package's ../plugin.
 * @returns {Promise<object>} A JSON-serializable report: the directory, API
 *   and MCP URLs, plugin version, file count, next steps and per-client
 *   connection commands (`commands.claude_code`, `cursor`, `codex`,
 *   `opencode`, `vscode`, `grok`).
 * @throws {SetupError} INVALID_ORIGIN, MISSING_PARENT, UNSAFE_DIRECTORY,
 *   DESTINATION_EXISTS, DESTINATION_CHANGED or INVALID_BUNDLE.
 * @example
 * const result = await installPlugin({
 *   apiUrl: "https://api.tldw.sh",
 *   directory: "./tldw-agent-plugin",
 *   webUrl: "https://tldw.sh",
 * });
 * console.log(result.commands.claude_code.commands[0]);
 */
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
  // The destination must not exist in any form, dangling symlinks included.
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
  // Replace both the origin the bundle was built for and the unconfigured
  // placeholder, so an already-configured bundle can be pointed elsewhere
  // (for example at a local server). Images are binary, and the skill files
  // must stay byte-identical to the canonical skill.
  const replacements = [...new Set([build.api_origin, PLACEHOLDER])];
  const rendered = new Map();
  for (const [name, bytes] of files) {
    let data = bytes;
    if (
      !IMAGE_EXTENSIONS.has(extname(name)) &&
      !name.startsWith("skills/tldw/")
    ) {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const old of replacements) text = text.split(old).join(origin);
      data = Buffer.from(text);
    }
    rendered.set(name, data);
  }
  // A fresh manifest for the configured copy: its origin and the hashes of
  // the rendered files.
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
  // Write everything into a private staging directory beside the target
  // first ("wx" never overwrites), before claiming the destination name.
  const staging = await mkdtemp(join(parent, ".tldw-install-"));
  // Set once the target name is reserved by mkdir; cleared after the rename.
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
    // Confirm the reserved directory is still the one created above (same
    // inode and device, not swapped for a symlink) before renaming the
    // staging directory over it in one step.
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
    if (process.platform === "win32") {
      await publishReservedFiles(target, rendered, reserved);
    } else {
      await rename(staging, target);
    }
    reserved = null;
  } catch (error) {
    // Remove the reserved directory only if it is still the one created here.
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
    // After a successful rename the staging path no longer exists.
    await rm(staging, { recursive: true, force: true });
  }
  // Static guidance only: the native MCP command or configuration for each
  // supported client, using the client's browser (OAuth) sign-in rather than
  // a pasted key. Nothing here is executed.
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
      "Create your account at https://tldw.sh, then use your client's browser sign-in when prompted. The native MCP connection forms below use OAuth without a pasted API key.",
      "The prepared plugin directory contains optional instructions. No client command has been executed, and no global settings or credentials have been saved.",
      "For an API-key fallback, create a scoped key at https://tldw.sh/developers with account:read, jobs:write, jobs:read and summaries:read so the canonical account_usage check works. Keep TLDW_API_TOKEN in your private environment or the client's supported secret store.",
      "After browser sign-in, verify access with account_usage or list_jobs inside the connected client. For an API-key check, run tldw doctor with TLDW_API_TOKEN; the CLI does not use another client's OAuth session. These checks submit no analysis.",
      "Processing uses captions/text or saved source only at 1 credit/minute; fresh audio transcription is unavailable. Legacy transcription and force_asr fields are accepted but ignored. max_credits caps one job. Re-asking a saved source is free; a source refresh can use credits.",
    ],
    commands: {
      claude_code: {
        commands: [
          "claude mcp add --transport http tldw " + shellQuote(origin + "/mcp"),
        ],
        authenticate: "Open /mcp in Claude Code and sign in when prompted.",
        documentation: "https://code.claude.com/docs/en/mcp",
      },
      cursor: {
        file: ".cursor/mcp.json",
        config: { mcpServers: { tldw: { url: origin + "/mcp" } } },
        authenticate:
          "Enable tldw in Cursor's MCP settings and complete browser sign-in.",
        documentation: "https://cursor.com/docs/context/mcp",
      },
      codex: {
        commands: [
          "codex mcp add tldw --url " + shellQuote(origin + "/mcp"),
          "codex mcp login tldw",
        ],
        file: "~/.codex/config.toml",
        config_toml:
          "[mcp_servers.tldw]\nurl = " + JSON.stringify(origin + "/mcp") + "\n",
        documentation: "https://developers.openai.com/codex/mcp/",
      },
      opencode: {
        commands: [
          "opencode mcp add tldw --url " + shellQuote(origin + "/mcp"),
        ],
        file: "opencode.json",
        config: {
          $schema: "https://opencode.ai/config.json",
          mcp: { servers: { tldw: { type: "remote", url: origin + "/mcp" } } },
        },
        authenticate:
          "Open /mcps and sign in when authentication is requested.",
        documentation: "https://opencode.ai/docs/mcp-servers/",
      },
      vscode: {
        file: "~/.copilot/mcp-config.json",
        config: {
          mcpServers: {
            tldw: { type: "http", url: origin + "/mcp", tools: ["*"] },
          },
        },
        authenticate:
          "Use Authenticate in the server actions for your Copilot session.",
        documentation:
          "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      },
      grok: {
        commands: [
          "grok mcp add --transport http tldw " + shellQuote(origin + "/mcp"),
        ],
        file: "~/.grok/config.toml",
        config_toml:
          "[mcp_servers.tldw]\nurl = " + JSON.stringify(origin + "/mcp") + "\n",
        authenticate: "Open /mcps and authenticate when prompted.",
        documentation: "https://docs.x.ai/build/features/mcp-servers",
      },
    },
  };
}

/**
 * Quote a value for a POSIX shell: wrap it in single quotes and encode each
 * embedded single quote as '"'"'.
 *
 * @param {string} value
 * @returns {string}
 * @example
 * shellQuote("https://api.tldw.sh/mcp"); // => "'https://api.tldw.sh/mcp'"
 */
export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * A new idempotency key for a CLI submission: "tldw-cli-" followed by a
 * random UUID.
 *
 * @returns {string}
 */
export function makeIdempotencyKey() {
  return "tldw-cli-" + randomUUID();
}

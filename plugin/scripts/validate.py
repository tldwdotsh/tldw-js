"""Validate the distributable tree without installing plugins or contacting a service.

Run it from the plugin directory (a checkout or an extracted download)::

    python3 scripts/validate.py

It prints one JSON line: ``{"valid": true, ...}`` with exit status 0, or
``{"valid": false, ...}`` with exit status 1. The checks are offline and
structural: an allowlist of files and directories, size and file-type
limits, no symlinks, private ``.env`` files or likely credentials, matching
plugin manifests for Claude Code, Codex and Cursor, the single bundled
``tldw`` skill, and the exact shape of every MCP configuration example,
including a literal endpoint that cannot be redirected and each client's own
syntax for referencing a secret. Passing does not prove that sign-in or a
tool call works.

Release packaging imports this module and reuses ``load_tree``,
``read_tree`` and ``validate_fixed_endpoints``.
"""

import ipaddress
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

# Files allowed at fixed paths, mostly in the plugin root. Every other file
# must live under one of ALLOWED_DIRECTORIES.
ROOT_FILES = {
    "README.md",
    "LICENSE",
    "SECURITY.md",
    ".gitignore",
    ".env.example",
    "BUILD.json",
    ".mcp.json",
    "codex.mcp.json",
    "cursor.mcp.json",
    "plugin.json",
    "mcp.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".cursor-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "skills/tldw/LICENSE",
}
ALLOWED_DIRECTORIES = {"skills", "examples", "assets", "scripts"}
# Local tool caches, skipped while reading the tree.
IGNORED_DIRECTORIES = {".git", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"}
# Text files must be UTF-8; images are only size-checked.
TEXT_EXTENSIONS = {".md", ".json", ".toml", ".py", ".txt", ".yml", ".yaml", ".svg", ".example"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
# Shapes of common secrets: payment-provider secret and restricted keys,
# sk- style model-provider keys, tldw API keys (current and retired
# prefixes), development admin tokens, Groq and xAI keys, and PEM private
# keys. Mirrors SECRET_PATTERNS in the JavaScript client's installer.
SECRET_PATTERNS = (
    rb"(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
    rb"sk-[A-Za-z0-9_-]{24,}",
    rb"(?:tldw|yta)_[A-Za-z0-9_-]{32,}",
    rb"dev_admin_[A-Za-z0-9_-]{32,}",
    rb"gsk_[A-Za-z0-9]{32,}",
    rb"xai-[A-Za-z0-9_-]{32,}",
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
)


class ValidationFailure(ValueError):
    """A structural or credential check failed.

    main() reports only a fixed message, never file contents, so its output
    cannot repeat a secret that a check found.
    """


def validate_cursor(files: dict[str, bytes], manifest: dict) -> None:
    """The native plugin uses OAuth; key configuration is an explicit alternative.

    Cursor's manifest must load its dedicated ``./cursor.mcp.json``, which
    must exist, and must not declare variables such as a token prompt.
    """
    if manifest.get("mcpServers") != "./cursor.mcp.json" or "cursor.mcp.json" not in files:
        raise ValidationFailure("Cursor must load its dedicated MCP configuration")
    if "variables" in manifest:
        raise ValidationFailure("The OAuth plugin must not require a token variable")


def fixed_mcp_url(url: object) -> bool:
    """A bearer token may only be sent to a literal, reviewed /mcp endpoint.

    Environment expansion such as ``${TLDW_MCP_URL:-...}`` would let any process
    environment redirect the user's token to another host, so it is refused.

    Returns True only for ``https://host[:port]/mcp``, or plain ``http`` on
    localhost or a loopback IP address, with a valid host name, no
    credentials, query, fragment or port 0, and no ``$``, backslash or
    whitespace characters anywhere.
    """
    try:
        if (
            not isinstance(url, str)
            or "\\" in url
            or "${" in url
            or "$" in url
            or any(char.isspace() for char in url)
        ):
            raise ValueError
        endpoint = urlsplit(url)
        hostname = endpoint.hostname or ""
        local = hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            # Not an IP literal: every label must be a valid DNS label.
            if len(hostname) > 253 or not all(
                re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", part)
                for part in hostname.split(".")
            ):
                raise ValueError from None
        if (
            not endpoint.hostname
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
            or endpoint.path != "/mcp"
            or endpoint.port == 0
            or endpoint.scheme != "https"
            and not (endpoint.scheme == "http" and local)
        ):
            raise ValueError
    except (TypeError, ValueError):
        # Also reached when urlsplit().port rejects an invalid port.
        return False
    return True


def validate_fixed_endpoints(files: dict[str, bytes]) -> None:
    """Check each client's real schema and its distinct secret-reference syntax.

    ``files`` maps plugin-relative paths to contents. The client a file
    belongs to is inferred from its path.

    * TOML examples (``examples/**/*.toml``, Codex and Grok) hold a single
      ``[mcp_servers.tldw]`` table with a literal quoted ``url``. API-key
      variants add exactly ``bearer_token_env_var = "TLDW_API_TOKEN"``
      (Codex) or an ``Authorization`` header built from ``${TLDW_API_TOKEN}``
      (Grok).
    * JSON configurations (``.mcp.json``, ``codex.mcp.json``,
      ``cursor.mcp.json`` and ``examples/**/*.json`` except
      ``examples/media/``) define exactly one ``tldw`` server in the client's
      documented shape: ``type: "http"`` for Claude Code and VS Code (which
      also needs ``tools: ["*"]``), ``type: "remote"`` under ``mcp.servers``
      for OpenCode. API-key variants add an ``Authorization`` header in the
      client's own reference syntax: ``${TLDW_API_TOKEN}``,
      ``${env:TLDW_API_TOKEN}`` for Cursor, or ``{env:TLDW_API_TOKEN}`` for
      OpenCode, which must also set ``oauth: false``.

    Every URL must pass ``fixed_mcp_url``. Raises ValidationFailure.
    """
    for name, data in files.items():
        if name.endswith(".toml") and name.startswith("examples/"):
            # Our copyable native examples deliberately use one flat table;
            # validate that bounded grammar without adding a parser dependency.
            lines = [
                line.strip()
                for line in data.decode().splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            ]
            if not lines or lines.pop(0) != "[mcp_servers.tldw]":
                raise ValidationFailure("Use the documented native MCP table")
            fields = {}
            for line in lines:
                field, separator, value = line.partition("=")
                field = field.strip()
                if not separator or field in fields:
                    raise ValidationFailure("Native MCP examples must use one flat table")
                fields[field] = value.strip()
            # A TOML basic string without escapes is also a JSON string.
            try:
                url = json.loads(fields.get("url", ""))
            except ValueError:
                raise ValidationFailure(
                    "Native MCP URLs must use a literal quoted string"
                ) from None
            if not fixed_mcp_url(url):
                raise ValidationFailure("MCP endpoints must be fixed HTTPS URLs or local loopback")
            expected = {"url"}
            if "api-key" in name:
                field = "bearer_token_env_var" if "/codex/" in name else "headers"
                expected.add(field)
                value = (
                    '"TLDW_API_TOKEN"'
                    if "/codex/" in name
                    else '{ Authorization = "Bearer ${TLDW_API_TOKEN}" }'
                )
                if fields.get(field) != value:
                    raise ValidationFailure(
                        "API-key alternatives must use private environment references"
                    )
            if set(fields) != expected:
                raise ValidationFailure("Unexpected fields in the native MCP configuration")
            continue
        native = name in {".mcp.json", "codex.mcp.json", "cursor.mcp.json"}
        if not name.endswith(".json") or not (native or name.startswith("examples/")):
            continue
        # Media request fixtures are not MCP configuration files.
        if name.startswith("examples/media/"):
            continue
        config = json.loads(data)
        opencode = "/opencode/" in name
        vscode = "/vscode/" in name
        claude = name == ".mcp.json" or "/claude/" in name
        expected_root = {"$schema", "mcp"} if opencode else {"mcpServers"}
        if set(config) != expected_root:
            raise ValidationFailure("Use the documented client-specific MCP configuration shape")
        container = config.get("mcp") if opencode else config
        if opencode:
            if not isinstance(container, dict) or set(container) != {"servers"}:
                raise ValidationFailure("OpenCode V2 requires mcp.servers")
            if config["$schema"] != "https://opencode.ai/config.json":
                raise ValidationFailure("Use OpenCode's official configuration schema")
        servers = container.get("servers" if opencode else "mcpServers", {})
        if not isinstance(servers, dict) or set(servers) != {"tldw"}:
            raise ValidationFailure("Configure only the reviewed tldw server")
        server = servers["tldw"]
        if not isinstance(server, dict):
            raise ValidationFailure("MCP server configuration must be an object")
        # Build the exact set of keys this client's entry may contain.
        expected = {"url"}
        if claude or opencode or vscode:
            expected.add("type")
        if vscode:
            expected.add("tools")
        if "api-key" in name:
            expected.add("headers")
            if opencode:
                expected.add("oauth")
            placeholder = (
                "{env:TLDW_API_TOKEN}"
                if opencode
                else "${env:TLDW_API_TOKEN}"
                if "/cursor/" in name
                else "${TLDW_API_TOKEN}"
            )
            if server.get("headers") != {"Authorization": "Bearer " + placeholder}:
                raise ValidationFailure("Use this client's private environment-reference syntax")
            if opencode and server.get("oauth") is not False:
                raise ValidationFailure("OpenCode API-key alternatives must disable OAuth")
        if not isinstance(server, dict) or set(server) != expected:
            raise ValidationFailure("Unexpected fields in the client MCP configuration")
        if not fixed_mcp_url(server.get("url")):
            raise ValidationFailure("MCP endpoints must be fixed HTTPS URLs or local loopback")
        if "type" in expected and server.get("type") != ("remote" if opencode else "http"):
            raise ValidationFailure("Use this client's Streamable HTTP transport")
        if vscode and server["tools"] != ["*"]:
            raise ValidationFailure("Copilot tools must use the documented availability field")


def validate_marketplaces(files: dict[str, bytes]) -> None:
    """Check each marketplace listing that is present.

    The Claude Code, Cursor and Codex listings must be named ``tldw`` and list
    exactly this plugin from its own directory. The Codex listing must also
    make the plugin available and request authentication on install.
    """
    for name in (
        ".claude-plugin/marketplace.json",
        ".cursor-plugin/marketplace.json",
        ".agents/plugins/marketplace.json",
    ):
        if name not in files:
            continue
        listing = json.loads(files[name])
        plugins = listing.get("plugins")
        if listing.get("name") != "tldw" or not isinstance(plugins, list) or len(plugins) != 1:
            raise ValidationFailure("The marketplace must list the single reviewed tldw plugin")
        plugin = plugins[0]
        # Codex describes a local source as an object; the others use a path.
        codex = name.startswith(".agents/")
        source = {"source": "local", "path": "./"} if codex else "./"
        if (
            not isinstance(plugin, dict)
            or plugin.get("name") != "tldw"
            or plugin.get("source") != source
        ):
            raise ValidationFailure("Marketplace entries must reference this local plugin")
        if codex and plugin.get("policy") != {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL",
        }:
            raise ValidationFailure("The Codex marketplace must request authentication on install")


def read_tree(root: Path) -> dict[str, bytes]:
    """Read bounded public resources before checking a particular plugin layout.

    Returns ``{relative POSIX path: bytes}`` for every file under ``root``,
    skipping the contents of IGNORED_DIRECTORIES. Raises ValidationFailure
    for any symlink in the walked tree (an ignored directory that is itself
    a symlink included), an unsafe file name, a private ``.env`` file, a
    file outside the allowlist or of an unsupported type, a file over 2 MiB
    or a tree over 8 MiB, a likely credential, non-UTF-8 text, or JSON that
    is not an object.
    """
    files: dict[str, bytes] = {}
    total = 0
    for parent, directories, names in os.walk(root, followlinks=False):
        # Check for symlinks before pruning, so a linked cache directory is
        # refused rather than silently skipped.
        for name in directories + names:
            if (Path(parent) / name).is_symlink():
                raise ValidationFailure("Symlinks are not allowed in a plugin bundle")
        directories[:] = [name for name in directories if name not in IGNORED_DIRECTORIES]
        for name in names:
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            if not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
                raise ValidationFailure("Unsupported filename in plugin source")
            if name.startswith(".env") and relative != ".env.example":
                raise ValidationFailure("Private environment files cannot be packaged")
            if relative not in ROOT_FILES and parts[0] not in ALLOWED_DIRECTORIES:
                raise ValidationFailure("Unexpected file outside the plugin allowlist")
            if path.suffix not in TEXT_EXTENSIONS | IMAGE_EXTENSIONS and relative not in ROOT_FILES:
                raise ValidationFailure("Unsupported file type in plugin source")
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                raise ValidationFailure("Plugin source must contain bounded regular files")
            data = path.read_bytes()
            total += len(data)
            if total > MAX_TOTAL_BYTES:
                raise ValidationFailure("Plugin bundle exceeds its size limit")
            if any(re.search(pattern, data) for pattern in SECRET_PATTERNS):
                raise ValidationFailure("Possible credential or private key in plugin source")
            if path.suffix not in IMAGE_EXTENSIONS:
                try:
                    data.decode("utf-8")
                except UnicodeDecodeError:
                    raise ValidationFailure("Text resources must be UTF-8") from None
            if path.suffix == ".json":
                try:
                    parsed = json.loads(data)
                    if not isinstance(parsed, dict):
                        raise ValueError
                except (ValueError, UnicodeDecodeError):
                    raise ValidationFailure("Plugin JSON resources must be valid objects") from None
            files[relative] = data
    return files


def load_tree(root: Path) -> tuple[dict[str, bytes], dict]:
    """Read and validate a complete plugin tree rooted at ``root``.

    On top of ``read_tree`` it requires the core files; native manifests for
    Claude Code, Codex and (from version 0.7.0, or whenever cursor.mcp.json
    exists) Cursor, all named ``tldw`` with one semantic version; declared
    skill and MCP resources that exist inside the plugin; declared icons
    that point to the single bundled 512x512 PNG; valid marketplace
    listings; and exactly one
    skill, ``skills/tldw/SKILL.md``, whose front matter has ``name: tldw``
    and a description. MCP endpoints are checked separately by
    ``validate_fixed_endpoints``.

    Returns:
        ``(files, report)``: the files from ``read_tree`` and the JSON
        summary that main() prints.

    Raises:
        ValidationFailure, or OSError when the tree cannot be read.
    """
    files = read_tree(root)
    required = {
        "README.md",
        "LICENSE",
        ".mcp.json",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
    }
    if not required.issubset(files):
        raise ValidationFailure("Required plugin resources are missing")
    manifest_paths = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]
    if ".cursor-plugin/plugin.json" in files:
        manifest_paths.append(".cursor-plugin/plugin.json")
    elif "cursor.mcp.json" in files:
        raise ValidationFailure("Cursor configuration requires its native manifest")
    manifests = [json.loads(files[name]) for name in manifest_paths]
    if any(item.get("name") != "tldw" for item in manifests):
        raise ValidationFailure("Native plugin names must match tldw")
    version = manifests[0].get("version")
    if not isinstance(version, str) or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version
    ):
        raise ValidationFailure("Plugin version must use semantic versioning")
    if any(item.get("version") != version for item in manifests):
        raise ValidationFailure("Native plugin versions must agree")
    # Releases from 0.7.0 on ship Cursor support; its manifest is mandatory.
    if tuple(int(part) for part in version.split("-")[0].split(".")) >= (0, 7, 0):
        if ".cursor-plugin/plugin.json" not in files:
            raise ValidationFailure("This plugin version requires its Cursor resources")
    if ".cursor-plugin/plugin.json" in files:
        validate_cursor(files, json.loads(files[".cursor-plugin/plugin.json"]))
    for manifest in manifests:
        # Resource paths declared by a manifest must stay inside the plugin.
        for field in ("skills", "mcpServers"):
            resource = manifest.get(field)
            if not isinstance(resource, str):
                continue
            target = PurePosixPath(resource)
            if target.is_absolute() or ".." in target.parts:
                raise ValidationFailure("Manifest resource paths must stay inside the plugin")
            if not (root / resource).exists():
                raise ValidationFailure("A declared plugin resource is missing")
        interface = manifest.get("interface", {})
        assets = [manifest[field] for field in ("icon", "logo") if field in manifest]
        if isinstance(interface, dict):
            assets.extend(
                interface[field] for field in ("composerIcon", "logo") if field in interface
            )
        for asset in assets:
            if not isinstance(asset, str) or asset not in {"assets/icon.png", "./assets/icon.png"}:
                raise ValidationFailure("Native plugin icons must use the single reviewed asset")
            # PNG signature, then the IHDR width and height (512 x 512) as
            # big-endian 32-bit integers at bytes 16-23.
            icon = files.get("assets/icon.png", b"")
            if (
                not icon.startswith(b"\x89PNG\r\n\x1a\n")
                or icon[16:24] != b"\x00\x00\x02\x00\x00\x00\x02\x00"
            ):
                raise ValidationFailure("The plugin icon must be a bundled 512px square PNG")
    validate_marketplaces(files)
    skills = [path for path in files if path.startswith("skills/") and path.endswith("/SKILL.md")]
    if skills != ["skills/tldw/SKILL.md"]:
        raise ValidationFailure("The plugin must ship only the canonical tldw skill")
    for path in skills:
        text = files[path].decode()
        frontmatter = re.match(r"\A---\s*\n(.*?)\n---", text, re.S)
        if not frontmatter or not all(
            re.search(rf"^{field}:\s*\S", frontmatter[1], re.M) for field in ("name", "description")
        ):
            raise ValidationFailure("Skills require name and description frontmatter")
        if not re.search(r"^name:\s*tldw\s*$", frontmatter[1], re.M):
            raise ValidationFailure("Canonical skill name must be tldw")
    return files, {
        "valid": True,
        "name": "tldw",
        "version": version,
        "files": len(files),
        "skills": len(skills),
        "network_requests": 0,
    }


def main() -> int:
    """Validate the plugin that contains this script; return the exit status."""
    try:
        # This file lives in <plugin>/scripts/, so the plugin root is one up.
        files, report = load_tree(Path(__file__).resolve().parents[1])
        validate_fixed_endpoints(files)
    except (OSError, ValidationFailure):
        print(
            json.dumps(
                {"valid": False, "error": "Plugin files failed structural or credential checks"}
            )
        )
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

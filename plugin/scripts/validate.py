"""Validate the distributable tree without installing plugins or contacting a service."""

import ipaddress
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

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
    ".agents/plugins/marketplace.json",
}
ALLOWED_DIRECTORIES = {"skills", "examples", "assets", "scripts", ".github"}
IGNORED_DIRECTORIES = {".git", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"}
TEXT_EXTENSIONS = {".md", ".json", ".toml", ".py", ".txt", ".yml", ".yaml", ".svg", ".example"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
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
    pass


def validate_cursor(files: dict[str, bytes], manifest: dict) -> None:
    """Cursor variables name secrets; only the user's client supplies their values."""
    if manifest.get("mcpServers") != "./cursor.mcp.json" or "cursor.mcp.json" not in files:
        raise ValidationFailure("Cursor must load its dedicated MCP configuration")
    variables = manifest.get("variables", {})
    if not isinstance(variables, dict):
        raise ValidationFailure("Cursor variables must use an object schema")
    properties = variables.get("properties", {})
    if not isinstance(properties, dict):
        raise ValidationFailure("Cursor variables must declare property schemas")
    token = properties.get("TLDW_API_TOKEN", {})
    if (
        variables.get("type") != "object"
        or any(name in variables for name in ("default", "const", "enum"))
        or set(properties) != {"TLDW_API_TOKEN"}
        or variables.get("required") != ["TLDW_API_TOKEN"]
        or not isinstance(token, dict)
        or token.get("type") != "string"
        or any(name in token for name in ("default", "const", "enum"))
    ):
        raise ValidationFailure("Cursor must require the user's token without a bundled value")
    configuration = json.loads(files["cursor.mcp.json"])
    servers = configuration.get("mcpServers", {})
    if (
        not isinstance(servers, dict)
        or set(servers) != {"tldw"}
        or not isinstance(servers["tldw"], dict)
        or set(servers["tldw"]) != {"url", "headers"}
    ):
        raise ValidationFailure("Cursor must configure only the reviewed remote server")
    server = servers["tldw"]
    if server.get("headers") != {"Authorization": "Bearer ${TLDW_API_TOKEN}"}:
        raise ValidationFailure("Cursor Authorization must use its declared user variable")
    if not fixed_mcp_url(server.get("url", "")):
        raise ValidationFailure("Cursor endpoint must be a fixed HTTPS URL or local loopback")
    names = set(re.findall(r"\$\{([^}]+)\}", files["cursor.mcp.json"].decode()))
    if names != set(properties):
        raise ValidationFailure("Cursor MCP variables must match its manifest declarations")


def fixed_mcp_url(url: object) -> bool:
    """A bearer token may only be sent to a literal, reviewed /mcp endpoint.

    Environment expansion such as ``${TLDW_MCP_URL:-...}`` would let any process
    environment redirect the user's token to another host, so it is refused.
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
        return False
    return True


def validate_fixed_endpoints(files: dict[str, bytes]) -> None:
    """Every packaged MCP configuration must name a literal endpoint, never an override."""
    for name in (".mcp.json", "codex.mcp.json", "cursor.mcp.json", "examples/cursor/mcp.json"):
        if name not in files:
            continue
        servers = json.loads(files[name]).get("mcpServers", {})
        if not isinstance(servers, dict) or not servers:
            raise ValidationFailure("MCP configuration must declare its reviewed server")
        for server in servers.values():
            if not isinstance(server, dict) or not fixed_mcp_url(server.get("url")):
                raise ValidationFailure("MCP endpoints must be fixed HTTPS URLs or local loopback")
    for name, data in files.items():
        if name.endswith(".toml"):
            for value in re.findall(r'^\s*url\s*=\s*"([^"]*)"', data.decode(), re.M):
                if not fixed_mcp_url(value):
                    raise ValidationFailure(
                        "MCP endpoints must be fixed HTTPS URLs or local loopback"
                    )


def load_tree(root: Path) -> tuple[dict[str, bytes], dict]:
    files: dict[str, bytes] = {}
    total = 0
    for parent, directories, names in os.walk(root, followlinks=False):
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
    if tuple(int(part) for part in version.split("-")[0].split(".")) >= (0, 7, 0):
        if ".cursor-plugin/plugin.json" not in files:
            raise ValidationFailure("This plugin version requires its Cursor resources")
    if ".cursor-plugin/plugin.json" in files:
        validate_cursor(files, json.loads(files[".cursor-plugin/plugin.json"]))
    for manifest in manifests:
        for field in ("skills", "mcpServers"):
            resource = manifest.get(field)
            if not isinstance(resource, str):
                continue
            target = PurePosixPath(resource)
            if target.is_absolute() or ".." in target.parts:
                raise ValidationFailure("Manifest resource paths must stay inside the plugin")
            if not (root / resource).exists():
                raise ValidationFailure("A declared plugin resource is missing")
    skills = [path for path in files if path.startswith("skills/") and path.endswith("/SKILL.md")]
    if not skills:
        raise ValidationFailure("At least one workflow skill is required")
    for path in skills:
        text = files[path].decode()
        frontmatter = re.match(r"\A---\s*\n(.*?)\n---", text, re.S)
        if not frontmatter or not all(
            re.search(rf"^{field}:\s*\S", frontmatter[1], re.M) for field in ("name", "description")
        ):
            raise ValidationFailure("Skills require name and description frontmatter")
    return files, {
        "valid": True,
        "name": "tldw",
        "version": version,
        "files": len(files),
        "skills": len(skills),
        "network_requests": 0,
    }


def main() -> int:
    try:
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

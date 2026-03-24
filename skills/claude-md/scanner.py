"""Static codebase scanner for CLAUDE.md generation.

Analyzes a project directory to extract tech stack, conventions, key directories,
and prove-specific configuration. All detection is deterministic (no LLM calls).
"""

from __future__ import annotations

import json
import os
import re
from collections import Counter
from pathlib import Path


def scan_project(project_root: str, plugin_dir: str | None = None) -> dict:
    """Run all scanners and return structured results.

    Args:
        project_root: Absolute path to the project root.
        plugin_dir: Absolute path to the prove plugin directory.
                    If None, auto-detected from this file's location.

    Returns:
        Dict with keys: project, tech_stack, key_dirs, conventions,
        prove_config, cafi.
    """
    if plugin_dir is None:
        plugin_dir = str(Path(__file__).resolve().parent.parent.parent)

    return {
        "project": _scan_project_identity(project_root),
        "tech_stack": _scan_tech_stack(project_root),
        "key_dirs": _scan_key_dirs(project_root),
        "conventions": _scan_conventions(project_root),
        "prove_config": _scan_prove_config(project_root),
        "cafi": _scan_cafi(project_root),
        "core_commands": _scan_core_commands(plugin_dir),
        "plugin_version": _scan_plugin_version(plugin_dir),
        "plugin_dir": plugin_dir,
    }


def _scan_project_identity(root: str) -> dict:
    """Extract project name and basic identity."""
    name = os.path.basename(os.path.abspath(root))

    # Try to get a better name from common config files
    for config_file in ["package.json", "Cargo.toml", "pyproject.toml"]:
        config_path = os.path.join(root, config_file)
        if os.path.isfile(config_path):
            try:
                if config_file == "package.json":
                    with open(config_path) as f:
                        data = json.load(f)
                    pkg_name = data.get("name", "")
                    if pkg_name:
                        name = pkg_name
                        break
                else:
                    # Cargo.toml and pyproject.toml both use name = "..."
                    with open(config_path) as f:
                        content = f.read()
                    m = re.search(r'name\s*=\s*"([^"]+)"', content)
                    if m:
                        name = m.group(1)
                        break
            except (json.JSONDecodeError, OSError):
                pass

    return {"name": name}


def _scan_tech_stack(root: str) -> dict:
    """Detect languages, frameworks, and build systems."""
    languages: list[str] = []
    frameworks: list[str] = []
    build_systems: list[str] = []

    checks = [
        # (file_to_check, language, framework, build_system)
        ("go.mod", "Go", None, "go"),
        ("Cargo.toml", "Rust", None, "cargo"),
        ("package.json", "JavaScript/TypeScript", None, "npm"),
        ("pyproject.toml", "Python", None, "pip"),
        ("setup.py", "Python", None, "pip"),
        ("requirements.txt", "Python", None, "pip"),
        ("Gemfile", "Ruby", None, "bundler"),
        ("project.godot", "GDScript", "Godot", None),
        ("Makefile", None, None, "make"),
        ("CMakeLists.txt", "C/C++", None, "cmake"),
        ("pom.xml", "Java", None, "maven"),
        ("build.gradle", "Java/Kotlin", None, "gradle"),
    ]

    for filename, lang, fw, build_sys in checks:
        if os.path.isfile(os.path.join(root, filename)):
            if lang and lang not in languages:
                languages.append(lang)
            if fw and fw not in frameworks:
                frameworks.append(fw)
            if build_sys and build_sys not in build_systems:
                build_systems.append(build_sys)

    # Detect TypeScript specifically
    if os.path.isfile(os.path.join(root, "tsconfig.json")):
        if "JavaScript/TypeScript" not in languages:
            languages.append("JavaScript/TypeScript")

    # Detect frameworks from package.json
    pkg_path = os.path.join(root, "package.json")
    if os.path.isfile(pkg_path):
        try:
            with open(pkg_path) as f:
                pkg = json.load(f)
            deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
            fw_map = {
                "react": "React",
                "next": "Next.js",
                "vue": "Vue",
                "svelte": "Svelte",
                "express": "Express",
                "fastify": "Fastify",
            }
            for dep, fw_name in fw_map.items():
                if dep in deps and fw_name not in frameworks:
                    frameworks.append(fw_name)
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "languages": languages,
        "frameworks": frameworks,
        "build_systems": build_systems,
    }


def _scan_key_dirs(root: str) -> dict[str, str]:
    """Identify important directories and their purpose."""
    dir_hints: dict[str, str] = {
        "src": "Source code",
        "lib": "Library code",
        "pkg": "Go packages",
        "cmd": "Go CLI entry points",
        "internal": "Internal packages",
        "app": "Application code",
        "pages": "Page routes",
        "components": "UI components",
        "api": "API endpoints",
        "routes": "Route handlers",
        "models": "Data models",
        "services": "Service layer",
        "utils": "Utility functions",
        "helpers": "Helper functions",
        "tests": "Test files",
        "test": "Test files",
        "spec": "Test specifications",
        "__tests__": "Test files",
        "scripts": "Build/utility scripts",
        "docs": "Documentation",
        "config": "Configuration files",
        "migrations": "Database migrations",
        "tools": "Development tools",
        "skills": "Plugin skills",
        "agents": "Agent definitions",
        "commands": "Slash commands",
    }

    found: dict[str, str] = {}
    try:
        entries = os.listdir(root)
    except OSError:
        return found

    for entry in sorted(entries):
        full = os.path.join(root, entry)
        if os.path.isdir(full) and not entry.startswith("."):
            if entry in dir_hints:
                found[entry] = dir_hints[entry]

    return found


def _scan_conventions(root: str) -> dict:
    """Detect naming conventions and test patterns."""
    # Sample source files to detect naming
    ext_counts: Counter[str] = Counter()
    sample_names: list[str] = []
    test_patterns: list[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden/vendor dirs
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in (
                "node_modules", "vendor", "venv", ".venv",
                "__pycache__", "target", "build", "dist",
            )
        ]

        rel = os.path.relpath(dirpath, root)
        depth = rel.count(os.sep) if rel != "." else 0
        if depth > 3:
            dirnames.clear()
            continue

        for fn in filenames:
            if fn.startswith("."):
                continue
            ext = os.path.splitext(fn)[1]
            if ext:
                ext_counts[ext] += 1

            # Collect source file names (not config/docs)
            if ext in (".py", ".go", ".rs", ".js", ".ts", ".tsx", ".jsx", ".rb", ".java", ".kt"):
                sample_names.append(fn)

            # Detect test patterns
            if "test" in fn.lower() or "spec" in fn.lower():
                if ext in (".py", ".go", ".rs", ".js", ".ts", ".tsx", ".jsx"):
                    if fn.startswith("test_"):
                        test_patterns.append("test_*.ext (prefix)")
                    elif fn.endswith(f"_test{ext}"):
                        test_patterns.append("*_test.ext (suffix)")
                    elif fn.endswith(f".test{ext}"):
                        test_patterns.append("*.test.ext (dot)")
                    elif fn.endswith(f".spec{ext}"):
                        test_patterns.append("*.spec.ext (dot)")

    # Determine naming convention from source files
    naming = _detect_naming(sample_names)

    # Deduplicate test patterns
    unique_test = list(dict.fromkeys(test_patterns))[:3]

    return {
        "naming": naming,
        "test_patterns": unique_test,
        "primary_extensions": [
            ext for ext, _ in ext_counts.most_common(5) if ext in (
                ".py", ".go", ".rs", ".js", ".ts", ".tsx", ".jsx",
                ".rb", ".java", ".kt", ".gd",
            )
        ],
    }


def _detect_naming(filenames: list[str]) -> str:
    """Detect dominant naming convention from file names."""
    if not filenames:
        return "unknown"

    snake = 0
    kebab = 0
    camel = 0
    pascal = 0

    for fn in filenames:
        name = os.path.splitext(fn)[0]
        if "_" in name and name == name.lower():
            snake += 1
        elif "-" in name and name == name.lower():
            kebab += 1
        elif name[0].islower() and any(c.isupper() for c in name[1:]):
            camel += 1
        elif name[0].isupper() and any(c.isupper() for c in name[1:]):
            pascal += 1

    counts = {"snake_case": snake, "kebab-case": kebab, "camelCase": camel, "PascalCase": pascal}
    winner = max(counts, key=counts.get)  # type: ignore[arg-type]
    if counts[winner] == 0:
        return "unknown"
    return winner


def _scan_prove_config(root: str) -> dict:
    """Read .prove.json configuration."""
    config_path = os.path.join(root, ".prove.json")
    if not os.path.isfile(config_path):
        return {"exists": False, "validators": [], "has_index": False, "references": []}

    try:
        with open(config_path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"exists": False, "validators": [], "has_index": False, "references": []}

    validators = data.get("validators", [])
    claude_md = data.get("claude_md", {})
    references = claude_md.get("references", [])
    return {
        "exists": True,
        "validators": [
            {"name": v.get("name", ""), "command": v.get("command", ""), "phase": v.get("phase", "")}
            for v in validators
        ],
        "has_index": "index" in data,
        "references": [
            {"path": r.get("path", ""), "label": r.get("label", "")}
            for r in references
            if r.get("path")
        ],
    }


def _scan_plugin_version(plugin_dir: str) -> str:
    """Read the plugin version from .claude-plugin/plugin.json."""
    plugin_json = os.path.join(plugin_dir, ".claude-plugin", "plugin.json")
    if not os.path.isfile(plugin_json):
        return "unknown"
    try:
        with open(plugin_json) as f:
            data = json.load(f)
        return data.get("version", "unknown")
    except (json.JSONDecodeError, OSError):
        return "unknown"


def _scan_core_commands(plugin_dir: str) -> list[dict]:
    """Read commands/ directory for entries with core: true in frontmatter.

    Returns a sorted list of {name, summary} dicts for commands that should
    appear in the Prove Commands section of CLAUDE.md.
    """
    commands_dir = os.path.join(plugin_dir, "commands")
    if not os.path.isdir(commands_dir):
        return []

    commands: list[dict] = []
    for filename in sorted(os.listdir(commands_dir)):
        if not filename.endswith(".md"):
            continue

        filepath = os.path.join(commands_dir, filename)
        frontmatter = _parse_frontmatter(filepath)
        if not frontmatter:
            continue

        if frontmatter.get("core") == "true":
            name = filename.removesuffix(".md")
            summary = frontmatter.get("summary", frontmatter.get("description", ""))
            commands.append({"name": name, "summary": summary})

    return commands


def _parse_frontmatter(filepath: str) -> dict[str, str] | None:
    """Extract YAML frontmatter as a flat key-value dict.

    Only handles simple `key: value` pairs (no nesting). Returns None
    if the file has no frontmatter.
    """
    try:
        with open(filepath) as f:
            first_line = f.readline().rstrip()
            if first_line != "---":
                return None

            fields: dict[str, str] = {}
            for line in f:
                line = line.rstrip()
                if line == "---":
                    return fields
                if ":" in line:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if key and value:
                        fields[key] = value
            return None  # No closing ---
    except OSError:
        return None


def _scan_cafi(root: str) -> dict:
    """Check CAFI index availability."""
    cache_path = os.path.join(root, ".prove", "file-index.json")
    has_cache = os.path.isfile(cache_path)

    file_count = 0
    if has_cache:
        try:
            with open(cache_path) as f:
                cache = json.load(f)
            file_count = len(cache.get("files", {}))
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "available": has_cache,
        "file_count": file_count,
    }

"""PCD Round 0a: Deterministic structural map generator.

Produces dependency graphs and file clusters from import analysis.
Uses CAFI for file discovery and optional description enrichment.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

# Add the tools directory to sys.path so we can import shared _lib and pcd packages.
_pcd_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_pcd_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from _lib.cache import load_cache  # noqa: E402
from _lib.config import load_config  # noqa: E402
from _lib.file_walker import walk_project  # noqa: E402
from pcd.import_parser import (  # noqa: E402
    ImportEntry,
    detect_language,
    parse_imports,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OUTPUT_DIR = os.path.join(".prove", "steward", "pcd")
OUTPUT_FILE = "structural-map.json"
CACHE_PATH = os.path.join(".prove", "file-index.json")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _count_lines(file_path: str) -> int:
    """Count lines in a file. Return 0 on error."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def _resolve_import_to_file(
    module: str,
    language: str,
    project_files: set[str],
    project_root: str,
) -> str | None:
    """Resolve a module name to a project-relative file path.

    Parameters
    ----------
    module:
        The imported module string (e.g. ``cafi.hasher``, ``./utils``).
    language:
        Language of the importing file.
    project_files:
        Set of known project-relative file paths.
    project_root:
        Absolute path to the project root.

    Returns
    -------
    The matched project-relative file path, or ``None`` if unresolvable.
    """
    if language == "python":
        return _resolve_python(module, project_files)
    if language == "rust":
        return _resolve_rust(module, project_files)
    if language == "go":
        return _resolve_go(module, project_files, project_root)
    if language in ("javascript", "typescript"):
        return _resolve_js_ts(module, project_files)
    return None


def _resolve_python(module: str, project_files: set[str]) -> str | None:
    """Resolve a Python module path to a file.

    ``cafi.hasher`` -> try ``cafi/hasher.py``, ``cafi/hasher/__init__.py``
    Relative imports (starting with ``.``) are not resolved here since
    we lack the importing file's package context in this simple resolver.
    """
    if module.startswith("."):
        return None
    parts = module.split(".")
    # Try as a direct module file: a/b/c.py
    candidate = os.path.join(*parts) + ".py" if parts else None
    if candidate and candidate in project_files:
        return candidate
    # Try as a package: a/b/c/__init__.py
    candidate_pkg = os.path.join(*parts, "__init__.py") if parts else None
    if candidate_pkg and candidate_pkg in project_files:
        return candidate_pkg
    return None


def _resolve_rust(module: str, project_files: set[str]) -> str | None:
    """Resolve a Rust use path to a file.

    ``crate::parser::Parser`` -> try ``src/parser.rs``, ``src/parser/mod.rs``
    """
    if not module.startswith(("crate::", "self::", "super::")):
        return None
    # Strip the crate/self/super prefix
    parts = module.split("::")
    # Remove the first segment (crate/self/super)
    path_parts = parts[1:]
    if not path_parts:
        return None
    # For crate:: imports, the root is typically src/
    prefix = "src" if parts[0] == "crate" else ""
    # Drop the last part if it looks like a type name (starts with uppercase)
    if path_parts and path_parts[-1] and path_parts[-1][0].isupper():
        path_parts = path_parts[:-1]
    if not path_parts:
        return None
    if prefix:
        base = os.path.join(prefix, *path_parts)
    else:
        base = os.path.join(*path_parts)
    # Try as file.rs
    candidate = base + ".rs"
    if candidate in project_files:
        return candidate
    # Try as directory/mod.rs
    candidate_mod = os.path.join(base, "mod.rs")
    if candidate_mod in project_files:
        return candidate_mod
    return None


def _resolve_go(
    module: str, project_files: set[str], project_root: str
) -> str | None:
    """Resolve a Go import path to a directory with .go files.

    Go imports are package paths. We try to strip the module prefix
    (from go.mod) and look for .go files in the resulting directory.
    Returns the first matching .go file path for the adjacency graph.
    """
    # Read go.mod to find the module prefix
    go_mod_path = os.path.join(project_root, "go.mod")
    module_prefix = ""
    try:
        with open(go_mod_path, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("module "):
                    module_prefix = line.split(None, 1)[1].strip()
                    break
    except OSError:
        pass

    if module_prefix and module.startswith(module_prefix):
        rel = module[len(module_prefix) :].lstrip("/")
    else:
        rel = module

    # Look for .go files in that directory
    for pf in sorted(project_files):
        if pf.startswith(rel + "/") and pf.endswith(".go"):
            return pf
        # Also try exact match for single-file packages
        if pf == rel + ".go":
            return pf
    return None


def _resolve_js_ts(module: str, project_files: set[str]) -> str | None:
    """Resolve a JS/TS relative import to a file.

    ``./utils`` -> try ``utils.js``, ``utils.ts``, ``utils.tsx``,
    ``utils/index.js``, ``utils/index.ts``, etc.
    """
    if not module.startswith(("./", "../")):
        return None
    # Normalize the path (remove leading ./)
    base = os.path.normpath(module)
    extensions = [".js", ".jsx", ".ts", ".tsx", ".mjs"]
    # If already has an extension, try directly
    _, ext = os.path.splitext(base)
    if ext in extensions:
        if base in project_files:
            return base
        return None
    # Try with each extension
    for e in extensions:
        candidate = base + e
        if candidate in project_files:
            return candidate
    # Try as directory with index file
    for e in extensions:
        candidate = os.path.join(base, "index" + e)
        if candidate in project_files:
            return candidate
    return None


# ---------------------------------------------------------------------------
# Core pipeline functions
# ---------------------------------------------------------------------------


def _build_dependency_graph(
    files: list[str], project_root: str
) -> tuple[list[ImportEntry], dict[str, list[str]]]:
    """Build a dependency graph from parsed imports.

    Parameters
    ----------
    files:
        List of project-relative file paths to analyze.
    project_root:
        Absolute path to the project root.

    Returns
    -------
    Tuple of (all_imports, adjacency) where adjacency maps each file
    to the list of internal files it imports from.
    """
    project_files = set(files)
    all_imports: list[ImportEntry] = []
    adjacency: dict[str, list[str]] = {f: [] for f in files}

    for rel_path in files:
        full_path = os.path.join(project_root, rel_path)
        try:
            with open(full_path, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read()
        except OSError:
            continue

        imports = parse_imports(rel_path, content)
        all_imports.extend(imports)

        language = detect_language(rel_path)
        if language is None:
            continue

        seen_targets: set[str] = set()
        for imp in imports:
            if imp.import_type not in ("internal", "external"):
                continue
            target = _resolve_import_to_file(
                imp.imported_module, language, project_files, project_root
            )
            if target and target != rel_path and target not in seen_targets:
                seen_targets.add(target)
                adjacency[rel_path].append(target)

    return all_imports, adjacency


def _cluster_files(
    files: list[str],
    adjacency: dict[str, list[str]],
    max_cluster_size: int = 15,
) -> list[dict]:
    """Cluster files by dependency connectivity and directory proximity.

    1. Find connected components in the undirected dependency graph.
    2. Split components larger than ``max_cluster_size`` by directory subtree.
    3. Isolated files (no edges) are grouped by their parent directory.

    Parameters
    ----------
    files:
        All file paths to cluster.
    adjacency:
        Directed adjacency list (file -> list of targets).
    max_cluster_size:
        Maximum files per cluster before splitting.

    Returns
    -------
    List of cluster dicts with keys: id, name, files, internal_edges, external_edges.
    """
    # Build undirected adjacency for component finding
    undirected: dict[str, set[str]] = {f: set() for f in files}
    all_edges: set[tuple[str, str]] = set()
    for src, targets in adjacency.items():
        for tgt in targets:
            if tgt in undirected:
                undirected[src].add(tgt)
                undirected[tgt].add(src)
                all_edges.add((src, tgt))

    # Find connected components via BFS
    visited: set[str] = set()
    components: list[list[str]] = []
    for f in sorted(files):
        if f in visited:
            continue
        component: list[str] = []
        queue = [f]
        while queue:
            node = queue.pop(0)
            if node in visited:
                continue
            visited.add(node)
            component.append(node)
            for neighbor in sorted(undirected.get(node, set())):
                if neighbor not in visited:
                    queue.append(neighbor)
        if component:
            components.append(sorted(component))

    # Split large components by directory subtree
    final_groups: list[list[str]] = []
    for comp in components:
        if len(comp) <= max_cluster_size:
            final_groups.append(comp)
        else:
            # Group by directory
            dir_groups: dict[str, list[str]] = {}
            for f in comp:
                d = os.path.dirname(f) or "."
                dir_groups.setdefault(d, []).append(f)
            for d in sorted(dir_groups):
                group = dir_groups[d]
                # Further split if still too large
                for i in range(0, len(group), max_cluster_size):
                    final_groups.append(group[i : i + max_cluster_size])

    # Build cluster dicts
    clusters: list[dict] = []
    file_to_cluster: dict[str, int] = {}

    for idx, group in enumerate(final_groups):
        cluster_id = idx
        for f in group:
            file_to_cluster[f] = cluster_id

        # Compute common prefix for name
        if len(group) == 1:
            name = os.path.dirname(group[0]) or os.path.splitext(group[0])[0]
        else:
            name = os.path.commonpath(group) if group else "root"
        if not name or name == ".":
            name = "root"

        # Count edges
        internal_edges = 0
        external_edges = 0
        cluster_set = set(group)
        for f in group:
            for tgt in adjacency.get(f, []):
                if tgt in cluster_set:
                    internal_edges += 1
                else:
                    external_edges += 1

        clusters.append(
            {
                "id": cluster_id,
                "name": name,
                "files": group,
                "internal_edges": internal_edges,
                "external_edges": external_edges,
            }
        )

    return clusters


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def generate_structural_map(
    project_root: str,
    scope: list[str] | None = None,
) -> dict:
    """Generate a PCD structural map for the project.

    Parameters
    ----------
    project_root:
        Absolute path to the project root.
    scope:
        If provided, only process these files (project-relative paths).
        Used for scoped steward-review mode.

    Returns
    -------
    A dict conforming to ``STRUCTURAL_MAP_SCHEMA``.
    The map is also written to ``.prove/steward/pcd/structural-map.json``.
    """
    project_root = os.path.abspath(project_root)

    if scope is not None:
        files = list(scope)
    else:
        config = load_config(project_root, require=False)
        files = walk_project(
            project_root,
            excludes=config.get("excludes", []),
            max_file_size=config.get("max_file_size", 102400),
        )

    # Build dependency graph
    all_imports, adjacency = _build_dependency_graph(files, project_root)

    # Cluster files
    clusters = _cluster_files(files, adjacency)

    # Build file-to-cluster mapping
    file_to_cluster: dict[str, int] = {}
    for cluster in clusters:
        for f in cluster["files"]:
            file_to_cluster[f] = cluster["id"]

    # Build reverse adjacency (imported_by)
    imported_by: dict[str, list[str]] = {f: [] for f in files}
    for src, targets in adjacency.items():
        for tgt in targets:
            if tgt in imported_by:
                imported_by[tgt].append(src)
    # Deduplicate and sort
    for key in imported_by:
        imported_by[key] = sorted(set(imported_by[key]))

    # Load CAFI cache for descriptions
    cache_path = os.path.join(project_root, CACHE_PATH)
    cafi_cache = load_cache(cache_path)
    cafi_files = cafi_cache.get("files", {})

    # Count lines and build language stats
    total_lines = 0
    language_counts: dict[str, int] = {}

    modules: list[dict] = []
    dependency_edges: list[dict] = []

    for rel_path in sorted(files):
        full_path = os.path.join(project_root, rel_path)
        lines = _count_lines(full_path)
        total_lines += lines

        language = detect_language(rel_path) or "unknown"
        language_counts[language] = language_counts.get(language, 0) + 1

        # CAFI description
        cafi_entry = cafi_files.get(rel_path)
        cafi_desc = cafi_entry.get("description") if cafi_entry else None
        if cafi_desc == "":
            cafi_desc = None

        module_dict: dict = {
            "path": rel_path,
            "lines": lines,
            "language": language,
            "exports": [],  # Export extraction is a future enhancement
            "imports_from": sorted(set(adjacency.get(rel_path, []))),
            "imported_by": imported_by.get(rel_path, []),
            "cluster_id": file_to_cluster.get(rel_path, 0),
        }
        if cafi_desc is not None:
            module_dict["cafi_description"] = cafi_desc

        modules.append(module_dict)

        # Dependency edges
        for tgt in adjacency.get(rel_path, []):
            dependency_edges.append(
                {"from": rel_path, "to": tgt, "type": "internal"}
            )

    structural_map: dict = {
        "version": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "generated_by": "deterministic",
        "summary": {
            "total_files": len(files),
            "total_lines": total_lines,
            "languages": language_counts,
        },
        "modules": modules,
        "clusters": clusters,
        "dependency_edges": dependency_edges,
    }

    # Write output
    output_dir = os.path.join(project_root, OUTPUT_DIR)
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, OUTPUT_FILE)
    with open(output_path, "w") as f:
        json.dump(structural_map, f, indent=2)
        f.write("\n")

    return structural_map

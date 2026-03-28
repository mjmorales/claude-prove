"""Tests for PCD structural map generator (Round 0a)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from unittest.mock import patch

# Ensure tools/ is on sys.path
_pcd_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_pcd_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from pcd.structural_map import (  # noqa: E402
    _build_dependency_graph,
    _cluster_files,
    _count_lines,
    _resolve_import_to_file,
    generate_structural_map,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write(tmpdir: str, rel_path: str, content: str) -> None:
    """Write a file at a relative path under tmpdir."""
    full = os.path.join(tmpdir, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCountLines:
    """Tests for _count_lines."""

    def test_counts_lines(self, tmp_path: object) -> None:
        p = str(tmp_path)  # type: ignore[arg-type]
        fpath = os.path.join(p, "sample.py")
        with open(fpath, "w") as f:
            f.write("line1\nline2\nline3\n")
        assert _count_lines(fpath) == 3

    def test_empty_file(self, tmp_path: object) -> None:
        p = str(tmp_path)  # type: ignore[arg-type]
        fpath = os.path.join(p, "empty.py")
        with open(fpath, "w") as f:
            f.write("")
        assert _count_lines(fpath) == 0

    def test_nonexistent_file(self) -> None:
        assert _count_lines("/nonexistent/path.py") == 0

    def test_single_line_no_newline(self, tmp_path: object) -> None:
        p = str(tmp_path)  # type: ignore[arg-type]
        fpath = os.path.join(p, "one.py")
        with open(fpath, "w") as f:
            f.write("single line")
        assert _count_lines(fpath) == 1


class TestResolveImportToFile:
    """Tests for _resolve_import_to_file."""

    def test_python_module_file(self) -> None:
        files = {"cafi/hasher.py", "cafi/__init__.py"}
        result = _resolve_import_to_file("cafi.hasher", "python", files, "/tmp")
        assert result == "cafi/hasher.py"

    def test_python_package_init(self) -> None:
        files = {"cafi/__init__.py"}
        result = _resolve_import_to_file("cafi", "python", files, "/tmp")
        assert result == "cafi/__init__.py"

    def test_python_relative_import_returns_none(self) -> None:
        files = {"utils.py"}
        result = _resolve_import_to_file(".utils", "python", files, "/tmp")
        assert result is None

    def test_python_no_match(self) -> None:
        files = {"other.py"}
        result = _resolve_import_to_file("nonexistent", "python", files, "/tmp")
        assert result is None

    def test_rust_crate_import(self) -> None:
        files = {"src/parser.rs", "src/main.rs"}
        result = _resolve_import_to_file(
            "crate::parser::Parser", "rust", files, "/tmp"
        )
        assert result == "src/parser.rs"

    def test_rust_crate_mod_rs(self) -> None:
        files = {"src/parser/mod.rs", "src/main.rs"}
        result = _resolve_import_to_file(
            "crate::parser::Parser", "rust", files, "/tmp"
        )
        assert result == "src/parser/mod.rs"

    def test_js_relative_import(self) -> None:
        files = {"utils.js", "index.js"}
        result = _resolve_import_to_file("./utils", "javascript", files, "/tmp")
        assert result == "utils.js"

    def test_ts_relative_import(self) -> None:
        files = {"lib/helpers.ts", "index.ts"}
        result = _resolve_import_to_file(
            "./lib/helpers", "typescript", files, "/tmp"
        )
        assert result == "lib/helpers.ts"

    def test_js_index_file(self) -> None:
        files = {"components/index.js"}
        result = _resolve_import_to_file(
            "./components", "javascript", files, "/tmp"
        )
        assert result == "components/index.js"

    def test_js_non_relative_returns_none(self) -> None:
        files = {"react.js"}
        result = _resolve_import_to_file("react", "javascript", files, "/tmp")
        assert result is None

    def test_unknown_language(self) -> None:
        files = {"foo.txt"}
        result = _resolve_import_to_file("foo", "unknown", files, "/tmp")
        assert result is None


class TestBuildDependencyGraph:
    """Tests for _build_dependency_graph."""

    def test_python_imports(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(
                tmpdir,
                "app.py",
                "from models import User\nimport utils\n",
            )
            _write(tmpdir, "models.py", "class User: pass\n")
            _write(tmpdir, "utils.py", "def helper(): pass\n")

            files = ["app.py", "models.py", "utils.py"]
            all_imports, adj = _build_dependency_graph(files, tmpdir)

            assert len(all_imports) > 0
            assert "models.py" in adj["app.py"]
            assert "utils.py" in adj["app.py"]
            assert adj["models.py"] == []
            assert adj["utils.py"] == []

    def test_nonexistent_file_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            files = ["missing.py"]
            all_imports, adj = _build_dependency_graph(files, tmpdir)
            assert all_imports == []
            assert adj == {"missing.py": []}


class TestClusterFiles:
    """Tests for _cluster_files."""

    def test_single_component(self) -> None:
        files = ["a.py", "b.py", "c.py"]
        adj: dict[str, list[str]] = {
            "a.py": ["b.py"],
            "b.py": ["c.py"],
            "c.py": [],
        }
        clusters = _cluster_files(files, adj)
        # All three form one connected component
        assert len(clusters) == 1
        assert sorted(clusters[0]["files"]) == ["a.py", "b.py", "c.py"]
        assert clusters[0]["internal_edges"] > 0

    def test_two_components(self) -> None:
        files = ["a.py", "b.py", "x.py", "y.py"]
        adj: dict[str, list[str]] = {
            "a.py": ["b.py"],
            "b.py": [],
            "x.py": ["y.py"],
            "y.py": [],
        }
        clusters = _cluster_files(files, adj)
        assert len(clusters) == 2

    def test_isolated_files(self) -> None:
        files = ["a.py", "b.py", "c.py"]
        adj: dict[str, list[str]] = {
            "a.py": [],
            "b.py": [],
            "c.py": [],
        }
        clusters = _cluster_files(files, adj)
        # Each file is its own component
        assert len(clusters) == 3

    def test_split_large_component(self) -> None:
        # Create a chain of 20 files, max_cluster_size=5
        files = [f"dir{i // 5}/{chr(97 + i)}.py" for i in range(20)]
        adj: dict[str, list[str]] = {f: [] for f in files}
        # Chain them all together
        for i in range(len(files) - 1):
            adj[files[i]] = [files[i + 1]]
        clusters = _cluster_files(files, adj, max_cluster_size=5)
        # Should be split into multiple clusters
        assert len(clusters) > 1
        # All files should be represented
        all_clustered: list[str] = []
        for c in clusters:
            all_clustered.extend(c["files"])
        assert sorted(all_clustered) == sorted(files)

    def test_empty_files(self) -> None:
        clusters = _cluster_files([], {})
        assert clusters == []

    def test_external_edges_counted(self) -> None:
        files = ["a.py", "b.py", "c.py"]
        adj: dict[str, list[str]] = {
            "a.py": ["b.py"],
            "b.py": [],
            "c.py": [],
        }
        clusters = _cluster_files(files, adj)
        # a.py and b.py form a component, c.py is isolated
        assert len(clusters) == 2
        # Find the cluster containing a.py
        ab_cluster = [c for c in clusters if "a.py" in c["files"]][0]
        assert ab_cluster["internal_edges"] == 1
        assert ab_cluster["external_edges"] == 0


class TestGenerateStructuralMap:
    """Integration tests for generate_structural_map.

    Uses scope parameter to bypass walk_project (which needs git),
    keeping tests self-contained with no external dependencies.
    """

    def test_generate_with_python_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(
                tmpdir,
                "app.py",
                "from models import User\nimport helpers\n\ndef main(): pass\n",
            )
            _write(tmpdir, "models.py", "class User:\n    pass\n")
            _write(tmpdir, "helpers.py", "def help(): pass\n")

            scope = ["app.py", "models.py", "helpers.py"]
            result = generate_structural_map(tmpdir, scope=scope)

            assert result["version"] == 1
            assert result["generated_by"] == "deterministic"
            assert result["summary"]["total_files"] == 3
            assert result["summary"]["total_lines"] > 0
            assert "python" in result["summary"]["languages"]
            assert len(result["modules"]) == 3
            assert len(result["clusters"]) >= 1

            # Check dependency edges
            edges = result["dependency_edges"]
            edge_pairs = [(e["from"], e["to"]) for e in edges]
            assert ("app.py", "models.py") in edge_pairs
            assert ("app.py", "helpers.py") in edge_pairs

            # Check output file was written
            output_path = os.path.join(
                tmpdir, ".prove", "steward", "pcd", "structural-map.json"
            )
            assert os.path.isfile(output_path)
            with open(output_path) as f:
                written = json.load(f)
            assert written["version"] == 1

    def test_scope_limits_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "a.py", "x = 1\n")
            _write(tmpdir, "b.py", "y = 2\n")
            _write(tmpdir, "c.py", "z = 3\n")
            _write(tmpdir, "d.py", "w = 4\n")
            _write(tmpdir, "e.py", "v = 5\n")

            result = generate_structural_map(tmpdir, scope=["a.py", "b.py"])

            assert result["summary"]["total_files"] == 2
            paths = [m["path"] for m in result["modules"]]
            assert sorted(paths) == ["a.py", "b.py"]

    def test_cluster_formation_by_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            # Two directories with no cross-imports
            _write(tmpdir, "pkg_a/mod1.py", "def f(): pass\n")
            _write(tmpdir, "pkg_a/mod2.py", "from pkg_a.mod1 import f\n")
            _write(tmpdir, "pkg_b/mod1.py", "def g(): pass\n")
            _write(tmpdir, "pkg_b/mod2.py", "from pkg_b.mod1 import g\n")

            scope = [
                "pkg_a/mod1.py",
                "pkg_a/mod2.py",
                "pkg_b/mod1.py",
                "pkg_b/mod2.py",
            ]
            result = generate_structural_map(tmpdir, scope=scope)

            # Should form at least 2 clusters (one per package)
            assert len(result["clusters"]) >= 2
            cluster_files = [set(c["files"]) for c in result["clusters"]]
            pkg_a_files = {"pkg_a/mod1.py", "pkg_a/mod2.py"}
            pkg_b_files = {"pkg_b/mod1.py", "pkg_b/mod2.py"}
            assert any(pkg_a_files <= cf for cf in cluster_files)
            assert any(pkg_b_files <= cf for cf in cluster_files)

    def test_empty_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = generate_structural_map(tmpdir, scope=[])

            assert result["version"] == 1
            assert result["summary"]["total_files"] == 0
            assert result["summary"]["total_lines"] == 0
            assert result["modules"] == []
            assert result["clusters"] == []
            assert result["dependency_edges"] == []

    def test_no_cafi_cache(self) -> None:
        """Verify graceful handling when no CAFI cache exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "main.py", "print('hello')\n")

            # No .prove/file-index.json exists
            result = generate_structural_map(tmpdir, scope=["main.py"])

            assert result["summary"]["total_files"] == 1
            # cafi_description should be absent (not set to null)
            mod = result["modules"][0]
            assert "cafi_description" not in mod

    def test_cafi_descriptions_enriched(self) -> None:
        """Verify CAFI descriptions are picked up when cache exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "main.py", "print('hello')\n")

            # Create a fake CAFI cache
            cache_dir = os.path.join(tmpdir, ".prove")
            os.makedirs(cache_dir, exist_ok=True)
            cache = {
                "version": 1,
                "files": {
                    "main.py": {
                        "hash": "abc123",
                        "description": "Entry point script",
                    }
                },
            }
            with open(os.path.join(cache_dir, "file-index.json"), "w") as f:
                json.dump(cache, f)

            result = generate_structural_map(tmpdir, scope=["main.py"])

            mod = result["modules"][0]
            assert mod["cafi_description"] == "Entry point script"

    def test_imported_by_populated(self) -> None:
        """Verify imported_by is correctly populated."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "lib.py", "def func(): pass\n")
            _write(tmpdir, "app.py", "import lib\n")

            result = generate_structural_map(
                tmpdir, scope=["lib.py", "app.py"]
            )

            mods = {m["path"]: m for m in result["modules"]}
            assert "app.py" in mods["lib.py"]["imported_by"]
            assert mods["app.py"]["imports_from"] == ["lib.py"]

    def test_walk_project_used_without_scope(self) -> None:
        """Verify walk_project is called when no scope is provided."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "main.py", "x = 1\n")

            with patch("pcd.structural_map.walk_project") as mock_walk:
                mock_walk.return_value = ["main.py"]
                with patch("pcd.structural_map.load_config") as mock_cfg:
                    mock_cfg.return_value = {
                        "excludes": [],
                        "max_file_size": 102400,
                    }
                    result = generate_structural_map(tmpdir)

            mock_walk.assert_called_once()
            assert result["summary"]["total_files"] == 1

    def test_output_json_written(self) -> None:
        """Verify the output JSON file is created in the expected location."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _write(tmpdir, "a.py", "x = 1\n")

            generate_structural_map(tmpdir, scope=["a.py"])

            output_path = os.path.join(
                tmpdir, ".prove", "steward", "pcd", "structural-map.json"
            )
            assert os.path.isfile(output_path)
            with open(output_path) as f:
                data = json.load(f)
            assert data["version"] == 1
            assert data["generated_by"] == "deterministic"

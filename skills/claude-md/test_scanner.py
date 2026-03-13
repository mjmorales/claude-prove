"""Tests for the codebase scanner."""

from __future__ import annotations

import json
import os
import sys

import pytest

# Add skill dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scanner import scan_project, _detect_naming, _scan_tech_stack, _scan_key_dirs


@pytest.fixture
def go_project(tmp_path):
    """Create a minimal Go project."""
    (tmp_path / "go.mod").write_text("module example.com/myapp\n\ngo 1.21\n")
    (tmp_path / "cmd").mkdir()
    (tmp_path / "cmd" / "main.go").write_text("package main\n")
    (tmp_path / "internal").mkdir()
    (tmp_path / "internal" / "handler.go").write_text("package internal\n")
    (tmp_path / "internal" / "handler_test.go").write_text("package internal\n")
    return str(tmp_path)


@pytest.fixture
def node_project(tmp_path):
    """Create a minimal Node.js project."""
    pkg = {"name": "my-app", "dependencies": {"react": "^18.0.0", "next": "^14.0.0"}}
    (tmp_path / "package.json").write_text(json.dumps(pkg))
    (tmp_path / "tsconfig.json").write_text("{}")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export default function App() {}")
    (tmp_path / "src" / "App.test.tsx").write_text("test('renders', () => {})")
    (tmp_path / "components").mkdir()
    return str(tmp_path)


@pytest.fixture
def python_project(tmp_path):
    """Create a minimal Python project."""
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "my-lib"\n')
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "my_module.py").write_text("def hello(): pass\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_my_module.py").write_text("def test_hello(): pass\n")
    return str(tmp_path)


class TestScanProject:
    def test_go_project(self, go_project):
        scan = scan_project(go_project)
        assert "Go" in scan["tech_stack"]["languages"]
        assert "go" in scan["tech_stack"]["build_systems"]
        assert "cmd" in scan["key_dirs"]
        assert "internal" in scan["key_dirs"]

    def test_node_project(self, node_project):
        scan = scan_project(node_project)
        assert "JavaScript/TypeScript" in scan["tech_stack"]["languages"]
        assert "React" in scan["tech_stack"]["frameworks"]
        assert "Next.js" in scan["tech_stack"]["frameworks"]
        assert "src" in scan["key_dirs"]
        assert "components" in scan["key_dirs"]

    def test_python_project(self, python_project):
        scan = scan_project(python_project)
        assert "Python" in scan["tech_stack"]["languages"]
        assert "pip" in scan["tech_stack"]["build_systems"]
        assert "tests" in scan["key_dirs"]

    def test_project_name_from_package_json(self, node_project):
        scan = scan_project(node_project)
        assert scan["project"]["name"] == "my-app"

    def test_project_name_from_pyproject(self, python_project):
        scan = scan_project(python_project)
        assert scan["project"]["name"] == "my-lib"

    def test_project_name_fallback_to_dirname(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["project"]["name"] == tmp_path.name

    def test_empty_project(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["tech_stack"]["languages"] == []
        assert scan["key_dirs"] == {}


class TestDetectNaming:
    def test_snake_case(self):
        assert _detect_naming(["my_module.py", "test_helper.py", "utils.py"]) == "snake_case"

    def test_kebab_case(self):
        assert _detect_naming(["my-component.tsx", "api-handler.ts"]) == "kebab-case"

    def test_camel_case(self):
        assert _detect_naming(["myModule.js", "apiHandler.js"]) == "camelCase"

    def test_pascal_case(self):
        assert _detect_naming(["MyComponent.tsx", "ApiHandler.ts"]) == "PascalCase"

    def test_empty_list(self):
        assert _detect_naming([]) == "unknown"


class TestScanKeyDirs:
    def test_ignores_hidden_dirs(self, tmp_path):
        (tmp_path / ".git").mkdir()
        (tmp_path / "src").mkdir()
        dirs = _scan_key_dirs(str(tmp_path))
        assert ".git" not in dirs
        assert "src" in dirs

    def test_only_known_dirs(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "random_folder").mkdir()
        dirs = _scan_key_dirs(str(tmp_path))
        assert "src" in dirs
        assert "random_folder" not in dirs


class TestScanProveConfig:
    def test_with_prove_json(self, tmp_path):
        config = {
            "validators": [
                {"name": "build", "command": "go build ./...", "phase": "build"}
            ],
            "index": {"excludes": [], "max_file_size": 102400},
        }
        (tmp_path / ".prove.json").write_text(json.dumps(config))
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["exists"] is True
        assert len(scan["prove_config"]["validators"]) == 1
        assert scan["prove_config"]["has_index"] is True

    def test_without_prove_json(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["exists"] is False

    def test_cafi_available(self, tmp_path):
        prove_dir = tmp_path / ".prove"
        prove_dir.mkdir()
        cache = {"version": 1, "files": {"a.py": {"hash": "x", "description": "y"}}}
        (prove_dir / "file-index.json").write_text(json.dumps(cache))
        scan = scan_project(str(tmp_path))
        assert scan["cafi"]["available"] is True
        assert scan["cafi"]["file_count"] == 1

    def test_cafi_not_available(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["cafi"]["available"] is False
        assert scan["cafi"]["file_count"] == 0

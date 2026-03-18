#!/usr/bin/env python3
"""
Code exploration helper for task planning discovery phase.
Provides utilities to understand codebases quickly.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from typing import Any
import argparse

class CodeExplorer:
    """Utilities for exploring and understanding codebases."""

    def __init__(self, root_path: str = "."):
        self.root = Path(root_path).resolve()

    def find_related_files(self, keyword: str, extensions: list[str] | None = None) -> list[Path]:
        """Find files containing a keyword."""
        if extensions is None:
            extensions = ['.py', '.js', '.java', '.cpp', '.go', '.rs']

        # Build a single find command with all extensions to avoid per-extension spawning
        name_clauses = " -o ".join(
            f"-name {shlex.quote('*' + ext)}" for ext in extensions
        )
        cmd = (
            f"find {shlex.quote(str(self.root))} -type f"
            f" \\( {name_clauses} \\)"
            f" -exec grep -l {shlex.quote(keyword)} {{}} +"
        )
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

        if not result.stdout:
            return []

        return list({Path(f) for f in result.stdout.strip().split('\n') if f})

    def analyze_imports(self, file_path: str) -> dict[str, list[str]]:
        """Analyze imports/dependencies in a file."""
        file_path = Path(file_path)
        if not file_path.exists():
            return {}

        content = file_path.read_text()
        imports: dict[str, list[str]] = {
            'standard': [],
            'external': [],
            'internal': []
        }

        if file_path.suffix == '.py':
            lines = content.split('\n')
            for line in lines:
                if line.startswith('import ') or line.startswith('from '):
                    module = line.split()[1].split('.')[0]
                    if module in ['os', 'sys', 'json', 'datetime', 'collections', 're']:
                        imports['standard'].append(line.strip())
                    elif '.' in line and line.startswith('from .'):
                        imports['internal'].append(line.strip())
                    else:
                        imports['external'].append(line.strip())

        return imports

    def find_function_usages(self, function_name: str) -> dict[str, list[str]]:
        """Find all usages of a function across the codebase."""
        usages: dict[str, list[str]] = {}

        cmd = (
            f"grep -r {shlex.quote(function_name + '(')} {shlex.quote(str(self.root))}"
            f" --include='*.py' --include='*.js' 2>/dev/null"
        )
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

        if result.stdout:
            for line in result.stdout.strip().split('\n'):
                if ':' in line:
                    fpath, code = line.split(':', 1)
                    if fpath not in usages:
                        usages[fpath] = []
                    usages[fpath].append(code.strip())

        return usages

    def get_file_structure(self, path: str | None = None, max_depth: int = 3) -> str:
        """Get directory structure."""
        target = shlex.quote(str(path or self.root))

        # Use tree if available, otherwise fall back to find
        tree_cmd = f"tree -L {int(max_depth)} {target} -I '__pycache__|*.pyc|node_modules|.git'"
        result = subprocess.run(tree_cmd, shell=True, capture_output=True, text=True)

        if result.returncode == 0:
            return result.stdout

        find_cmd = (
            f"find {target} -maxdepth {int(max_depth)} -type f"
            f" \\( -name '*.py' -o -name '*.js' \\) | sort"
        )
        result = subprocess.run(find_cmd, shell=True, capture_output=True, text=True)
        return result.stdout

    def find_tests(self, component_name: str) -> list[Path]:
        """Find test files related to a component."""
        safe_name = shlex.quote(component_name)
        test_patterns = [
            f"test_{safe_name}",
            f"{safe_name}_test",
            f"test*{safe_name}*",
            f"{safe_name}*test*"
        ]

        test_files = []
        for pattern in test_patterns:
            cmd = (
                f"find {shlex.quote(str(self.root))}"
                f" -name '{pattern}.py' -o -name '{pattern}.js' 2>/dev/null"
            )
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            if result.stdout:
                files = result.stdout.strip().split('\n')
                test_files.extend([Path(f) for f in files if f])

        return list(set(test_files))

    def get_git_history(self, file_path: str, num_commits: int = 10) -> str:
        """Get recent git history for a file."""
        cmd = f"git log --oneline -{int(num_commits)} -- {shlex.quote(file_path)}"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=self.root)
        return result.stdout

    def find_todos(self) -> dict[str, list[str]]:
        """Find TODO/FIXME/HACK comments."""
        todos: dict[str, list[str]] = {}

        cmd = (
            f"grep -r 'TODO\\|FIXME\\|XXX\\|HACK' {shlex.quote(str(self.root))}"
            f" --include='*.py' --include='*.js' 2>/dev/null"
        )
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

        if result.stdout:
            for line in result.stdout.strip().split('\n'):
                if ':' in line:
                    fpath, comment = line.split(':', 1)
                    if fpath not in todos:
                        todos[fpath] = []
                    todos[fpath].append(comment.strip())

        return todos

    def analyze_complexity(self, file_path: str) -> dict[str, Any]:
        """Basic complexity analysis of a file."""
        file_path = Path(file_path)
        if not file_path.exists():
            return {}

        content = file_path.read_text()
        lines = content.split('\n')

        stats: dict[str, Any] = {
            'total_lines': len(lines),
            'code_lines': len([line for line in lines if line.strip() and not line.strip().startswith('#')]),
            'comment_lines': len([line for line in lines if line.strip().startswith('#')]),
            'functions': [],
            'classes': [],
            'complexity_warnings': []
        }

        # Simple analysis for Python files
        if file_path.suffix == '.py':
            for i, line in enumerate(lines, 1):
                if line.strip().startswith('def '):
                    func_name = line.split('(')[0].replace('def ', '')
                    stats['functions'].append(func_name)
                elif line.strip().startswith('class '):
                    class_name = line.split('(')[0].split(':')[0].replace('class ', '')
                    stats['classes'].append(class_name)

                # Complexity warnings
                if len(line) > 120:
                    stats['complexity_warnings'].append(f"Line {i}: Very long line ({len(line)} chars)")
                if line.count('if ') > 2:
                    stats['complexity_warnings'].append(f"Line {i}: Multiple conditions")

        return stats

def main():
    parser = argparse.ArgumentParser(description='Code exploration helper for task planning')
    parser.add_argument('command', choices=['find', 'imports', 'usages', 'structure', 'tests', 'history', 'todos', 'analyze'],
                       help='Command to execute')
    parser.add_argument('target', nargs='?', help='Target (file, function, or keyword)')
    parser.add_argument('--path', default='.', help='Root path for exploration')
    parser.add_argument('--depth', type=int, default=3, help='Max depth for structure command')
    parser.add_argument('--extensions', nargs='+', help='File extensions to search')

    args = parser.parse_args()

    explorer = CodeExplorer(args.path)

    if args.command == 'find' and args.target:
        files = explorer.find_related_files(args.target, args.extensions)
        print(f"Files related to '{args.target}':")
        for f in files:
            print(f"  - {f}")

    elif args.command == 'imports' and args.target:
        imports = explorer.analyze_imports(args.target)
        if imports:
            print(f"Imports in {args.target}:")
            for category, items in imports.items():
                if items:
                    print(f"\n{category.capitalize()} imports:")
                    for item in items:
                        print(f"  {item}")

    elif args.command == 'usages' and args.target:
        usages = explorer.find_function_usages(args.target)
        if usages:
            print(f"Usages of '{args.target}':")
            for file_path, uses in usages.items():
                print(f"\n{file_path}:")
                for use in uses[:3]:  # Show first 3 usages per file
                    print(f"  {use[:100]}...")

    elif args.command == 'structure':
        structure = explorer.get_file_structure(args.target, args.depth)
        print("Directory structure:")
        print(structure)

    elif args.command == 'tests' and args.target:
        tests = explorer.find_tests(args.target)
        if tests:
            print(f"Test files for '{args.target}':")
            for test in tests:
                print(f"  - {test}")
        else:
            print(f"No test files found for '{args.target}'")

    elif args.command == 'history' and args.target:
        history = explorer.get_git_history(args.target)
        if history:
            print(f"Git history for {args.target}:")
            print(history)
        else:
            print(f"No git history found for {args.target}")

    elif args.command == 'todos':
        todos = explorer.find_todos()
        if todos:
            print("TODO/FIXME/HACK comments found:")
            for file_path, comments in todos.items():
                print(f"\n{file_path}:")
                for comment in comments[:3]:  # Show first 3 per file
                    print(f"  {comment[:100]}...")
        else:
            print("No TODO/FIXME comments found")

    elif args.command == 'analyze' and args.target:
        analysis = explorer.analyze_complexity(args.target)
        if analysis:
            print(f"Analysis of {args.target}:")
            print(f"  Total lines: {analysis['total_lines']}")
            print(f"  Code lines: {analysis['code_lines']}")
            print(f"  Comment lines: {analysis['comment_lines']}")
            if analysis['functions']:
                print(f"  Functions: {', '.join(analysis['functions'][:5])}")
            if analysis['classes']:
                print(f"  Classes: {', '.join(analysis['classes'])}")
            if analysis['complexity_warnings']:
                print("  Complexity warnings:")
                for warning in analysis['complexity_warnings'][:5]:
                    print(f"    - {warning}")

    else:
        parser.print_help()

if __name__ == "__main__":
    main()

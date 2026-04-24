/**
 * Unit tests for detect.ts — parity with `scripts/init-config.sh`.
 *
 * Each stack test builds a throwaway fixture dir, runs `detectValidators`,
 * and asserts the exact entry list. Python tests stub `PATH` so the
 * ruff/mypy branch is deterministic across environments.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DETECTED_VALIDATOR_NAMES, type DetectedValidator, detectValidators } from './detect';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'detect-test-'));
}

function write(dir: string, rel: string, body: string): void {
  const full = join(dir, rel);
  const parent = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, body);
}

describe('detectValidators', () => {
  test('empty directory returns no validators', () => {
    const dir = tmp();
    try {
      expect(detectValidators(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Go project emits build/lint/test', () => {
    const dir = tmp();
    try {
      write(dir, 'go.mod', 'module x\n\ngo 1.22\n');
      expect(detectValidators(dir)).toEqual([
        { name: 'build', command: 'go build ./...', phase: 'build' },
        { name: 'lint', command: 'go vet ./...', phase: 'lint' },
        { name: 'tests', command: 'go test ./...', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Rust project emits check/clippy/test', () => {
    const dir = tmp();
    try {
      write(dir, 'Cargo.toml', '[package]\nname = "x"\n');
      expect(detectValidators(dir)).toEqual([
        { name: 'check', command: 'cargo check', phase: 'build' },
        { name: 'clippy', command: 'cargo clippy -- -D warnings', phase: 'lint' },
        { name: 'tests', command: 'cargo test', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('Python', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env.PATH;
    });
    afterEach(() => {
      if (savedPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = savedPath;
    });

    test('pyproject.toml without ruff/mypy emits only pytest', () => {
      const dir = tmp();
      try {
        write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
        process.env.PATH = '/tmp/definitely-empty-path';
        expect(detectValidators(dir)).toEqual([
          { name: 'tests', command: 'pytest', phase: 'test' },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('pyproject.toml with ruff on PATH emits ruff + pytest', () => {
      const dir = tmp();
      const pathDir = mkdtempSync(join(tmpdir(), 'detect-path-'));
      try {
        write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
        const ruff = join(pathDir, 'ruff');
        writeFileSync(ruff, '#!/bin/sh\nexit 0\n');
        chmodSync(ruff, 0o755);
        process.env.PATH = pathDir;
        expect(detectValidators(dir)).toEqual([
          { name: 'lint', command: 'ruff check .', phase: 'lint' },
          { name: 'tests', command: 'pytest', phase: 'test' },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(pathDir, { recursive: true, force: true });
      }
    });

    test('setup.py triggers Python detection', () => {
      const dir = tmp();
      try {
        write(dir, 'setup.py', 'from setuptools import setup\nsetup()\n');
        process.env.PATH = '/tmp/definitely-empty-path';
        expect(detectValidators(dir)).toEqual([
          { name: 'tests', command: 'pytest', phase: 'test' },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('Node project without tsconfig or eslint emits npm test only', () => {
    const dir = tmp();
    try {
      write(dir, 'package.json', '{"name":"x"}');
      expect(detectValidators(dir)).toEqual([
        { name: 'tests', command: 'npm test', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Node project with tsconfig + eslint emits build + lint + test', () => {
    const dir = tmp();
    try {
      write(dir, 'package.json', '{"name":"x"}');
      write(dir, 'tsconfig.json', '{}');
      write(dir, 'eslint.config.js', 'export default [];\n');
      expect(detectValidators(dir)).toEqual([
        { name: 'build', command: 'tsc --noEmit', phase: 'build' },
        { name: 'lint', command: 'npx eslint .', phase: 'lint' },
        { name: 'tests', command: 'npm test', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Godot project with GUT emits gut test runner', () => {
    const dir = tmp();
    try {
      write(dir, 'project.godot', 'config/name="x"\n');
      mkdirSync(join(dir, 'addons', 'gut'), { recursive: true });
      expect(detectValidators(dir)).toEqual([
        {
          name: 'tests',
          command: 'godot --headless -s addons/gut/gut_cmdln.gd',
          phase: 'test',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Godot project without GUT emits nothing', () => {
    const dir = tmp();
    try {
      write(dir, 'project.godot', 'config/name="x"\n');
      expect(detectValidators(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Makefile alone emits detected targets', () => {
    const dir = tmp();
    try {
      write(dir, 'Makefile', 'test:\n\tgo test ./...\nlint:\n\tgo vet ./...\n');
      expect(detectValidators(dir)).toEqual([
        { name: 'tests', command: 'make test', phase: 'test' },
        { name: 'lint', command: 'make lint', phase: 'lint' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Makefile defers to upstream detector when phase already filled', () => {
    const dir = tmp();
    try {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'Makefile', 'test:\n\tmake-test\nlint:\n\tmake-lint\n');
      const got = detectValidators(dir);
      // Makefile test/lint targets NOT emitted — go already claimed both.
      expect(got.some((v) => v.command.startsWith('make '))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DETECTED_VALIDATOR_NAMES', () => {
  test('covers every name any detector could emit', () => {
    // Build a superset fixture so every branch fires, then verify the
    // constant is a valid superset of actually-emitted names.
    const dir = tmp();
    const pathDir = mkdtempSync(join(tmpdir(), 'detect-all-'));
    const savedPath = process.env.PATH;
    try {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'Cargo.toml', '[package]\nname="x"\n');
      write(dir, 'pyproject.toml', '[project]\nname="x"\n');
      write(dir, 'package.json', '{"name":"x"}');
      write(dir, 'tsconfig.json', '{}');
      write(dir, 'eslint.config.js', 'export default [];\n');
      write(dir, 'project.godot', 'config/name="x"\n');
      mkdirSync(join(dir, 'addons', 'gut'), { recursive: true });
      write(dir, 'Makefile', 'test:\n\tt\nlint:\n\tl\n');
      const ruff = join(pathDir, 'ruff');
      writeFileSync(ruff, '#!/bin/sh\nexit 0\n');
      chmodSync(ruff, 0o755);
      process.env.PATH = pathDir;
      const emitted: DetectedValidator[] = detectValidators(dir);
      const emittedNames = new Set(emitted.map((v) => v.name));
      for (const name of emittedNames) {
        expect(DETECTED_VALIDATOR_NAMES).toContain(name);
      }
    } finally {
      if (savedPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });
});

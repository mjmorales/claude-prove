/**
 * Unit tests for the claude-md scanner.
 *
 * Ports the coverage from `skills/claude-md/test_scanner.py`:
 *   - tech-stack detection across Go / Node / Python fixture projects
 *   - project-name resolution (package.json, pyproject.toml, dirname fallback)
 *   - _scan_key_dirs filtering (hidden + unknown dirs excluded)
 *   - _detect_naming voting across conventions
 *   - _scan_prove_config / CAFI presence toggles
 *   - external references pass-through
 *   - tool directives from enabled tool manifests
 *   - core-commands frontmatter parsing
 *   - plugin-version read
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  detectNaming,
  scanCoreCommands,
  scanKeyDirs,
  scanPluginVersion,
  scanProject,
} from './scanner';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'claude-md-scanner-'));
}

function write(root: string, rel: string, content = ''): void {
  const full = join(root, rel);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

// ---------------------------------------------------------------------------
// Fixture builders (match Python pytest fixtures 1:1)
// ---------------------------------------------------------------------------

function buildGoProject(): string {
  const root = tmp();
  write(root, 'go.mod', 'module example.com/myapp\n\ngo 1.21\n');
  write(root, 'cmd/main.go', 'package main\n');
  write(root, 'internal/handler.go', 'package internal\n');
  write(root, 'internal/handler_test.go', 'package internal\n');
  return root;
}

function buildNodeProject(): string {
  const root = tmp();
  const pkg = { name: 'my-app', dependencies: { react: '^18.0.0', next: '^14.0.0' } };
  write(root, 'package.json', JSON.stringify(pkg));
  write(root, 'tsconfig.json', '{}');
  write(root, 'src/App.tsx', 'export default function App() {}');
  write(root, 'src/App.test.tsx', "test('renders', () => {})");
  mkdirSync(join(root, 'components'));
  return root;
}

function buildPythonProject(): string {
  const root = tmp();
  write(root, 'pyproject.toml', '[project]\nname = "my-lib"\n');
  write(root, 'src/my_module.py', 'def hello(): pass\n');
  write(root, 'tests/test_my_module.py', 'def test_hello(): pass\n');
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanProject — tech stack', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('Go project', () => {
    const root = buildGoProject();
    created.push(root);
    const scan = scanProject(root);
    expect(scan.tech_stack.languages).toContain('Go');
    expect(scan.tech_stack.build_systems).toContain('go');
    expect(scan.key_dirs.cmd).toBe('Go CLI entry points');
    expect(scan.key_dirs.internal).toBe('Internal packages');
  });

  test('Node + TypeScript + React + Next.js', () => {
    const root = buildNodeProject();
    created.push(root);
    const scan = scanProject(root);
    expect(scan.tech_stack.languages).toContain('JavaScript/TypeScript');
    expect(scan.tech_stack.frameworks).toContain('React');
    expect(scan.tech_stack.frameworks).toContain('Next.js');
    expect(scan.key_dirs.src).toBe('Source code');
    expect(scan.key_dirs.components).toBe('UI components');
  });

  test('Python project', () => {
    const root = buildPythonProject();
    created.push(root);
    const scan = scanProject(root);
    expect(scan.tech_stack.languages).toContain('Python');
    expect(scan.tech_stack.build_systems).toContain('pip');
    expect(scan.key_dirs.tests).toBe('Test files');
  });

  test('project name from package.json', () => {
    const root = buildNodeProject();
    created.push(root);
    expect(scanProject(root).project.name).toBe('my-app');
  });

  test('project name from pyproject.toml', () => {
    const root = buildPythonProject();
    created.push(root);
    expect(scanProject(root).project.name).toBe('my-lib');
  });

  test('project name falls back to dirname', () => {
    const root = tmp();
    created.push(root);
    expect(scanProject(root).project.name).toBe(basename(root));
  });

  test('empty project', () => {
    const root = tmp();
    created.push(root);
    const scan = scanProject(root);
    expect(scan.tech_stack.languages).toEqual([]);
    expect(scan.key_dirs).toEqual({});
  });
});

describe('detectNaming', () => {
  test('snake_case', () => {
    expect(detectNaming(['my_module.py', 'test_helper.py', 'utils.py'])).toBe('snake_case');
  });

  test('kebab-case', () => {
    expect(detectNaming(['my-component.tsx', 'api-handler.ts'])).toBe('kebab-case');
  });

  test('camelCase', () => {
    expect(detectNaming(['myModule.js', 'apiHandler.js'])).toBe('camelCase');
  });

  test('PascalCase', () => {
    expect(detectNaming(['MyComponent.tsx', 'ApiHandler.ts'])).toBe('PascalCase');
  });

  test('empty list → unknown', () => {
    expect(detectNaming([])).toBe('unknown');
  });
});

describe('scanKeyDirs', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('ignores hidden dirs', () => {
    const root = tmp();
    created.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src'));
    const dirs = scanKeyDirs(root);
    expect('.git' in dirs).toBe(false);
    expect('src' in dirs).toBe(true);
  });

  test('only known dirs', () => {
    const root = tmp();
    created.push(root);
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'random_folder'));
    const dirs = scanKeyDirs(root);
    expect('src' in dirs).toBe(true);
    expect('random_folder' in dirs).toBe(false);
  });
});

describe('scanProveConfig', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('with .prove.json', () => {
    const root = tmp();
    created.push(root);
    const config = {
      validators: [{ name: 'build', command: 'go build ./...', phase: 'build' }],
      index: { excludes: [], max_file_size: 102400 },
    };
    write(root, '.claude/.prove.json', JSON.stringify(config));
    const scan = scanProject(root);
    expect(scan.prove_config.exists).toBe(true);
    expect(scan.prove_config.validators.length).toBe(1);
    expect(scan.prove_config.has_index).toBe(true);
  });

  test('without .prove.json', () => {
    const root = tmp();
    created.push(root);
    expect(scanProject(root).prove_config.exists).toBe(false);
  });

  test('CAFI cache available', () => {
    const root = tmp();
    created.push(root);
    const cache = { version: 1, files: { 'a.py': { hash: 'x', description: 'y' } } };
    write(root, '.prove/file-index.json', JSON.stringify(cache));
    const scan = scanProject(root);
    expect(scan.cafi.available).toBe(true);
    expect(scan.cafi.file_count).toBe(1);
  });

  test('CAFI cache missing', () => {
    const root = tmp();
    created.push(root);
    const scan = scanProject(root);
    expect(scan.cafi.available).toBe(false);
    expect(scan.cafi.file_count).toBe(0);
  });
});

describe('references', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('reads references from .prove.json', () => {
    const root = tmp();
    created.push(root);
    const config = {
      claude_md: {
        references: [{ path: '~/.claude/standards.md', label: 'Standards' }],
      },
    };
    write(root, '.claude/.prove.json', JSON.stringify(config));
    const scan = scanProject(root);
    expect(scan.prove_config.references).toEqual([
      { path: '~/.claude/standards.md', label: 'Standards' },
    ]);
  });

  test('empty when not configured', () => {
    const root = tmp();
    created.push(root);
    expect(scanProject(root).prove_config.references).toEqual([]);
  });

  test('skips references without path', () => {
    const root = tmp();
    created.push(root);
    const config = {
      claude_md: {
        references: [
          { path: '', label: 'Empty' },
          { label: 'No path' },
          { path: '~/.claude/valid.md', label: 'Valid' },
        ],
      },
    };
    write(root, '.claude/.prove.json', JSON.stringify(config));
    const scan = scanProject(root);
    expect(scan.prove_config.references).toEqual([{ path: '~/.claude/valid.md', label: 'Valid' }]);
  });
});

describe('tool directives', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('reads directives from enabled tools', () => {
    const root = tmp();
    created.push(root);
    write(
      root,
      'tools/acb/tool.json',
      JSON.stringify({
        name: 'acb',
        directive: 'Write intent manifests before committing.',
      }),
    );
    write(root, '.claude/.prove.json', JSON.stringify({ tools: { acb: { enabled: true } } }));

    const scan = scanProject(root, root);
    expect(scan.prove_config.tool_directives).toEqual([
      { name: 'acb', directive: 'Write intent manifests before committing.' },
    ]);
  });

  test('skips disabled tools', () => {
    const root = tmp();
    created.push(root);
    write(
      root,
      'tools/acb/tool.json',
      JSON.stringify({ name: 'acb', directive: 'Write intent manifests.' }),
    );
    write(root, '.claude/.prove.json', JSON.stringify({ tools: { acb: { enabled: false } } }));
    expect(scanProject(root, root).prove_config.tool_directives).toEqual([]);
  });

  test('skips tools without directive', () => {
    const root = tmp();
    created.push(root);
    write(
      root,
      'tools/cafi/tool.json',
      JSON.stringify({ name: 'cafi', description: 'File index' }),
    );
    write(root, '.claude/.prove.json', JSON.stringify({ tools: { cafi: { enabled: true } } }));
    expect(scanProject(root, root).prove_config.tool_directives).toEqual([]);
  });

  test('empty when plugin has no tools/ dir', () => {
    const root = tmp();
    created.push(root);
    const fakePlugin = join(root, 'fake-plugin');
    mkdirSync(fakePlugin);
    write(root, '.claude/.prove.json', JSON.stringify({ tools: { acb: { enabled: true } } }));
    expect(scanProject(root, fakePlugin).prove_config.tool_directives).toEqual([]);
  });
});

describe('scanCoreCommands', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('reads core commands', () => {
    const root = tmp();
    created.push(root);
    write(
      root,
      'commands/index.md',
      '---\ndescription: Update file index\ncore: true\nsummary: Update the file index\n---\n',
    );
    write(root, 'commands/review.md', '---\ndescription: Review changes\n---\n');
    const result = scanCoreCommands(root);
    expect(result).toEqual([{ name: 'index', summary: 'Update the file index' }]);
  });

  test('sorted alphabetically', () => {
    const root = tmp();
    created.push(root);
    write(root, 'commands/zeta.md', '---\ndescription: Zeta\ncore: true\nsummary: Zeta cmd\n---\n');
    write(
      root,
      'commands/alpha.md',
      '---\ndescription: Alpha\ncore: true\nsummary: Alpha cmd\n---\n',
    );
    expect(scanCoreCommands(root).map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  test('empty when no commands/ dir', () => {
    const root = tmp();
    created.push(root);
    expect(scanCoreCommands(root)).toEqual([]);
  });

  test('skips non-md files', () => {
    const root = tmp();
    created.push(root);
    write(root, 'commands/script.sh', '#!/bin/bash\n');
    write(root, 'commands/index.md', '---\ndescription: Index\ncore: true\nsummary: Index\n---\n');
    expect(scanCoreCommands(root).length).toBe(1);
  });

  test('falls back to description when summary missing', () => {
    const root = tmp();
    created.push(root);
    write(root, 'commands/test.md', '---\ndescription: Run all tests\ncore: true\n---\n');
    expect(scanCoreCommands(root)[0].summary).toBe('Run all tests');
  });

  test('skips files without frontmatter', () => {
    const root = tmp();
    created.push(root);
    write(root, 'commands/plain.md', '# No frontmatter\n\nJust content.');
    expect(scanCoreCommands(root)).toEqual([]);
  });
});

describe('scanPluginVersion', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('reads version from plugin.json', () => {
    const root = tmp();
    created.push(root);
    write(root, '.claude-plugin/plugin.json', JSON.stringify({ version: '1.2.3' }));
    expect(scanPluginVersion(root)).toBe('1.2.3');
  });

  test('returns unknown when missing', () => {
    const root = tmp();
    created.push(root);
    expect(scanPluginVersion(root)).toBe('unknown');
  });

  test('returns unknown on invalid JSON', () => {
    const root = tmp();
    created.push(root);
    write(root, '.claude-plugin/plugin.json', 'not json');
    expect(scanPluginVersion(root)).toBe('unknown');
  });
});

// Suppress the unused warning for `beforeEach` — left imported for parity
// with Python's pytest fixture setup style even though we use afterEach only.
void beforeEach;

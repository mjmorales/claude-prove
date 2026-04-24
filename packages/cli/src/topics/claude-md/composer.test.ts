/**
 * Unit tests for the claude-md composer.
 *
 * Ports the coverage from `skills/claude-md/test_composer.py`:
 *   - section inclusion rules (version check, structure, conventions,
 *     validation, discovery, tool directives, references, prove commands)
 *   - managed-block markers + replace semantics
 *   - subagent context shape
 *   - writeClaudeMd merge vs full-replace behavior
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_END,
  MANAGED_START,
  compose,
  composeSubagentContext,
  replaceManagedBlock,
  writeClaudeMd,
} from './composer';
import type { ScanResult } from './scanner';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'claude-md-composer-'));
}

function fullScan(): ScanResult {
  return {
    project: { name: 'my-project' },
    tech_stack: { languages: ['Go'], frameworks: [], build_systems: ['go'] },
    key_dirs: { cmd: 'Go CLI entry points', internal: 'Internal packages' },
    conventions: {
      naming: 'snake_case',
      test_patterns: ['*_test.ext (suffix)'],
      primary_extensions: ['.go'],
    },
    prove_config: {
      exists: true,
      validators: [
        { name: 'build', command: 'go build ./...', phase: 'build' },
        { name: 'test', command: 'go test ./...', phase: 'test' },
      ],
      has_index: true,
      references: [],
      tool_directives: [],
    },
    cafi: { available: true, file_count: 50 },
    core_commands: [
      { name: 'index', summary: 'Update the file index' },
      { name: 'claude-md', summary: 'Regenerate this file' },
    ],
    plugin_version: '0.19.0',
    plugin_dir: '/opt/prove',
  };
}

function minimalScan(): ScanResult {
  return {
    project: { name: 'empty-project' },
    tech_stack: { languages: [], frameworks: [], build_systems: [] },
    key_dirs: {},
    conventions: { naming: 'unknown', test_patterns: [], primary_extensions: [] },
    prove_config: {
      exists: false,
      validators: [],
      has_index: false,
      references: [],
      tool_directives: [],
    },
    cafi: { available: false, file_count: 0 },
    core_commands: [],
    plugin_version: 'unknown',
    plugin_dir: '/opt/prove',
  };
}

// ---------------------------------------------------------------------------
// compose()
// ---------------------------------------------------------------------------

describe('compose', () => {
  test('wraps in managed markers', () => {
    const result = compose(fullScan());
    expect(result.startsWith(`${MANAGED_START}\n`)).toBe(true);
    expect(result.trimEnd().endsWith(MANAGED_END)).toBe(true);
  });

  test('includes header', () => {
    expect(compose(fullScan())).toContain('# my-project\n');
  });

  test('includes version check', () => {
    const r = compose(fullScan());
    expect(r).toContain('prove:plugin-version:0.19.0');
    expect(r).toContain('Prove plugin v0.19.0');
  });

  test('no version check when plugin version unknown', () => {
    expect(compose(minimalScan())).not.toContain('prove:plugin-version');
  });

  test('no version check when prove not configured', () => {
    const scan = fullScan();
    scan.prove_config.exists = false;
    expect(compose(scan)).not.toContain('prove:plugin-version');
  });

  test('includes structure', () => {
    const r = compose(fullScan());
    expect(r).toContain('## Structure');
    expect(r).toContain('`cmd/`');
    expect(r).toContain('`internal/`');
  });

  test('includes conventions', () => {
    const r = compose(fullScan());
    expect(r).toContain('## Conventions');
    expect(r).toContain('snake_case');
  });

  test('includes validation', () => {
    const r = compose(fullScan());
    expect(r).toContain('## Validation');
    expect(r).toContain('go build');
    expect(r).toContain('go test');
  });

  test('includes discovery', () => {
    const r = compose(fullScan());
    expect(r).toContain('## Discovery Protocol');
    expect(r).toContain('file index');
    expect(r).toContain('lookup');
  });

  test('includes Prove Commands from core_commands', () => {
    const r = compose(fullScan());
    expect(r).toContain('## Prove Commands');
    expect(r).toContain('/prove:index');
    expect(r).toContain('/prove:claude-md');
  });

  test('Prove Commands from custom core_commands', () => {
    const scan = fullScan();
    scan.core_commands = [{ name: 'custom-cmd', summary: 'Do something custom' }];
    const r = compose(scan);
    expect(r).toContain('/prove:custom-cmd');
    expect(r).toContain('Do something custom');
  });

  test('Prove Commands fallback when core_commands empty', () => {
    const scan = fullScan();
    scan.core_commands = [];
    const r = compose(scan);
    expect(r).toContain('## Prove Commands');
    expect(r).toContain('/prove:docs claude-md');
  });

  test('minimal project suppresses all optional sections', () => {
    const r = compose(minimalScan());
    expect(r).not.toContain('## Structure');
    expect(r).not.toContain('## Conventions');
    expect(r).not.toContain('## Validation');
    expect(r).not.toContain('## Discovery Protocol');
    expect(r).not.toContain('## Prove Commands');
  });

  test('skips conventions when naming unknown', () => {
    const scan = fullScan();
    scan.conventions.naming = 'unknown';
    expect(compose(scan)).not.toContain('## Conventions');
  });

  test('skips discovery when no CAFI + no index config', () => {
    const scan = fullScan();
    scan.cafi.available = false;
    scan.prove_config.has_index = false;
    expect(compose(scan)).not.toContain('## Discovery Protocol');
  });

  test('plugin_dir override appears in rendered commands', () => {
    expect(compose(fullScan(), '/custom/path')).toContain('/custom/path');
  });
});

// ---------------------------------------------------------------------------
// References + tool directives
// ---------------------------------------------------------------------------

describe('references', () => {
  test('renders labeled references', () => {
    const scan = fullScan();
    scan.prove_config.references = [
      { path: '~/.claude/llm-coding-standards.md', label: 'LLM Coding Standards' },
    ];
    const r = compose(scan);
    expect(r).toContain('## References');
    expect(r).toContain('### LLM Coding Standards');
    expect(r).toContain('@~/.claude/llm-coding-standards.md');
  });

  test('multiple references', () => {
    const scan = fullScan();
    scan.prove_config.references = [
      { path: '~/.claude/llm-coding-standards.md', label: 'LLM Coding Standards' },
      { path: '~/.claude/security-policy.md', label: 'Security Policy' },
    ];
    const r = compose(scan);
    expect(r).toContain('@~/.claude/llm-coding-standards.md');
    expect(r).toContain('@~/.claude/security-policy.md');
    expect(r).toContain('### Security Policy');
  });

  test('resolves $PLUGIN_DIR in paths', () => {
    const scan = fullScan();
    scan.prove_config.references = [
      {
        path: '$PLUGIN_DIR/references/llm-coding-standards.md',
        label: 'LLM Coding Standards',
      },
    ];
    const r = compose(scan, '/home/user/.claude/plugins/prove');
    expect(r).toContain('@/home/user/.claude/plugins/prove/references/llm-coding-standards.md');
    expect(r).not.toContain('$PLUGIN_DIR');
  });

  test('built-in CLI reference injected when prove exists and no user refs', () => {
    const r = compose(fullScan(), '/opt/prove');
    expect(r).toContain('## References');
    expect(r).toContain('### claude-prove CLI Reference');
    expect(r).toContain('@/opt/prove/references/claude-prove-reference.md');
  });

  test('built-in appears before user-configured references', () => {
    const scan = fullScan();
    scan.prove_config.references = [{ path: '~/.claude/user-ref.md', label: 'User Ref' }];
    const r = compose(scan, '/opt/prove');
    const builtInPos = r.indexOf('### claude-prove CLI Reference');
    const userPos = r.indexOf('### User Ref');
    expect(builtInPos).toBeGreaterThan(-1);
    expect(userPos).toBeGreaterThan(-1);
    expect(builtInPos).toBeLessThan(userPos);
  });

  test('duplicate built-in path in user references is deduped', () => {
    const scan = fullScan();
    scan.prove_config.references = [
      { path: '$PLUGIN_DIR/references/claude-prove-reference.md', label: 'Duplicate Label' },
    ];
    const r = compose(scan, '/opt/prove');
    expect(r).toContain('### claude-prove CLI Reference');
    expect(r).not.toContain('### Duplicate Label');
  });

  test('no References section when prove is not configured', () => {
    expect(compose(minimalScan())).not.toContain('## References');
  });

  test('reference without label skips ### heading for that entry', () => {
    const scan = fullScan();
    scan.prove_config.references = [{ path: '~/.claude/standards.md', label: '' }];
    const r = compose(scan);
    expect(r).toContain('## References');
    expect(r).toContain('@~/.claude/standards.md');
    // Label-less user entry should render the @path without a preceding ### heading.
    // (Built-in still has its own ### heading.)
    expect(r).toMatch(/\n\n@~\/\.claude\/standards\.md\n/);
  });
});

describe('tool directives', () => {
  test('renders Tool Directives section', () => {
    const scan = fullScan();
    scan.prove_config.tool_directives = [
      { name: 'acb', directive: 'Write intent manifests before committing.' },
    ];
    const r = compose(scan);
    expect(r).toContain('## Tool Directives');
    expect(r).toContain('### acb');
    expect(r).toContain('Write intent manifests before committing.');
  });

  test('multiple directives', () => {
    const scan = fullScan();
    scan.prove_config.tool_directives = [
      { name: 'acb', directive: 'Write manifests.' },
      { name: 'cafi', directive: 'Check the file index.' },
    ];
    const r = compose(scan);
    expect(r).toContain('### acb');
    expect(r).toContain('### cafi');
  });

  test('no section when directives empty', () => {
    expect(compose(fullScan())).not.toContain('## Tool Directives');
  });

  test('placed after Discovery, before References', () => {
    const scan = fullScan();
    scan.prove_config.tool_directives = [{ name: 'acb', directive: 'Write manifests.' }];
    scan.prove_config.references = [{ path: '~/.claude/ref.md', label: 'Ref' }];
    const r = compose(scan);
    const discoveryPos = r.indexOf('## Discovery Protocol');
    const directivesPos = r.indexOf('## Tool Directives');
    const referencesPos = r.indexOf('## References');
    expect(discoveryPos).toBeLessThan(directivesPos);
    expect(directivesPos).toBeLessThan(referencesPos);
  });
});

// ---------------------------------------------------------------------------
// composeSubagentContext
// ---------------------------------------------------------------------------

describe('composeSubagentContext', () => {
  test('includes stack', () => {
    expect(composeSubagentContext(fullScan())).toContain('**Stack**: Go');
  });

  test('includes discovery', () => {
    const r = composeSubagentContext(fullScan());
    expect(r).toContain('**Discovery**');
    expect(r).toContain('context');
  });

  test('includes validation', () => {
    const r = composeSubagentContext(fullScan());
    expect(r).toContain('**Validation**');
    expect(r).toContain('go build');
  });

  test('minimal project falls back to unknown stack', () => {
    const r = composeSubagentContext(minimalScan());
    expect(r).toContain('**Stack**: unknown');
    expect(r).not.toContain('**Discovery**');
    expect(r).not.toContain('**Validation**');
  });
});

// ---------------------------------------------------------------------------
// replaceManagedBlock
// ---------------------------------------------------------------------------

describe('replaceManagedBlock', () => {
  test('replaces managed block, preserves user content', () => {
    const existing = `# My Project\n\nUser notes here.\n\n${MANAGED_START}\nold managed content\n${MANAGED_END}\n\n## My Custom Section\n\nUser content preserved.\n`;
    const newBlock = `${MANAGED_START}\nnew managed content\n${MANAGED_END}\n`;
    const result = replaceManagedBlock(existing, newBlock);
    expect(result).not.toBeNull();
    expect(result).toContain('new managed content');
    expect(result).not.toContain('old managed content');
    expect(result).toContain('User notes here.');
    expect(result).toContain('User content preserved.');
  });

  test('returns null without markers', () => {
    expect(replaceManagedBlock('no markers here', 'new')).toBeNull();
  });

  test('returns null with only start marker', () => {
    expect(replaceManagedBlock(`${MANAGED_START}\nstuff`, 'new')).toBeNull();
  });

  test('returns null with only end marker', () => {
    expect(replaceManagedBlock(`stuff\n${MANAGED_END}\n`, 'new')).toBeNull();
  });

  test('preserves content before + after', () => {
    const existing = `BEFORE\n${MANAGED_START}\nold\n${MANAGED_END}\nAFTER\n`;
    const newBlock = `${MANAGED_START}\nnew\n${MANAGED_END}\n`;
    expect(replaceManagedBlock(existing, newBlock)).toBe(
      `BEFORE\n${MANAGED_START}\nnew\n${MANAGED_END}\nAFTER\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// writeClaudeMd
// ---------------------------------------------------------------------------

describe('writeClaudeMd', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('writes file', () => {
    const root = tmp();
    created.push(root);
    const content = `${MANAGED_START}\n# Test\n\nHello world\n${MANAGED_END}\n`;
    const path = writeClaudeMd(root, content);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  test('full replace when existing has no markers', () => {
    const root = tmp();
    created.push(root);
    const target = join(root, 'CLAUDE.md');
    writeFileSync(target, 'old content without markers');
    const newContent = `${MANAGED_START}\nnew content\n${MANAGED_END}\n`;
    writeClaudeMd(root, newContent);
    expect(readFileSync(target, 'utf8')).toBe(newContent);
  });

  test('partial replace preserves user content', () => {
    const root = tmp();
    created.push(root);
    const target = join(root, 'CLAUDE.md');
    const userSection = '\n## My Notes\n\nDo not delete this.\n';
    writeFileSync(target, `${MANAGED_START}\nold managed\n${MANAGED_END}\n${userSection}`);
    const newContent = `${MANAGED_START}\nnew managed\n${MANAGED_END}\n`;
    writeClaudeMd(root, newContent);
    const result = readFileSync(target, 'utf8');
    expect(result).toContain('new managed');
    expect(result).not.toContain('old managed');
    expect(result).toContain('Do not delete this.');
  });

  test('preserves content before managed block', () => {
    const root = tmp();
    created.push(root);
    const target = join(root, 'CLAUDE.md');
    writeFileSync(target, `# Custom Header\n\n${MANAGED_START}\nold\n${MANAGED_END}\n`);
    const newContent = `${MANAGED_START}\nnew\n${MANAGED_END}\n`;
    writeClaudeMd(root, newContent);
    const result = readFileSync(target, 'utf8');
    expect(result.startsWith('# Custom Header\n')).toBe(true);
    expect(result).toContain('new');
  });
});

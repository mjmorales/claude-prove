import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VERSION, saveCache } from '@claude-prove/shared';
import { extractGlobKeyword, extractGrepKeyword, runGate } from './gate';
import { cachePath } from './indexer';

describe('extractGlobKeyword', () => {
  test('generic extension-only pattern returns null', () => {
    expect(extractGlobKeyword({ pattern: '**/*.tsx' })).toBeNull();
  });

  test('picks last meaningful directory segment', () => {
    expect(extractGlobKeyword({ pattern: 'src/components/**/*.tsx' })).toBe('components');
  });

  test('filename with wildcard extension', () => {
    expect(extractGlobKeyword({ pattern: '**/user_repository.*' })).toBe('user_repository');
  });

  test('deep path picks the last directory before wildcards', () => {
    expect(extractGlobKeyword({ pattern: 'crates/flite-parser/**/*.rs' })).toBe('flite-parser');
  });

  test('falls back to path field when pattern is generic', () => {
    expect(extractGlobKeyword({ pattern: '*', path: 'src/services' })).toBe('services');
  });

  test('empty pattern returns null', () => {
    expect(extractGlobKeyword({ pattern: '' })).toBeNull();
  });
});

describe('extractGrepKeyword', () => {
  test('function pattern picks identifier after \\s+', () => {
    expect(extractGrepKeyword({ pattern: 'fn\\s+parse_expr' })).toBe('parse_expr');
  });

  test('class pattern picks class name', () => {
    expect(extractGrepKeyword({ pattern: 'class\\s+UserRepo' })).toBe('UserRepo');
  });

  test('dot-star pattern picks the longer literal token', () => {
    expect(extractGrepKeyword({ pattern: 'log.*Error' })).toBe('Error');
  });

  test('pure metacharacters return null', () => {
    expect(extractGrepKeyword({ pattern: '.*' })).toBeNull();
  });
});

describe('runGate', () => {
  let root: string;

  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cafi-gate-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', '.prove.json'),
      JSON.stringify({
        schema_version: '4',
        tools: { cafi: { enabled: true, config: {} } },
      }),
    );
    return dir;
  }

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('unknown tool name returns empty stdout', () => {
    const stdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'foo.py' },
      cwd: root,
    });
    expect(runGate(stdin)).toEqual({ stdout: '' });
  });

  test('malformed JSON returns empty stdout', () => {
    expect(runGate('{not json')).toEqual({ stdout: '' });
  });

  test('empty string stdin returns empty stdout', () => {
    expect(runGate('')).toEqual({ stdout: '' });
  });

  test('Glob payload with no cache returns empty stdout', () => {
    const stdin = JSON.stringify({
      tool_name: 'Glob',
      tool_input: { pattern: 'src/components/**/*.tsx' },
      cwd: root,
    });
    expect(runGate(stdin)).toEqual({ stdout: '' });
  });

  test('Glob payload with cached matches emits PreToolUse hookSpecificOutput', () => {
    saveCache(cachePath(root), {
      version: CACHE_VERSION,
      files: {
        'src/components/Button.tsx': {
          hash: 'aaa',
          description: 'Primary button component.',
          last_indexed: '2026-01-01T00:00:00Z',
        },
        'src/components/Modal.tsx': {
          hash: 'bbb',
          description: 'Accessible modal dialog.',
          last_indexed: '2026-01-01T00:00:00Z',
        },
        'src/server/index.ts': {
          hash: 'ccc',
          description: 'HTTP server entry point.',
          last_indexed: '2026-01-01T00:00:00Z',
        },
      },
    });

    const stdin = JSON.stringify({
      tool_name: 'Glob',
      tool_input: { pattern: 'src/components/**/*.tsx' },
      cwd: root,
    });
    const result = runGate(stdin);
    expect(result.stdout).not.toBe('');

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');

    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("CAFI index matches for 'components'");
    expect(ctx).toContain('- `src/components/Button.tsx`: Primary button component.');
    expect(ctx).toContain('- `src/components/Modal.tsx`: Accessible modal dialog.');
    // Non-matching entry must not appear.
    expect(ctx).not.toContain('src/server/index.ts');
  });

  test('Grep payload with cached matches emits PreToolUse hookSpecificOutput', () => {
    saveCache(cachePath(root), {
      version: CACHE_VERSION,
      files: {
        'src/auth/parse_expr.ts': {
          hash: 'aaa',
          description: 'Expression parser for auth rules.',
          last_indexed: '2026-01-01T00:00:00Z',
        },
        'src/unrelated.ts': {
          hash: 'bbb',
          description: 'Totally unrelated module.',
          last_indexed: '2026-01-01T00:00:00Z',
        },
      },
    });

    const stdin = JSON.stringify({
      tool_name: 'Grep',
      tool_input: { pattern: 'fn\\s+parse_expr' },
      cwd: root,
    });
    const result = runGate(stdin);
    expect(result.stdout).not.toBe('');

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');

    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("CAFI index matches for 'parse_expr'");
    expect(ctx).toContain('- `src/auth/parse_expr.ts`: Expression parser for auth rules.');
    expect(ctx).not.toContain('src/unrelated.ts');
  });
});

/**
 * Parity tests against goldens captured from the Python reference
 * (`scripts/token-count.py`) before deletion. Goldens live alongside the
 * fixture markdown files in `__fixtures__/` and are regenerated only when
 * the Python reference is intentionally re-run — that no longer exists
 * in this worktree, so these numbers are frozen.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureFiles, resolvePaths } from './measure';
import { formatTable } from './token-count';
import { countTokens, stripFrontmatter } from './tokenizer';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');
const AGENT_FIXTURE = join(FIXTURES_DIR, 'agent-sample.md');
const COMMAND_FIXTURE = join(FIXTURES_DIR, 'command-sample.md');

interface GoldenEntry {
  path: string;
  tokens: number;
  lines: number;
  chars: number;
}

function loadGolden(name: string): GoldenEntry[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as GoldenEntry[];
}

describe('tokenizer', () => {
  test('countTokens splits camelCase boundaries', () => {
    // Python: re.findall(_TOKEN_RE, "camelCase") → ['camel', 'Case'] → 2
    expect(countTokens('camelCase')).toBe(2);
  });

  test('countTokens handles ALLCAPS before CamelCase transition', () => {
    // "HTTPServer" → ['HTTP', 'Server'] → 2
    expect(countTokens('HTTPServer')).toBe(2);
  });

  test('countTokens counts markdown dashes and ellipsis as single tokens', () => {
    // "---" → 1, "..." → 1, "----" → 2 (--- + single `-` matched via [^\s\w])
    expect(countTokens('---')).toBe(1);
    expect(countTokens('...')).toBe(1);
    expect(countTokens('..')).toBe(1);
  });

  test('countTokens counts multi-char programming tokens', () => {
    // "foo::bar->baz" → ['foo', '::', 'bar', '->', 'baz'] → 5
    expect(countTokens('foo::bar->baz')).toBe(5);
  });

  test('countTokens counts numbers as single tokens', () => {
    // "42" → 1, "3.14" → 1, "1.2.3" → ['1.2', '.', '3'] per regex (\d+\.?\d* = greedy match)
    expect(countTokens('42')).toBe(1);
    expect(countTokens('3.14')).toBe(1);
  });

  test('stripFrontmatter removes leading YAML block', () => {
    const input = '---\nname: foo\ndescription: bar\n---\nbody text\n';
    expect(stripFrontmatter(input)).toBe('body text\n');
  });

  test('stripFrontmatter no-ops without leading frontmatter', () => {
    const input = '# Heading\n\nbody\n';
    expect(stripFrontmatter(input)).toBe(input);
  });

  test('stripFrontmatter only removes the first block', () => {
    const input = '---\na: 1\n---\n---\nb: 2\n---\n';
    // First block removed; the second `---\n...\n---\n` remains.
    expect(stripFrontmatter(input)).toBe('---\nb: 2\n---\n');
  });
});

describe('measureFiles — parity with Python golden', () => {
  test('default (strip frontmatter) matches golden.json', () => {
    const golden = loadGolden('golden.json');
    const entries = measureFiles([AGENT_FIXTURE, COMMAND_FIXTURE], true);
    for (let i = 0; i < golden.length; i += 1) {
      expect(entries[i].tokens).toBe(golden[i].tokens);
      expect(entries[i].lines).toBe(golden[i].lines);
      expect(entries[i].chars).toBe(golden[i].chars);
    }
  });

  test('--no-strip matches golden-no-strip.json', () => {
    const golden = loadGolden('golden-no-strip.json');
    const entries = measureFiles([AGENT_FIXTURE, COMMAND_FIXTURE], false);
    for (let i = 0; i < golden.length; i += 1) {
      expect(entries[i].tokens).toBe(golden[i].tokens);
      expect(entries[i].lines).toBe(golden[i].lines);
      expect(entries[i].chars).toBe(golden[i].chars);
    }
  });
});

describe('resolvePaths', () => {
  test('literal file path', () => {
    const paths = resolvePaths([AGENT_FIXTURE]);
    expect(paths).toEqual([AGENT_FIXTURE]);
  });

  test('glob pattern against fixtures dir', () => {
    const paths = resolvePaths(['*.md'], FIXTURES_DIR);
    // Sorted lexicographically: agent-sample.md, command-sample.md
    expect(paths).toEqual(['agent-sample.md', 'command-sample.md']);
  });

  test('deduplicates overlapping patterns', () => {
    const paths = resolvePaths(['*.md', 'agent-sample.md'], FIXTURES_DIR);
    // 'agent-sample.md' already seen via the glob, should not re-appear.
    expect(paths).toEqual(['agent-sample.md', 'command-sample.md']);
  });
});

describe('formatTable', () => {
  test('empty entries returns "No files found."', () => {
    expect(formatTable([])).toBe('No files found.\n');
  });

  test('header + separator + row + total shape', () => {
    const out = formatTable([{ path: 'foo.md', tokens: 1000, lines: 50, chars: 2500 }]);
    expect(out).toContain('Path');
    expect(out).toContain('Tokens');
    expect(out).toContain('1,000');
    expect(out).toMatch(/TOTAL.*1,000.*\(1 files\)/);
  });
});

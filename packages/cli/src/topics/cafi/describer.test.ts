import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BATCH_PROMPT_TEMPLATE,
  type ClaudeRunner,
  DEFAULT_BATCH_SIZE,
  MAX_CONTENT_LENGTH,
  PROMPT_TEMPLATE,
  buildBatchPrompt,
  describeFile,
  describeFiles,
  formatTemplate,
  generatePrompt,
  isTriageExcluded,
  setClaudeRunner,
  stripJsonFences,
  triageFiles,
  truncateContent,
} from './describer';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cafi-describer-${prefix}-`));
}

afterEach(() => {
  setClaudeRunner(null);
});

describe('formatTemplate', () => {
  test('substitutes named placeholders', () => {
    expect(formatTemplate('hello {name}', { name: 'world' })).toBe('hello world');
  });

  test('collapses doubled braces to literals (Python str.format parity)', () => {
    const result = formatTemplate('json: {{"k": "v"}}', {});
    expect(result).toBe('json: {"k": "v"}');
  });

  test('leaves unknown placeholders untouched', () => {
    expect(formatTemplate('x={x} y={y}', { x: '1' })).toBe('x=1 y={y}');
  });
});

describe('truncateContent', () => {
  test('passes through short content unchanged', () => {
    expect(truncateContent('short')).toBe('short');
  });

  test('appends marker when exceeding MAX_CONTENT_LENGTH', () => {
    const long = 'x'.repeat(MAX_CONTENT_LENGTH + 100);
    const out = truncateContent(long);
    const marker = '\n\n[... truncated at 8000 characters ...]';
    expect(out.length).toBe(MAX_CONTENT_LENGTH + marker.length);
    expect(out.endsWith(marker)).toBe(true);
  });
});

describe('generatePrompt', () => {
  test('embeds file path and content into the prompt template', () => {
    const prompt = generatePrompt('src/foo.ts', 'export const x = 1;');
    expect(prompt).toContain('File path: src/foo.ts');
    expect(prompt).toContain('export const x = 1;');
    expect(prompt).toContain('Read this file when');
  });

  test('template contains the placeholders we rely on', () => {
    expect(PROMPT_TEMPLATE).toContain('{path}');
    expect(PROMPT_TEMPLATE).toContain('{content}');
  });
});

describe('buildBatchPrompt', () => {
  test('produces one block per entry delimited by file markers', () => {
    const prompt = buildBatchPrompt([
      ['src/a.ts', 'export const a = 1;'],
      ['src/b.ts', 'export const b = 2;'],
    ]);
    expect(prompt).toContain('--- FILE: src/a.ts ---');
    expect(prompt).toContain('export const a = 1;');
    expect(prompt).toContain('--- FILE: src/b.ts ---');
    expect(prompt).toContain('--- END FILE ---');
    // Literal JSON example must have singular braces after formatting.
    expect(prompt).toContain('{"src/utils.py":');
    expect(prompt).not.toContain('{{');
    expect(BATCH_PROMPT_TEMPLATE).toContain('{files_block}');
  });
});

describe('stripJsonFences', () => {
  test('strips ```json fences', () => {
    const raw = '```json\n{"a": "b"}\n```';
    expect(stripJsonFences(raw)).toBe('{"a": "b"}');
  });

  test('strips plain ``` fences', () => {
    const raw = '```\n{"x": 1}\n```';
    expect(stripJsonFences(raw)).toBe('{"x": 1}');
  });

  test('leaves bare JSON untouched', () => {
    expect(stripJsonFences('{"a": "b"}')).toBe('{"a": "b"}');
  });

  test('trims surrounding whitespace', () => {
    expect(stripJsonFences('  \n{"a": "b"}\n  ')).toBe('{"a": "b"}');
  });
});

describe('isTriageExcluded', () => {
  test('excludes test files by pattern', () => {
    expect(isTriageExcluded('test_foo.py')).toBe(true);
    expect(isTriageExcluded('foo_test.ts')).toBe(true);
    expect(isTriageExcluded('foo.test.ts')).toBe(true);
    expect(isTriageExcluded('foo.spec.js')).toBe(true);
    expect(isTriageExcluded('conftest.py')).toBe(true);
  });

  test('excludes binary asset files', () => {
    expect(isTriageExcluded('logo.png')).toBe(true);
    expect(isTriageExcluded('docs/diagram.svg')).toBe(true);
    expect(isTriageExcluded('audio.mp3')).toBe(true);
  });

  test('excludes generated + lock files', () => {
    expect(isTriageExcluded('package-lock.json')).toBe(true);
    expect(isTriageExcluded('yarn.lock')).toBe(true);
    expect(isTriageExcluded('build/bundle.min.js')).toBe(true);
  });

  test('excludes boilerplate', () => {
    expect(isTriageExcluded('LICENSE')).toBe(true);
    expect(isTriageExcluded('CHANGELOG.md')).toBe(true);
    expect(isTriageExcluded('.gitignore')).toBe(true);
  });

  test('excludes directory-prefixed paths', () => {
    expect(isTriageExcluded('node_modules/foo/index.js')).toBe(true);
    expect(isTriageExcluded('dist/main.js')).toBe(true);
    expect(isTriageExcluded('pkg/node_modules/x.js')).toBe(true);
    expect(isTriageExcluded('vendor/lib/a.go')).toBe(true);
  });

  test('keeps source files', () => {
    expect(isTriageExcluded('src/main.ts')).toBe(false);
    expect(isTriageExcluded('packages/cli/src/topics/cafi/indexer.ts')).toBe(false);
    expect(isTriageExcluded('README.md')).toBe(false);
  });
});

describe('triageFiles', () => {
  test('filters excluded paths and keeps source files', () => {
    const input = [
      'src/main.ts',
      'test_foo.py',
      'node_modules/a/x.js',
      'README.md',
      'logo.png',
      'packages/cli/src/topics/cafi/indexer.ts',
    ];
    expect(triageFiles(input)).toEqual([
      'src/main.ts',
      'README.md',
      'packages/cli/src/topics/cafi/indexer.ts',
    ]);
  });

  test('handles empty list', () => {
    expect(triageFiles([])).toEqual([]);
  });
});

describe('describeFile', () => {
  test('reads file and returns stubbed CLI output', async () => {
    const tmp = makeTmpDir('single');
    try {
      writeFileSync(join(tmp, 'a.ts'), 'export const a = 1;');
      setClaudeRunner(async (prompt) => {
        expect(prompt).toContain('File path: a.ts');
        return 'stubbed description';
      });
      const out = await describeFile('a.ts', tmp);
      expect(out).toBe('stubbed description');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty string when the file is missing', async () => {
    const tmp = makeTmpDir('missing');
    try {
      setClaudeRunner(async () => 'should not be called');
      const out = await describeFile('does-not-exist.ts', tmp);
      expect(out).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty string when the CLI throws', async () => {
    const tmp = makeTmpDir('cli-fail');
    try {
      writeFileSync(join(tmp, 'a.ts'), 'x');
      setClaudeRunner(async () => {
        throw new Error('boom');
      });
      const out = await describeFile('a.ts', tmp);
      expect(out).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('describeFiles', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir('batch');
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(tmp, `f${i}.ts`), `export const x${i} = ${i};`);
    }
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('chunks into batches and returns one description per file', async () => {
    let batchCount = 0;
    const runner: ClaudeRunner = async (prompt) => {
      batchCount++;
      // Batch prompt: extract all file paths via --- FILE: <path> --- markers
      const paths = [...prompt.matchAll(/--- FILE: ([^\s]+) ---/g)].map((m) => m[1] as string);
      expect(paths.length).toBeGreaterThan(0);
      const map: Record<string, string> = {};
      for (const p of paths) map[p] = `desc for ${p}`;
      return JSON.stringify(map);
    };
    setClaudeRunner(runner);

    const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
    const result = await describeFiles(paths, tmp, { concurrency: 2, batchSize: 2 });

    expect(batchCount).toBe(3);
    for (const p of paths) {
      expect(result[p]).toBe(`desc for ${p}`);
    }
  });

  test('respects concurrency cap — never exceeds max parallel batches', async () => {
    let inFlight = 0;
    let peak = 0;
    const runner: ClaudeRunner = async (prompt) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const paths = [...prompt.matchAll(/--- FILE: ([^\s]+) ---/g)].map((m) => m[1] as string);
      const map: Record<string, string> = {};
      for (const p of paths) map[p] = 'ok';
      inFlight--;
      return JSON.stringify(map);
    };
    setClaudeRunner(runner);

    const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
    await describeFiles(paths, tmp, { concurrency: 2, batchSize: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('invokes onProgress once per completed batch', async () => {
    setClaudeRunner(async (prompt) => {
      const paths = [...prompt.matchAll(/--- FILE: ([^\s]+) ---/g)].map((m) => m[1] as string);
      const map: Record<string, string> = {};
      for (const p of paths) map[p] = 'ok';
      return JSON.stringify(map);
    });

    const progressCalls: Array<[number, number, string]> = [];
    const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
    await describeFiles(paths, tmp, {
      concurrency: 1,
      batchSize: 2,
      onProgress: (done, total, path) => progressCalls.push([done, total, path]),
    });

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[2]?.[0]).toBe(6);
    expect(progressCalls[2]?.[1]).toBe(6);
  });

  test('failed batch leaves every file with an empty description', async () => {
    setClaudeRunner(async () => {
      throw new Error('cli down');
    });
    const paths = ['f0.ts', 'f1.ts'];
    const result = await describeFiles(paths, tmp, { concurrency: 1, batchSize: 2 });
    expect(result['f0.ts']).toBe('');
    expect(result['f1.ts']).toBe('');
  });

  test('single-file batch uses generatePrompt path and returns CLI text verbatim', async () => {
    setClaudeRunner(async (prompt) => {
      // Single-file prompt contains "File path:" not --- FILE: markers
      expect(prompt).toContain('File path: f0.ts');
      return 'single-file description';
    });
    const result = await describeFiles(['f0.ts'], tmp, { concurrency: 1, batchSize: 5 });
    expect(result['f0.ts']).toBe('single-file description');
  });

  test('default batch size is DEFAULT_BATCH_SIZE', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(25);
  });
});

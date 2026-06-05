import { describe, expect, test } from 'bun:test';
import { isTriageExcluded, triageFiles } from './triage';

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

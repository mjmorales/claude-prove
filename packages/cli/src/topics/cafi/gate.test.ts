import { describe, expect, test } from 'bun:test';
import { extractGlobKeyword, extractGrepKeyword } from './gate';

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

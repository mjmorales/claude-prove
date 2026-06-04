/**
 * HTML-artifact opener tests: template substitution + quoting, platform
 * fallbacks, and config resolution from `.claude/.prove.json`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenShellCommand, readHtmlOpenTemplate, shellQuotePath } from './open-html';

describe('buildOpenShellCommand', () => {
  test('substitutes every {file} placeholder with the quoted path', () => {
    expect(buildOpenShellCommand('cursor {file}', '/tmp/a.html', 'darwin')).toBe(
      "cursor '/tmp/a.html'",
    );
    expect(buildOpenShellCommand('cp {file} {file}.bak', '/tmp/a.html', 'linux')).toBe(
      "cp '/tmp/a.html' '/tmp/a.html'.bak",
    );
  });

  test('appends the quoted path when the template has no placeholder', () => {
    expect(buildOpenShellCommand('code --reuse-window', '/tmp/a.html', 'linux')).toBe(
      "code --reuse-window '/tmp/a.html'",
    );
  });

  test('an empty template selects the platform opener', () => {
    expect(buildOpenShellCommand('', '/tmp/a.html', 'darwin')).toBe("open '/tmp/a.html'");
    expect(buildOpenShellCommand('  ', '/tmp/a.html', 'linux')).toBe("xdg-open '/tmp/a.html'");
    expect(buildOpenShellCommand('', 'C:\\t\\a.html', 'win32')).toBe('start "" "C:\\t\\a.html"');
  });

  test('quotes shell metacharacters in the path', () => {
    expect(buildOpenShellCommand('open {file}', "/tmp/it's; rm -rf.html", 'darwin')).toBe(
      `open '/tmp/it'\\''s; rm -rf.html'`,
    );
  });
});

describe('shellQuotePath', () => {
  test('single-quotes and escapes embedded single quotes', () => {
    expect(shellQuotePath('/plain/path.html')).toBe("'/plain/path.html'");
    expect(shellQuotePath("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('readHtmlOpenTemplate', () => {
  function rootWithConfig(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'open-html-'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.prove.json'), JSON.stringify(config));
    return root;
  }

  test('reads artifacts.html_open', () => {
    const root = rootWithConfig({
      schema_version: '10',
      artifacts: { html_open: 'cursor {file}' },
    });
    expect(readHtmlOpenTemplate(root)).toBe('cursor {file}');
  });

  test('falls back to empty on a missing file, block, or wrong-typed field', () => {
    expect(readHtmlOpenTemplate(mkdtempSync(join(tmpdir(), 'open-html-')))).toBe('');
    expect(readHtmlOpenTemplate(rootWithConfig({ schema_version: '10' }))).toBe('');
    expect(readHtmlOpenTemplate(rootWithConfig({ artifacts: { html_open: 42 } }))).toBe('');
    expect(readHtmlOpenTemplate(rootWithConfig({ artifacts: 'nope' }))).toBe('');
  });
});

/**
 * Configurable opener for rendered HTML artifacts — the mechanism behind the
 * `--open` flag on `report` and `intake render`. Operators consume artifacts in
 * different surfaces (an editor's embedded preview, a browser, a text editor),
 * so the command comes from `.claude/.prove.json::artifacts.html_open`: a shell
 * command template whose `{file}` placeholder is replaced with the quoted
 * artifact path (no placeholder → the path is appended). An empty or absent
 * template falls back to the platform opener (macOS `open`, Windows `start`,
 * else `xdg-open`).
 *
 * The viewer is spawned detached and never awaited: the CLI's job ended when
 * the artifact was written, so a launch failure degrades to a stderr warning
 * with exit 0 — it never masks the successful write.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read `artifacts.html_open` from `<projectRoot>/.claude/.prove.json`. Returns
 * `''` (platform-default opener) when the file, the block, or the field is
 * absent or malformed — a broken config never blocks opening.
 */
export function readHtmlOpenTemplate(projectRoot: string): string {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resolve(projectRoot, '.claude', '.prove.json'), 'utf8'));
  } catch {
    return '';
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return '';
  const artifacts = (data as { artifacts?: unknown }).artifacts;
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) return '';
  const template = (artifacts as { html_open?: unknown }).html_open;
  return typeof template === 'string' ? template : '';
}

/** Single-quote a path for a POSIX shell (embedded quotes become `'\''`). */
export function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that opens `file`. A non-empty template wins:
 * every `{file}` is replaced with the quoted path, or the path is appended
 * when the template carries no placeholder. An empty template selects the
 * platform opener.
 */
export function buildOpenShellCommand(
  template: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const quoted = platform === 'win32' ? `"${file}"` : shellQuotePath(file);
  const trimmed = template.trim();
  if (trimmed.length > 0) {
    return trimmed.includes('{file}')
      ? trimmed.replaceAll('{file}', quoted)
      : `${trimmed} ${quoted}`;
  }
  if (platform === 'darwin') return `open ${quoted}`;
  if (platform === 'win32') return `start "" ${quoted}`;
  return `xdg-open ${quoted}`;
}

/**
 * Open a written HTML artifact with the configured (or platform) opener.
 * Fire-and-forget: spawns detached, unrefs, and reports a sync spawn failure
 * through `warn` instead of failing the command.
 */
export function openHtmlArtifact(
  file: string,
  projectRoot: string,
  warn: (message: string) => void,
): void {
  const command = buildOpenShellCommand(readHtmlOpenTemplate(projectRoot), resolve(file));
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', command], { detached: true, stdio: 'ignore' })
        : spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    warn(`could not launch opener (${err instanceof Error ? err.message : String(err)})`);
  }
}

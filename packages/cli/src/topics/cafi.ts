/**
 * Register the `cafi` topic on the cac instance.
 *
 * Follows the `schema.ts` pattern: cac dispatches on the first positional
 * arg, so every sub-action lives under a single `cafi <action>` command
 * with an action enum. Users invoke the natural form:
 *   prove cafi index   [--force] [--project-root <path>]
 *   prove cafi status  [--project-root <path>]
 *   prove cafi get     <path>    [--project-root <path>]
 *   prove cafi lookup  <keyword> [--project-root <path>]
 *   prove cafi clear   [--project-root <path>]
 *   prove cafi context [--project-root <path>]
 *   prove cafi gate    (placeholder — see task 3)
 *
 * Semantics mirror `tools/cafi/__main__.py`:
 *   - index: run full/incremental index; stdout prints JSON summary; on
 *     `summary.errors > 0`, stderr gets the "Claude CLI may be
 *     unavailable" warning. Exit 0.
 *   - status: stdout prints JSON status. Exit 0.
 *   - get <path>: stdout prints the description; exit 1 with stderr
 *     message when the path isn't indexed.
 *   - lookup <keyword>: stdout prints markdown bullets; exit 1 with
 *     stderr message when no hits.
 *   - clear: stdout prints whether the cache was removed. Exit 0.
 *   - context: stdout prints the Markdown block; exit 1 with stderr
 *     message when the cache is empty.
 *   - gate: reads a PreToolUse hook payload from stdin, writes the
 *     injected context (if any) to stdout, exits 0.
 */

import type { CAC } from 'cac';
import { runGate } from './cafi/gate';
import {
  buildIndex,
  clearCache,
  formatIndexForContext,
  getDescription,
  getStatus,
  lookup,
} from './cafi/indexer';

type CafiAction = 'index' | 'status' | 'get' | 'lookup' | 'clear' | 'context' | 'gate';

const CAFI_ACTIONS: CafiAction[] = ['index', 'status', 'get', 'lookup', 'clear', 'context', 'gate'];

interface CafiFlags {
  projectRoot?: string;
  force?: boolean;
}

export function register(cli: CAC): void {
  cli
    .command(
      'cafi <action> [arg]',
      'Content-addressable file index (action: index | status | get | lookup | clear | context | gate)',
    )
    .option('--project-root <path>', 'Project root directory (default: cwd)')
    .option('--force', 'Re-describe all files (index only)')
    .action(async (action: string, arg: string | undefined, flags: CafiFlags) => {
      if (!isCafiAction(action)) {
        console.error(`Unknown cafi action: ${action}. Known: ${CAFI_ACTIONS.join(', ')}`);
        process.exit(1);
      }
      const code = await dispatch(action, arg, flags);
      process.exit(code);
    });
}

function isCafiAction(value: string): value is CafiAction {
  return (CAFI_ACTIONS as string[]).includes(value);
}

async function dispatch(
  action: CafiAction,
  arg: string | undefined,
  flags: CafiFlags,
): Promise<number> {
  const root = flags.projectRoot ?? process.cwd();
  switch (action) {
    case 'index':
      return cmdIndex(root, flags.force ?? false);
    case 'status':
      return cmdStatus(root);
    case 'get':
      return cmdGet(root, arg);
    case 'lookup':
      return cmdLookup(root, arg);
    case 'clear':
      return cmdClear(root);
    case 'context':
      return cmdContext(root);
    case 'gate':
      return cmdGate(root);
  }
}

async function cmdIndex(root: string, force: boolean): Promise<number> {
  const summary = await buildIndex(root, { force });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors > 0) {
    console.error(
      `Warning: ${summary.errors} files received empty descriptions (Claude CLI may be unavailable)`,
    );
  }
  return 0;
}

function cmdStatus(root: string): number {
  const status = getStatus(root);
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

function cmdGet(root: string, path: string | undefined): number {
  if (!path) {
    console.error('cafi get: missing <path> argument');
    return 1;
  }
  const desc = getDescription(root, path);
  if (desc === null) {
    console.error(`No description found for: ${path}`);
    return 1;
  }
  console.log(desc);
  return 0;
}

function cmdLookup(root: string, keyword: string | undefined): number {
  if (!keyword) {
    console.error('cafi lookup: missing <keyword> argument');
    return 1;
  }
  const hits = lookup(root, keyword);
  if (hits.length === 0) {
    console.error(`No files matching: ${keyword}`);
    return 1;
  }
  for (const hit of hits) {
    const desc = hit.description || '(no description)';
    console.log(`- \`${hit.path}\`: ${desc}`);
  }
  return 0;
}

function cmdClear(root: string): number {
  const removed = clearCache(root);
  console.log(removed ? 'Cache cleared.' : 'No cache file found.');
  return 0;
}

function cmdContext(root: string): number {
  const output = formatIndexForContext(root);
  if (output === '') {
    console.error('No indexed files.');
    return 1;
  }
  // `formatIndexForContext` already terminates with a newline — use
  // `process.stdout.write` to avoid console.log's extra newline.
  process.stdout.write(output);
  return 0;
}

async function cmdGate(root: string): Promise<number> {
  const rawStdin = await Bun.stdin.text();
  const result = runGate(rawStdin, { cwd: root });
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  return 0;
}

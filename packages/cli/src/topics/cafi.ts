/**
 * Register the `cafi` topic on the cac instance.
 *
 * Follows the `schema.ts` pattern: cac dispatches on the first positional
 * arg, so every sub-action lives under a single `cafi <action>` command
 * with an action enum. Users invoke the natural form:
 *   claude-prove cafi plan    [--force] [--batch-size <n>] [--project-root <path>]
 *   claude-prove cafi save    [--file <path>] [--project-root <path>]
 *   claude-prove cafi status  [--project-root <path>]
 *   claude-prove cafi get     <path>    [--project-root <path>]
 *   claude-prove cafi lookup  <keyword> [--project-root <path>]
 *   claude-prove cafi clear   [--project-root <path>]
 *   claude-prove cafi context [--project-root <path>]
 *   claude-prove cafi gate
 *
 * The engine boundary splits an index build in two: `plan` + `save` are the
 * mechanical halves (walk/hash/diff/batch, then validate/merge under lock);
 * the describe phase between them is driven by the Claude session via the
 * `/prove:index` skill — this CLI never spawns a model.
 *
 * Sub-action semantics:
 *   - plan: walk + triage + hash + diff; stdout prints the batched
 *     describe-plan JSON. Read-only except stat backfill. Exit 0.
 *   - save: reads a descriptions payload from --file or stdin, validates
 *     per-file (hash must match disk), merges under the cache lock;
 *     stdout prints `{ saved, pruned, rejected }`. Exit 1 only on a
 *     malformed payload — per-file rejections exit 0.
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
 *   - index: removed — exits 1 pointing at /prove:index.
 */

import { readFileSync } from 'node:fs';
import type { CAC } from 'cac';
import { runGate } from './cafi/gate';
import {
  clearCache,
  formatIndexForContext,
  getDescription,
  getStatus,
  lookup,
} from './cafi/indexer';
import { buildPlan } from './cafi/plan';
import { SavePayloadError, parseSavePayload, saveDescriptions } from './cafi/save';

type CafiAction =
  | 'plan'
  | 'save'
  | 'status'
  | 'get'
  | 'lookup'
  | 'clear'
  | 'context'
  | 'gate'
  | 'index';

const CAFI_ACTIONS: CafiAction[] = [
  'plan',
  'save',
  'status',
  'get',
  'lookup',
  'clear',
  'context',
  'gate',
  'index',
];

interface CafiFlags {
  projectRoot?: string;
  force?: boolean;
  batchSize?: number;
  file?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'cafi <action> [arg]',
      'Content-addressable file index (action: plan | save | status | get | lookup | clear | context | gate)',
    )
    .option('--project-root <path>', 'Project root directory (default: cwd)')
    .option('--force', 'Plan every walked file, not just the delta (plan only)')
    .option('--batch-size <n>', 'Files per describe batch (plan only)')
    .option('--file <path>', 'Read the save payload from a file instead of stdin (save only)')
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
    case 'plan':
      return cmdPlan(root, flags);
    case 'save':
      return cmdSave(root, flags);
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
    case 'index':
      return cmdIndex();
  }
}

function cmdPlan(root: string, flags: CafiFlags): number {
  const batchSize =
    flags.batchSize !== undefined ? Number.parseInt(String(flags.batchSize), 10) : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    console.error('cafi plan: --batch-size must be a positive integer');
    return 1;
  }
  const plan = buildPlan(root, { force: flags.force ?? false, batchSize });
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

async function cmdSave(root: string, flags: CafiFlags): Promise<number> {
  let raw: string;
  try {
    // FD 0 fallback keeps the stdin path Bun-independent and testable.
    raw = flags.file !== undefined ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`cafi save: could not read payload: ${stringifyError(err)}`);
    return 1;
  }

  let result: Awaited<ReturnType<typeof saveDescriptions>>;
  try {
    const payload = parseSavePayload(raw);
    result = await saveDescriptions(root, payload);
  } catch (err) {
    if (err instanceof SavePayloadError) {
      console.error(`cafi save: ${err.message}`);
      return 1;
    }
    throw err;
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.rejected.length > 0) {
    console.error(
      `Warning: ${result.rejected.length} file(s) rejected — re-run "cafi plan" and re-describe them`,
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

function cmdGate(root: string): number {
  // Drain stdin (FD 0) synchronously so the gate path has no Bun-specific
  // dependency and is testable by passing a string directly to runGate.
  let rawStdin: string;
  try {
    rawStdin = readFileSync(0, 'utf8');
  } catch {
    rawStdin = '';
  }
  const result = runGate(rawStdin, { cwd: root });
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  return 0;
}

function cmdIndex(): number {
  console.error(
    'cafi index was removed: the describe loop is driven by the Claude session.\n' +
      'Run /prove:index in Claude Code (mechanical halves: "cafi plan" -> describe -> "cafi save").',
  );
  return 1;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * `claude-prove acb brief <render|validate|chunk> [--run-dir D] [--file F] [--token-budget N]`
 *
 * The Review Brief surface. Every sub-action reads the run's
 * reasoning log from `<run-dir>/log/<agent>/<id>.json`.
 *
 *   acb brief render   --run-dir D            mechanical 7-section brief → stdout (markdown)
 *   acb brief validate --run-dir D [--file F] Stage-1 preservation check of brief F (or stdin)
 *   acb brief chunk    --run-dir D [--token-budget N]  multipass episode partition → stdout (JSON)
 *
 * `render` emits the deterministic mechanical brief — the starting point the
 * synthesizer skill refines into prose. `validate` proves a brief (the skill's
 * output, via --file or stdin) dropped no attention-bearing item. `chunk`
 * partitions episodes under a token budget so the skill can synthesize a
 * fragment per chunk for a large log (episode-chunk → fragment → merge).
 *
 * Stdout/stderr contract (matches `log-cmd.ts`):
 *   - render:   stdout = markdown document; stderr = one-line summary
 *   - validate: stdout = JSON `{ ok, missing, required }`; stderr = summary
 *   - chunk:    stdout = JSON `{ token_budget, chunks: string[][] }`; stderr = summary
 *
 * Exit codes:
 *   0  success (validate: brief preserves everything)
 *   1  unknown sub-action, missing --run-dir, read/parse error, or (validate)
 *      a brief that dropped a required item
 */

import { readFileSync } from 'node:fs';
import { buildBrief, chunkEpisodes, renderBrief } from '../brief';
import { validatePreservation } from '../brief-validate';
import { deriveEpisodes } from '../reasoning-log';
import { listEntries } from '../reasoning-log-store';

export type BriefSubAction = 'render' | 'validate' | 'chunk';

const BRIEF_SUB_ACTIONS: readonly BriefSubAction[] = ['render', 'validate', 'chunk'];

/** Default multipass episode-chunk budget when `--token-budget` is omitted. */
const DEFAULT_CHUNK_TOKEN_BUDGET = 6000;

export interface BriefOpts {
  runDir?: string;
  file?: string;
  tokenBudget?: number;
}

export function runBrief(sub: string | undefined, opts: BriefOpts): number {
  if (!sub) {
    process.stderr.write(
      `Error: the following arguments are required: brief sub-action (one of: ${BRIEF_SUB_ACTIONS.join(', ')})\n`,
    );
    return 1;
  }
  if (!isBriefSubAction(sub)) {
    process.stderr.write(
      `Error: unknown brief sub-action '${sub}' (expected: ${BRIEF_SUB_ACTIONS.join(' | ')})\n`,
    );
    return 1;
  }

  switch (sub) {
    case 'render':
      return runRender(opts);
    case 'validate':
      return runValidate(opts);
    case 'chunk':
      return runChunk(opts);
  }
}

function runRender(opts: BriefOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let entries: ReturnType<typeof listEntries>;
  try {
    entries = listEntries(runDir);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  const brief = buildBrief(entries, deriveEpisodes(entries));
  process.stdout.write(`${renderBrief(brief)}\n`);
  process.stderr.write(
    `Brief rendered: ${brief.attention.length} attention, ${brief.decisions.length} decisions, ${brief.bailouts.length} bailouts\n`,
  );
  return 0;
}

function runValidate(opts: BriefOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let entries: ReturnType<typeof listEntries>;
  try {
    entries = listEntries(runDir);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  let briefText: string;
  try {
    briefText =
      opts.file && opts.file.length > 0 ? readFileSync(opts.file, 'utf8') : readStdinSync();
  } catch (err) {
    process.stderr.write(`Error: cannot read brief: ${errMsg(err)}\n`);
    return 1;
  }

  const result = validatePreservation(briefText, entries);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok) {
    process.stderr.write(`Brief preserves all ${result.required} attention-bearing item(s)\n`);
    return 0;
  }
  process.stderr.write(
    `Brief DROPPED ${result.missing.length} required item(s): ${result.missing.join(', ')}\n`,
  );
  return 1;
}

function runChunk(opts: BriefOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let entries: ReturnType<typeof listEntries>;
  try {
    entries = listEntries(runDir);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  const budget =
    opts.tokenBudget && opts.tokenBudget > 0 ? opts.tokenBudget : DEFAULT_CHUNK_TOKEN_BUDGET;
  const episodes = deriveEpisodes(entries);
  // Emit chunk membership as decision-id arrays — the driver re-reads full
  // episodes via `acb log episodes` and synthesizes one fragment per chunk.
  const chunks = chunkEpisodes(episodes, budget).map((chunk) => chunk.map((ep) => ep.decision.id));

  process.stdout.write(`${JSON.stringify({ token_budget: budget, chunks })}\n`);
  process.stderr.write(
    `${episodes.length} episodes -> ${chunks.length} chunk(s) at <=${budget} tokens\n`,
  );
  return 0;
}

function isBriefSubAction(value: string): value is BriefSubAction {
  return (BRIEF_SUB_ACTIONS as readonly string[]).includes(value);
}

function readStdinSync(): string {
  return readFileSync(0, 'utf8');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

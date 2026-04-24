/**
 * `claude-prove acb save-manifest [--branch B] [--sha S] [--slug G] --workspace-root W`
 *
 * Reads an ACB v0.2 intent manifest as JSON on stdin, validates it, and
 * inserts a row into `<workspace-root>/.prove/prove.db` acb_manifests. The
 * invocation line is what the `post-commit` hook prints back to the agent
 * as the REQUIRED next tool call — the flag surface therefore mirrors
 * `tools/acb/__main__.py::cmd_save_manifest` 1:1.
 *
 * Resolution order:
 *   - branch:  --branch -> currentBranch(cwd) -> 'unknown'
 *   - sha:     --sha    -> headSha(cwd) -> exit 1 (no HEAD resolvable)
 *   - slug:    --slug   -> resolveRunSlug(cwd) -> null
 *   - root:    --workspace-root -> mainWorktreeRoot(cwd) -> process.cwd()
 *
 * Stdout/stderr contract (byte-equal to Python reference):
 *   - stdout: one-line JSON `{saved, id, branch, sha, run_slug}` + '\n'
 *   - stderr: one-line `Manifest saved for <branch> (sha: <sha>)[ run:<slug>]`
 *
 * Exit codes:
 *   0  manifest persisted
 *   1  stdin JSON parse error, HEAD unresolvable, or schema-invalid manifest
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, headSha, mainWorktreeRoot, resolveRunSlug } from '@claude-prove/shared';
import { isoSeconds } from '../hook';
import { ensureLegacyImported } from '../importer';
import { validateManifest } from '../schemas';
import { openAcbStore } from '../store';

export interface SaveManifestOpts {
  branch?: string;
  sha?: string;
  slug?: string;
  workspaceRoot?: string;
}

export function runSaveManifest(opts: SaveManifestOpts): number {
  const branch = opts.branch ?? currentBranch() ?? 'unknown';

  const sha = opts.sha ?? headSha();
  if (sha === null || sha.length === 0) {
    process.stderr.write('Error: cannot resolve HEAD\n');
    return 1;
  }

  // Empty-string flag value from cac => treat as missing (mirrors Python
  // argparse default=""). resolveRunSlug returns null when neither env
  // nor marker file yields a slug.
  const slugFlag = opts.slug && opts.slug.length > 0 ? opts.slug : undefined;
  const runSlug = slugFlag ?? resolveRunSlug();

  const workspaceRoot =
    opts.workspaceRoot && opts.workspaceRoot.length > 0
      ? opts.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());

  const raw = readStdinSync();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: invalid JSON on stdin: ${msg}\n`);
    return 1;
  }

  // Pin the manifest body's commit_sha to the resolved SHA so the row's
  // commit_sha column and payload agree — Python does the same.
  if (!isRecord(data)) {
    process.stderr.write('Error: invalid manifest: Manifest must be a JSON object\n');
    return 1;
  }
  data.commit_sha = sha;
  // Agents sometimes drop `timestamp` when filling in the hook's manifest
  // template. Auto-inject a UTC ISO-seconds value when missing so ops metadata
  // never blocks a save — only agent-judgment fields should fail validation.
  if (data.timestamp === undefined || data.timestamp === null || data.timestamp === '') {
    data.timestamp = isoSeconds();
  }

  const errors = validateManifest(data);
  if (errors.length > 0) {
    process.stderr.write(`Error: invalid manifest: ${errors.join('; ')}\n`);
    return 1;
  }

  ensureLegacyImported(workspaceRoot);

  const store = openAcbStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  let rowId: number;
  try {
    rowId = store.saveManifest(branch, sha, data, runSlug ?? undefined);
  } finally {
    store.close();
  }

  const outPayload = { saved: true, id: rowId, branch, sha, run_slug: runSlug };
  process.stdout.write(`${JSON.stringify(outPayload)}\n`);
  const tail = runSlug !== null && runSlug !== undefined ? ` run:${runSlug}` : '';
  process.stderr.write(`Manifest saved for ${branch} (sha: ${sha})${tail}\n`);
  return 0;
}

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

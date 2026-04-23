/**
 * `prove acb migrate-legacy-db [--workspace-root <path>]`
 *
 * User-triggered one-shot migration from standalone `.prove/acb.db` into
 * the unified `.prove/prove.db` acb domain. Wraps `importLegacyDb` — NOT
 * the memoized `ensureLegacyImported` wrapper, because a user running
 * this subcommand expects a fresh filesystem check every invocation.
 *
 * Exit codes:
 *   0  success OR no-op (legacy-absent / already-migrated)
 *   1  import attempted and failed
 *
 * All output is on stderr so the subcommand composes cleanly inside
 * scripts that capture stdout for downstream tooling.
 */

import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ImportResult, importLegacyDb } from '../importer';

export interface MigrateLegacyFlags {
  workspaceRoot?: string;
}

export function runMigrateLegacy(flags: MigrateLegacyFlags): number {
  const root = flags.workspaceRoot ?? mainWorktreeRoot() ?? process.cwd();
  const result = importLegacyDb(root);
  return reportResult(result);
}

function reportResult(result: ImportResult): number {
  if (result.imported && result.counts) {
    const { manifests, acb_documents, review_state } = result.counts;
    process.stderr.write(
      `acb: imported ${manifests} manifests, ${acb_documents} documents, ${review_state} reviews from legacy .prove/acb.db\n`,
    );
    process.stderr.write('acb: removed .prove/acb.db\n');
    return 0;
  }
  if (result.reason === 'legacy-absent') {
    process.stderr.write('acb: no legacy .prove/acb.db to import\n');
    return 0;
  }
  if (result.reason === 'already-migrated') {
    process.stderr.write('acb: prove.db already has acb rows, skipping import\n');
    return 0;
  }
  // reason: 'error'
  process.stderr.write(`acb: legacy-db import failed: ${result.error ?? 'unknown error'}\n`);
  return 1;
}

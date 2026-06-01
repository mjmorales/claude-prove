/**
 * CLI handler for `claude-prove install bootstrap-identity`.
 *
 * Maps the flag surface onto the artifact selection, calls the pure
 * `bootstrapIdentity` lib, and renders the result for the operator (human
 * text by default, `--json` for the slash command to parse).
 *
 * Flag → artifact mapping:
 *   --with-charter  → charter
 *   --with-team     → team
 *   --full          → charter + team + contributor
 *   --contributor   → adds contributor (always implied by --full)
 * No selection flags is a usage error — there is nothing to scaffold.
 *
 * Exit codes: 0 on a clean bootstrap, 1 on a usage error or any pre-flight
 * failure (the caller halts and surfaces the fixes).
 */

import {
  type BootstrapIdentityResult,
  type IdentityArtifactKind,
  bootstrapIdentity,
} from './bootstrap-identity';

export interface BootstrapIdentityFlags {
  cwd?: string;
  withCharter: boolean;
  withTeam: boolean;
  full: boolean;
  contributor?: string;
  dryRun: boolean;
  json: boolean;
}

/** Resolve the requested artifact set from the flag surface. */
function selectArtifacts(flags: BootstrapIdentityFlags): Set<IdentityArtifactKind> {
  const artifacts = new Set<IdentityArtifactKind>();
  if (flags.full || flags.withCharter) artifacts.add('charter');
  if (flags.full || flags.withTeam) artifacts.add('team');
  if (flags.full || flags.contributor !== undefined) artifacts.add('contributor');
  return artifacts;
}

export function runBootstrapIdentity(flags: BootstrapIdentityFlags): number {
  const artifacts = selectArtifacts(flags);

  if (artifacts.size === 0) {
    console.error(
      'claude-prove install bootstrap-identity: nothing selected. pass --with-charter, --with-team, --full, or --contributor <id>',
    );
    return 1;
  }

  if (artifacts.has('contributor') && (flags.contributor ?? '').length === 0) {
    console.error(
      'claude-prove install bootstrap-identity: a contributor record needs --contributor <id> (e.g. --contributor jane-doe)',
    );
    return 1;
  }

  const result = bootstrapIdentity({
    cwd: flags.cwd,
    artifacts,
    contributorId: flags.contributor,
    dryRun: flags.dryRun,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderHuman(result, flags.dryRun);
  }

  return result.ok ? 0 : 1;
}

/** Render a human-readable summary of the bootstrap result. */
function renderHuman(result: BootstrapIdentityResult, dryRun: boolean): void {
  if (!result.ok) {
    console.error('Pre-flight checks failed — fix each, then re-run:');
    for (const f of result.preflightFailures) {
      console.error(`  [${f.check}] ${f.detail}`);
      console.error(`      fix: ${f.fix}`);
    }
    return;
  }

  const verb = dryRun ? 'would create' : 'created';
  for (const a of result.artifacts) {
    const action = a.disposition === 'created' ? verb : 'skipped (already exists)';
    console.log(`  ${a.kind}: ${action} — ${a.path}`);
  }
}

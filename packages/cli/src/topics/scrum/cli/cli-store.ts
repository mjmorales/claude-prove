/**
 * Shared store opener for `claude-prove scrum` subcommand handlers.
 *
 * Every CLI handler opens the unified prove.db the same way; this helper adds
 * the one CLI-specific step on top of `openScrumStore`: seeding the store's
 * ambient write actor (`ScrumStore.defaultActor`) from the machine-global
 * project-root → default-contributor mapping (`contributor default set`). That
 * is what makes a cold CLI write — no `PROVE_AGENT` in env, no explicit agent
 * flag — stamp `created_by` / `last_modified_by` with the operator's CT-UUID
 * instead of landing permanent NULLs in the append-only provenance.
 *
 * Resolution failures degrade to a stderr warning + unattributed writes
 * rather than failing the command: the mapping is an attribution layer, never
 * a gate on store access. (A malformed config file never reaches here — the
 * machine-config reader backs it aside and proceeds with an empty config —
 * so the catch covers unexpected I/O failures.)
 */

import { join } from 'node:path';
import { resolveDefaultContributor } from '@claude-prove/store';
import type { ScrumStore } from '../store';
import { openSyncSession } from './sync-lifecycle';

/**
 * Open the scrum store at `<workspaceRoot>/.prove/prove.db` with the ambient
 * write actor seeded for this project root. `configBase` is the test seam
 * forwarded to the machine-config reader (the `~/.claude-prove` root) so tests
 * never touch the developer's real home dotfile.
 */
export async function openCliStore(
  workspaceRoot: string,
  configBase?: string,
): Promise<ScrumStore> {
  // Open the store on the synced connection when cloud is enabled, so this
  // command's writes are captured by the sync change-log and ride the next
  // session-boundary push; else a plain local store. No pull/push here — ordinary
  // commands defer sync to the boundary hooks (the change-log persists across
  // opens). `store.close()` closes the underlying (synced) connection.
  const store = (
    await openSyncSession(workspaceRoot, {}, join(workspaceRoot, '.prove', 'prove.db'))
  ).store;
  try {
    store.defaultActor = resolveDefaultContributor(workspaceRoot, configBase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: default-contributor mapping unavailable: ${msg}\n`);
  }
  return store;
}

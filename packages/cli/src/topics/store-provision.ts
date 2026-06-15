/**
 * `claude-prove store provision` — provision this project's optional cloud
 * database and mint its machine-local db-scoped sync token.
 *
 * Reads the NON-SECRET `cloud: { enabled, org, group, db_name }` block from the
 * project's `.claude/.prove.json`, then delegates to the engine's
 * `provisionDatabase` (in `@claude-prove/store`) which:
 *   - idempotently creates `prove-<slug>` in the configured group,
 *   - mints a least-privilege token scoped to exactly that one database, and
 *   - writes that token to the gitignored `~/.claude-prove/config.json`.
 *
 * Secrets never touch `.prove.json`: the org Platform API token (admin
 * bootstrap secret) is read from the environment, and the db-scoped token is
 * written only to the machine config. This command is therefore the contributor
 * onboarding step — each machine runs it once to mint its own least-privilege
 * token.
 *
 * Output contract: the `ProvisionResult` entity JSON on stdout, a
 * `store provision: <summary>` trailer on stderr. Exit 0 on success, 1 on a
 * usage/config/provisioning error.
 *
 * The `@tursodatabase/api` client is injected through the store's `ProvisionDeps`
 * seam, so this handler's config-read + dispatch is unit-testable without a live
 * org token — the live provision is a runtime op.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CloudCoordinates,
  type ProvisionDeps,
  ProvisionError,
  type ProvisionResult,
  openStore,
  provisionDatabase,
  resolveCloudToken,
  runMigrations,
  syncRemoteUrl,
} from '@claude-prove/store';
import { type Connection, connect as connectRemote } from '@tursodatabase/serverless';
import { ensureScrumSchemaRegistered } from './scrum/schemas';

/** The non-secret cloud block as read from `.prove.json`. */
export interface CloudConfig {
  enabled: boolean;
  org: string;
  group: string;
  dbName: string;
}

/** Flags accepted by `store provision`. */
export interface ProvisionFlags {
  /** Project root holding `.claude/.prove.json`. Defaults to cwd. */
  workspaceRoot?: string;
}

/**
 * Run `store provision`. Returns the process exit code. `deps` is the store's
 * provisioning seam — unset in production (the store wires the real
 * `@tursodatabase/api`), injected by tests to stub the client and redirect the
 * token write to a tmp dir.
 */
export async function runProvision(
  flags: ProvisionFlags,
  deps: Partial<ProvisionDeps> & { connectRemote?: typeof connectRemote } = {},
): Promise<number> {
  const workspaceRoot = flags.workspaceRoot ?? process.cwd();

  const cloud = readCloudConfig(workspaceRoot);
  if (cloud === null) {
    console.error(
      'store provision: no cloud block in .claude/.prove.json. Add `cloud: { enabled: true, org, group, db_name }` (schema v12) before provisioning.',
    );
    return 1;
  }
  if (!cloud.enabled) {
    console.error(
      'store provision: cloud.enabled is false. Provisioning only applies to a cloud-opted-in project; set cloud.enabled to true in .claude/.prove.json first.',
    );
    return 1;
  }

  let result: ProvisionResult;
  try {
    result = await provisionDatabase(
      { org: cloud.org, dbName: cloud.dbName, group: cloud.group },
      deps,
    );
  } catch (err) {
    const msg = err instanceof ProvisionError ? err.message : String(err);
    console.error(`store provision: ${msg}`);
    return 1;
  }

  // Establish the scrum schema on the remote primary. A replica cannot bootstrap
  // schema by pushing its own DDL — the sync engine's replay generator panics on
  // a write to a table the remote lacks — so create it here; replicas pull it
  // before any data write. Skipped when no db-scoped token resolves (e.g. a test
  // whose token write was redirected away from the machine config).
  const bootstrapToken = resolveCloudToken(cloud.dbName);
  if (bootstrapToken !== null && bootstrapToken.length > 0) {
    try {
      await bootstrapRemoteScrumSchema({ org: cloud.org, dbName: cloud.dbName }, bootstrapToken, {
        connect: deps.connectRemote,
      });
    } catch (err) {
      console.error(
        `store provision: remote schema bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // Entity JSON on stdout; human trailer on stderr.
  console.log(JSON.stringify(result, null, 2));
  const verb = result.created ? 'created' : 'reused existing';
  console.error(
    `store provision: ${verb} db '${result.dbName}' in group '${result.group}'; db-scoped token written to ~/.claude-prove/config.json`,
  );
  return 0;
}

/**
 * Read and normalize the cloud block from `<root>/.claude/.prove.json`. Returns
 * `null` when the file is absent/unparseable or carries no `cloud` block. A
 * present-but-partial block is filled from the schema defaults (group `prove`,
 * empty org/db_name) so a missing required value surfaces downstream as a clear
 * provisioning error rather than a silent empty string.
 */
export function readCloudConfig(workspaceRoot: string): CloudConfig | null {
  const configPath = join(workspaceRoot, '.claude', '.prove.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const cloud = (parsed as Record<string, unknown>).cloud;
  if (typeof cloud !== 'object' || cloud === null || Array.isArray(cloud)) return null;

  const c = cloud as Record<string, unknown>;
  return {
    enabled: c.enabled === true,
    org: typeof c.org === 'string' ? c.org : '',
    group: typeof c.group === 'string' && c.group.length > 0 ? c.group : 'prove',
    dbName: typeof c.db_name === 'string' ? c.db_name : '',
  };
}

/**
 * Establish the scrum schema on the REMOTE primary directly, over a
 * `@tursodatabase/serverless` connection, using the same migration runner the
 * local store uses. A replica cannot bootstrap schema by pushing its own DDL —
 * the sync engine's replay generator panics on a write to a table the remote
 * lacks — so schema is created here and replicas pull it before any data write.
 * Idempotent: the migration runner skips already-applied migrations via
 * `_migrations_log`, so a re-provision is a no-op against an up-to-date primary.
 */
export async function bootstrapRemoteScrumSchema(
  coords: CloudCoordinates,
  token: string,
  deps: { connect?: (config: { url: string; authToken: string }) => Connection } = {},
): Promise<void> {
  ensureScrumSchemaRegistered();
  // Build the schema locally — the migration runner is reliable on the local
  // engine — then replicate the resulting objects to the remote primary one
  // statement at a time (autocommit). Running the migration runner directly over
  // the serverless HTTP connection is unreliable: its explicit BEGIN/COMMIT
  // transaction wrapping does not persist tables across migrations there, and
  // serverless binds parameters as a single array rather than spread positional.
  const local = await openStore({ path: ':memory:' });
  let objects: { sql: string }[];
  let migrationsLog: Record<string, unknown>[];
  try {
    await runMigrations(local);
    objects = await local.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    );
    migrationsLog = await local.all<Record<string, unknown>>(
      'SELECT * FROM _migrations_log ORDER BY rowid',
    );
  } finally {
    local.close();
  }

  const open = deps.connect ?? connectRemote;
  const url = syncRemoteUrl(coords);
  // A just-created remote database can briefly 404 before it becomes routable;
  // retry with linear backoff. The apply is idempotent — it no-ops when the
  // schema is already present — so a retry after a transient failure is safe.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const conn = open({ url, authToken: token });
    try {
      const present = await (
        await conn.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scrum_contributors'",
        )
      ).all([]);
      if (present.length === 0) {
        for (const obj of objects) await conn.exec(obj.sql);
        for (const row of migrationsLog) {
          const cols = Object.keys(row);
          const insert = `INSERT OR IGNORE INTO _migrations_log (${cols.join(', ')}) VALUES (${cols
            .map(() => '?')
            .join(', ')})`;
          await (await conn.prepare(insert)).run(cols.map((c) => row[c]));
        }
      }
      conn.close();
      return;
    } catch (err) {
      lastErr = err;
      conn.close();
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

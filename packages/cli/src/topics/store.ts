import {
  type Store,
  dropAllDomainTables,
  listDomains,
  openStore,
  runMigrations,
} from '@claude-prove/store';
import type { CAC } from 'cac';
import { runMigrateToTurso } from './store-migrate-to-turso';

interface StoreFlags {
  confirm?: boolean;
  dryRun?: boolean;
  dbPath?: string;
}

type StoreAction = 'migrate' | 'info' | 'reset' | 'migrate-to-turso';

const STORE_ACTIONS: StoreAction[] = ['migrate', 'info', 'reset', 'migrate-to-turso'];

/**
 * Register the `store` topic on the cac instance.
 *
 * cac dispatches commands on the first positional arg only, so sub-actions
 * live under a single `store <action>` command with an action enum instead
 * of space-separated command names. Users still invoke the natural form:
 *   claude-prove store migrate
 *   claude-prove store info
 *   claude-prove store reset --confirm
 *
 * No domains are registered at phase 2 — downstream domain packages call
 * `registerSchema` in their own modules once they port. `store migrate`
 * is therefore a well-defined no-op today and becomes load-bearing as
 * domains land.
 */
export function register(cli: CAC): void {
  cli
    .command(
      'store <action>',
      'Unified store operations (action: migrate | info | reset | migrate-to-turso)',
    )
    .option('--confirm', 'Required by `reset` (drop tables) and `migrate-to-turso` (swap files)')
    .option('--dry-run', 'migrate-to-turso: verify + report only, change no files')
    .option('--db-path <path>', 'migrate-to-turso: explicit legacy db path (default: resolved)')
    .action(async (action: string, flags: StoreFlags) => {
      if (!isStoreAction(action)) {
        console.error(
          `claude-prove store: unknown action '${action}'. expected one of: ${STORE_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      // migrate-to-turso owns its own store lifecycle (it opens a legacy file
      // read-only and builds a separate v1 db), so it bypasses the canonical
      // single-store open that `runStoreCommand` provides.
      if (action === 'migrate-to-turso') {
        const code = await runMigrateToTurso({
          dbPath: flags.dbPath,
          dryRun: flags.dryRun ?? false,
          confirm: flags.confirm ?? false,
        });
        process.exit(code);
      }
      // Single exit point — sub-handlers return exit codes; lifecycle
      // wrapper maps unexpected errors to 1; the action callback is the
      // only thing that calls process.exit for this topic.
      const code = await runStoreCommand((store) => dispatch(store, action, flags));
      process.exit(code);
    });
}

function isStoreAction(value: string): value is StoreAction {
  return (STORE_ACTIONS as string[]).includes(value);
}

// migrate-to-turso is dispatched separately (it owns its store lifecycle), so
// this handles only the actions that run against the single canonical store.
function dispatch(
  store: Store,
  action: Exclude<StoreAction, 'migrate-to-turso'>,
  flags: StoreFlags,
): Promise<number> {
  switch (action) {
    case 'migrate':
      return handleMigrate(store);
    case 'info':
      return handleInfo(store);
    case 'reset':
      return handleReset(store, flags);
  }
}

async function runStoreCommand(fn: (store: Store) => Promise<number>): Promise<number> {
  let store: Store | undefined;
  try {
    store = await openStore();
    return await fn(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`claude-prove store: ${msg}`);
    return 1;
  } finally {
    store?.close();
  }
}

async function handleMigrate(store: Store): Promise<number> {
  const result = await runMigrations(store);
  if (result.applied.length === 0) {
    console.log('no pending migrations');
    return 0;
  }
  for (const m of result.applied) {
    console.log(`applied ${m.domain} v${m.version}: ${m.description}`);
  }
  return 0;
}

async function handleInfo(store: Store): Promise<number> {
  console.log(`db path: ${store.path}`);
  const domains = listDomains();
  if (domains.length === 0) {
    console.log('no domains registered');
    return 0;
  }

  // Domains register via side-effect imports independently of whether
  // `store migrate` has ever run. Ensure the log table exists before querying
  // it so `store info` reports v0 for unmigrated domains instead of throwing
  // "no such table: _migrations_log" on a fresh database.
  await store.exec(
    `CREATE TABLE IF NOT EXISTS _migrations_log (
      domain TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (domain, version)
    )`,
  );

  console.log('domains:');
  for (const domain of domains) {
    const rows = await store.all<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM _migrations_log WHERE domain = ?',
      [domain],
    );
    const version = rows[0]?.version ?? 0;
    console.log(`  ${domain}: v${version}`);
  }
  return 0;
}

async function handleReset(store: Store, flags: StoreFlags): Promise<number> {
  if (!flags.confirm) {
    console.error('refusing to reset without --confirm. this will drop every domain table.');
    return 1;
  }
  await dropAllDomainTables(store);
  console.log(`reset: dropped all domain tables at ${store.path}`);
  return 0;
}

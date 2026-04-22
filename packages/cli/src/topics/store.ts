import {
  type Store,
  dropAllDomainTables,
  listDomains,
  openStore,
  runMigrations,
} from '@claude-prove/store';
import type { CAC } from 'cac';

interface StoreFlags {
  confirm?: boolean;
}

type StoreAction = 'migrate' | 'info' | 'reset';

const STORE_ACTIONS: StoreAction[] = ['migrate', 'info', 'reset'];

/**
 * Register the `store` topic on the cac instance.
 *
 * cac dispatches commands on the first positional arg only, so sub-actions
 * live under a single `store <action>` command with an action enum instead
 * of space-separated command names. Users still invoke the natural form:
 *   prove store migrate
 *   prove store info
 *   prove store reset --confirm
 *
 * No domains are registered at phase 2 — downstream domain packages call
 * `registerSchema` in their own modules once they port. `store migrate`
 * is therefore a well-defined no-op today and becomes load-bearing as
 * domains land.
 */
export function register(cli: CAC): void {
  cli
    .command('store <action>', 'Unified store operations (action: migrate | info | reset)')
    .option('--confirm', 'Required by `reset` to actually drop tables')
    .action((action: string, flags: StoreFlags) => {
      if (!isStoreAction(action)) {
        console.error(
          `prove store: unknown action '${action}'. expected one of: ${STORE_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      runStoreCommand((store) => dispatch(store, action, flags));
    });
}

function isStoreAction(value: string): value is StoreAction {
  return (STORE_ACTIONS as string[]).includes(value);
}

function dispatch(store: Store, action: StoreAction, flags: StoreFlags): void {
  switch (action) {
    case 'migrate':
      handleMigrate(store);
      break;
    case 'info':
      handleInfo(store);
      break;
    case 'reset':
      handleReset(store, flags);
      break;
  }
}

function runStoreCommand(fn: (store: Store) => void): void {
  let store: Store | undefined;
  try {
    store = openStore();
    fn(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove store: ${msg}`);
    process.exit(1);
  } finally {
    store?.close();
  }
}

function handleMigrate(store: Store): void {
  const result = runMigrations(store);
  if (result.applied.length === 0) {
    console.log('no pending migrations');
    return;
  }
  for (const m of result.applied) {
    console.log(`applied ${m.domain} v${m.version}: ${m.description}`);
  }
}

function handleInfo(store: Store): void {
  console.log(`db path: ${store.path}`);
  const domains = listDomains();
  if (domains.length === 0) {
    console.log('no domains registered');
    return;
  }
  console.log('domains:');
  for (const domain of domains) {
    const rows = store.all<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM _migrations_log WHERE domain = ?',
      [domain],
    );
    const version = rows[0]?.version ?? 0;
    console.log(`  ${domain}: v${version}`);
  }
}

function handleReset(store: Store, flags: StoreFlags): void {
  if (!flags.confirm) {
    console.error('refusing to reset without --confirm. this will drop every domain table.');
    process.exit(1);
  }
  dropAllDomainTables(store);
  console.log(`reset: dropped all domain tables at ${store.path}`);
}

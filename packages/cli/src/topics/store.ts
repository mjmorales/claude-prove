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
      // Single exit point — sub-handlers return exit codes; lifecycle
      // wrapper maps unexpected errors to 1; the action callback is the
      // only thing that calls process.exit for this topic.
      const code = runStoreCommand((store) => dispatch(store, action, flags));
      process.exit(code);
    });
}

function isStoreAction(value: string): value is StoreAction {
  return (STORE_ACTIONS as string[]).includes(value);
}

function dispatch(store: Store, action: StoreAction, flags: StoreFlags): number {
  switch (action) {
    case 'migrate':
      return handleMigrate(store);
    case 'info':
      return handleInfo(store);
    case 'reset':
      return handleReset(store, flags);
  }
}

function runStoreCommand(fn: (store: Store) => number): number {
  let store: Store | undefined;
  try {
    store = openStore();
    return fn(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove store: ${msg}`);
    return 1;
  } finally {
    store?.close();
  }
}

function handleMigrate(store: Store): number {
  const result = runMigrations(store);
  if (result.applied.length === 0) {
    console.log('no pending migrations');
    return 0;
  }
  for (const m of result.applied) {
    console.log(`applied ${m.domain} v${m.version}: ${m.description}`);
  }
  return 0;
}

function handleInfo(store: Store): number {
  console.log(`db path: ${store.path}`);
  const domains = listDomains();
  if (domains.length === 0) {
    console.log('no domains registered');
    return 0;
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
  return 0;
}

function handleReset(store: Store, flags: StoreFlags): number {
  if (!flags.confirm) {
    console.error('refusing to reset without --confirm. this will drop every domain table.');
    return 1;
  }
  dropAllDomainTables(store);
  console.log(`reset: dropped all domain tables at ${store.path}`);
  return 0;
}

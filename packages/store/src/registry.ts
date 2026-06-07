import type { Store } from './connection';

export interface Migration {
  /** Monotonically increasing integer unique within the domain. */
  version: number;
  /** Short human-readable description (goes into _migrations_log). */
  description: string;
  /**
   * Forward migration. Runs inside a transaction managed by runMigrations and
   * receives the async `Store`; an `up` that issues DDL/DML must `await` each
   * `store.run`/`store.exec` (the driver is async). May be sync or async.
   */
  up: (store: Store) => void | Promise<void>;
}

export interface SchemaDef {
  /** Domain namespace — e.g., 'scrum', 'acb', 'pcd'. Prefixes tables. */
  domain: string;
  migrations: Migration[];
}

const registry = new Map<string, Migration[]>();

/**
 * Register a schema definition with the store. Domains typically call this
 * from a side-effect import. Duplicate `{domain, version}` pairs throw to
 * catch merge-conflict bugs where two migrations claim the same version.
 */
export function registerSchema(def: SchemaDef): void {
  const existing = registry.get(def.domain) ?? [];
  const combined = [...existing, ...def.migrations];
  const seen = new Set<number>();
  for (const m of combined) {
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version ${m.version} for domain '${def.domain}'`);
    }
    seen.add(m.version);
  }
  const sorted = [...combined].sort((a, b) => a.version - b.version);
  registry.set(def.domain, sorted);
}

/** Sorted list of registered domain names. */
export function listDomains(): string[] {
  return [...registry.keys()].sort();
}

/** Returns a sorted copy of the given domain's migrations (empty if unknown). */
export function getMigrations(domain: string): Migration[] {
  return [...(registry.get(domain) ?? [])];
}

/**
 * Wipe the in-memory registry. Intended for test isolation; production
 * code should never call this.
 */
export function clearRegistry(): void {
  registry.clear();
}

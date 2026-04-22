export { openStore, Store, type StoreOptions } from './connection';
export {
  dropAllDomainTables,
  runMigrations,
  type AppliedMigration,
  type DomainSnapshot,
  type MigrationResult,
} from './migrate';
export { type ResolveOptions, resolveDbPath } from './paths';
export {
  clearRegistry,
  getMigrations,
  listDomains,
  type Migration,
  registerSchema,
  type SchemaDef,
} from './registry';

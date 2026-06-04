export { openStore, Store, type StoreOptions } from './connection';
export {
  dropAllDomainTables,
  runMigrations,
  type AppliedMigration,
  type DomainSnapshot,
  type MigrationResult,
} from './migrate';
export {
  type MachineConfig,
  machineConfigFilePath,
  readMachineConfig,
  resolveDefaultContributor,
  setDefaultContributor,
} from './machine-config';
export { type ResolveOptions, resolveDbPath } from './paths';
export {
  add,
  canonicalProjectRoot,
  hide,
  list,
  type ProjectEntry,
  type ProjectRegistry,
  prune,
  read,
  registryBaseDir,
  registryFilePath,
  remove,
  upsert,
} from './project-registry';
export {
  clearRegistry,
  getMigrations,
  listDomains,
  type Migration,
  registerSchema,
  type SchemaDef,
} from './registry';

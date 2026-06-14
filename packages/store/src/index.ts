export { openStore, type SqlParam, Store, type StoreOptions, withTx } from './connection';
export {
  dropAllDomainTables,
  runMigrations,
  type AppliedMigration,
  type DomainSnapshot,
  type MigrationResult,
} from './migrate';
export {
  MACHINE_CONFIG_DIR_ENV_VAR,
  type MachineConfig,
  machineConfigFilePath,
  readMachineConfig,
  resolveCloudToken,
  resolveDefaultContributor,
  setCloudToken,
  setDefaultContributor,
} from './machine-config';
export {
  type CreateApiClient,
  DEFAULT_GROUP,
  PLATFORM_TOKEN_ENV_VAR,
  type ProvisionDeps,
  type ProvisionInput,
  type ProvisionResult,
  ProvisionError,
  provisionDatabase,
  type TursoApiClient,
} from './provision';
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
export { assertStoreSchemaCompatible, SchemaIncompatibleError } from './schema-guard';
// Re-export the shipped @tursodatabase/sync transform types so domain packages
// reference the canonical engine shapes through @claude-prove/store (which owns
// the @tursodatabase/sync dependency) instead of reaching into the transitive
// package directly. These are the one-sided conflict-recovery hook shapes the
// sync engine fires per CDC mutation at connect().
export type {
  DatabaseRowMutation,
  DatabaseRowStatement,
  DatabaseRowTransformResult,
} from '@tursodatabase/sync';
export { isUlid, ulid } from './ulid';
export {
  type GroupVerdict,
  type GroupVerdictRecord,
  appendGroupVerdict,
  VERDICT_VALUES,
  type VerdictValue,
} from './services/acb-writes';
export {
  type Acceptance,
  type AcceptanceCriterion,
  type AcceptanceCriterionStatus,
  type AcceptancePolicy,
  type AcceptanceScope,
  type AcceptanceVerifiesBy,
  type GateState,
  type GateVerdict,
  SCAN_ENTRY_TYPES,
  type ScanFieldSpec,
  SCAN_TYPE_SPECS,
  type TaskLayer,
  type TaskStatus,
  type TransitionTask,
  updateTaskStatus,
  type VerificationRecord,
  type VerificationVerdict,
} from './services/scrum-writes';

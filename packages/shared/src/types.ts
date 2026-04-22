/**
 * Shared primitive identifiers and record types used across prove packages.
 * Domain-specific types live in their owning package (scrum, acb, store, ...).
 */

export type TaskId = string;
export type StepId = string;
export type RunSlug = string;

export type BranchNamespace = 'feature' | 'fix' | 'chore' | 'refactor';

export interface RunRef {
  branch: BranchNamespace | string;
  slug: RunSlug;
}

export interface CommitRef {
  sha: string;
  branch?: string;
}

export type ISOTimestamp = string;

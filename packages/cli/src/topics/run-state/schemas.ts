/**
 * Schema definitions for `.prove/runs/<branch>/<slug>/` artifact files.
 *
 * Ported 1:1 from `tools/run_state/schemas.py`. Field names, types, enums,
 * defaults, and descriptions are identical to the Python source — on-disk
 * artifacts must stay readable across the cutover.
 *
 * Kind labels (`prd`, `plan`, `state`, `report`) select which schema applies
 * to a given file path via `inferKind(filename)`.
 */

import { basename, dirname } from 'node:path';
import type { FieldSpec, Schema } from './validator-engine';

// --- constants (mirrors tools/run_state/__init__.py and schemas.py top) ---

export const CURRENT_SCHEMA_VERSION = '1';

export const STEP_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
  'halted',
] as const;

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'halted'] as const;

export const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'halted'] as const;

export const REVIEW_VERDICTS = ['pending', 'approved', 'rejected', 'n/a'] as const;

export const VALIDATOR_PHASES = ['build', 'lint', 'test', 'custom', 'llm'] as const;

export const VALIDATOR_STATUSES = ['pending', 'pass', 'fail', 'skipped'] as const;

// --- prd.json ---

export const PRD_SCHEMA: Schema = {
  kind: 'prd',
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    schema_version: {
      type: 'str',
      required: true,
      description: 'Schema version for migration tracking',
      default: CURRENT_SCHEMA_VERSION,
    },
    kind: {
      type: 'str',
      required: true,
      enum: ['prd'],
      description: "Discriminator — must be 'prd'",
      default: 'prd',
    },
    title: {
      type: 'str',
      required: true,
      description: 'Short human-readable title for the run',
    },
    context: {
      type: 'str',
      required: false,
      description: 'Problem framing: why this run exists',
      default: '',
    },
    goals: {
      type: 'list',
      required: false,
      items: { type: 'str' },
      description: 'Concrete outcomes this run aims to deliver',
      default: [],
    },
    scope: {
      type: 'dict',
      required: false,
      fields: {
        in: {
          type: 'list',
          items: { type: 'str' },
          description: 'Work included in this run',
          default: [],
        },
        out: {
          type: 'list',
          items: { type: 'str' },
          description: 'Work explicitly deferred',
          default: [],
        },
      },
      description: 'In-scope and out-of-scope boundaries',
      default: { in: [], out: [] },
    },
    acceptance_criteria: {
      type: 'list',
      required: false,
      items: { type: 'str' },
      description: 'Testable criteria that must hold for the run to succeed',
      default: [],
    },
    test_strategy: {
      type: 'str',
      required: false,
      description: 'High-level testing approach',
      default: '',
    },
    body_markdown: {
      type: 'str',
      required: false,
      description: 'Free-form markdown body (longer narrative sections)',
      default: '',
    },
  },
};

// --- plan.json ---

const STEP_PLAN_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    id: {
      type: 'str',
      required: true,
      description: "Dotted step id (e.g., '1.2.3' — task_id + step seq)",
    },
    title: {
      type: 'str',
      required: true,
      description: 'Short step title',
    },
    description: {
      type: 'str',
      required: false,
      description: 'What this step does and why',
      default: '',
    },
    acceptance_criteria: {
      type: 'list',
      items: { type: 'str' },
      required: false,
      description: 'Criteria this step must satisfy before completion',
      default: [],
    },
  },
};

const TASK_PLAN_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    id: {
      type: 'str',
      required: true,
      description: "Dotted task id (e.g., '1.2' — wave + seq)",
    },
    title: {
      type: 'str',
      required: true,
      description: 'Short task title',
    },
    wave: {
      type: 'int',
      required: true,
      description: 'Parallel execution wave (integer >= 1)',
    },
    deps: {
      type: 'list',
      items: { type: 'str' },
      required: false,
      description: 'Task ids this task depends on',
      default: [],
    },
    description: {
      type: 'str',
      required: false,
      description: 'What this task accomplishes',
      default: '',
    },
    acceptance_criteria: {
      type: 'list',
      items: { type: 'str' },
      required: false,
      description: 'Criteria the task must satisfy before review',
      default: [],
    },
    worktree: {
      type: 'dict',
      required: false,
      fields: {
        path: {
          type: 'str',
          required: false,
          description: "Absolute path to the task's git worktree",
          default: '',
        },
        branch: {
          type: 'str',
          required: false,
          description: "Branch name for this task's worktree",
          default: '',
        },
      },
      description: 'Worktree assignment (full-mode parallel orchestration)',
    },
    steps: {
      type: 'list',
      required: true,
      items: STEP_PLAN_SPEC,
      description: 'Ordered steps that make up this task',
    },
  },
};

export const PLAN_SCHEMA: Schema = {
  kind: 'plan',
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    schema_version: {
      type: 'str',
      required: true,
      description: 'Schema version for migration tracking',
      default: CURRENT_SCHEMA_VERSION,
    },
    kind: {
      type: 'str',
      required: true,
      enum: ['plan'],
      description: "Discriminator — must be 'plan'",
      default: 'plan',
    },
    mode: {
      type: 'str',
      required: false,
      enum: ['simple', 'full'],
      description: 'Orchestrator execution mode: simple (sequential) or full (parallel waves)',
      default: 'simple',
    },
    tasks: {
      type: 'list',
      required: true,
      items: TASK_PLAN_SPEC,
      description: 'All tasks in this run, ordered by id',
    },
  },
};

// --- state.json ---

const VALIDATOR_SUMMARY_FIELDS: Record<string, FieldSpec> = {
  build: { type: 'str', enum: VALIDATOR_STATUSES, default: 'pending' },
  lint: { type: 'str', enum: VALIDATOR_STATUSES, default: 'pending' },
  test: { type: 'str', enum: VALIDATOR_STATUSES, default: 'pending' },
  custom: { type: 'str', enum: VALIDATOR_STATUSES, default: 'pending' },
  llm: { type: 'str', enum: VALIDATOR_STATUSES, default: 'pending' },
};

const VALIDATOR_SUMMARY_DESCRIPTION = 'Per-phase validator outcome summary';

const STEP_STATE_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    id: { type: 'str', required: true, description: 'Step id' },
    status: {
      type: 'str',
      required: true,
      enum: STEP_STATUSES,
      description: 'Current lifecycle status',
      default: 'pending',
    },
    started_at: {
      type: 'str',
      required: false,
      description: 'ISO-8601 UTC timestamp when step entered in_progress',
      default: '',
    },
    ended_at: {
      type: 'str',
      required: false,
      description: 'ISO-8601 UTC timestamp when step reached a terminal status',
      default: '',
    },
    commit_sha: {
      type: 'str',
      required: false,
      description: 'Git SHA of the commit that completed this step',
      default: '',
    },
    validator_summary: {
      type: 'dict',
      required: false,
      fields: VALIDATOR_SUMMARY_FIELDS,
      description: VALIDATOR_SUMMARY_DESCRIPTION,
      default: {
        build: 'pending',
        lint: 'pending',
        test: 'pending',
        custom: 'pending',
        llm: 'pending',
      },
    },
    halt_reason: {
      type: 'str',
      required: false,
      description: 'Reason the step halted (validation failure, manual halt, etc.)',
      default: '',
    },
  },
};

const TASK_STATE_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    id: { type: 'str', required: true, description: 'Task id' },
    status: {
      type: 'str',
      required: true,
      enum: TASK_STATUSES,
      description: 'Task lifecycle status',
      default: 'pending',
    },
    started_at: { type: 'str', default: '' },
    ended_at: { type: 'str', default: '' },
    review: {
      type: 'dict',
      required: false,
      fields: {
        verdict: {
          type: 'str',
          enum: REVIEW_VERDICTS,
          default: 'pending',
        },
        notes: { type: 'str', default: '' },
        reviewer: { type: 'str', default: '' },
        reviewed_at: { type: 'str', default: '' },
      },
      description: 'Principal-architect review outcome (full mode)',
      default: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
    },
    steps: {
      type: 'list',
      required: true,
      items: STEP_STATE_SPEC,
      description: 'Per-step state, mirrors plan.json tasks[].steps order',
    },
  },
};

const DISPATCH_ENTRY_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    key: { type: 'str', required: true, description: 'Dedup key (event + scope)' },
    event: { type: 'str', required: true, description: 'Reporter event name' },
    timestamp: { type: 'str', required: true, description: 'ISO-8601 UTC timestamp' },
  },
};

export const STATE_SCHEMA: Schema = {
  kind: 'state',
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    schema_version: {
      type: 'str',
      required: true,
      description: 'Schema version for migration tracking',
      default: CURRENT_SCHEMA_VERSION,
    },
    kind: {
      type: 'str',
      required: true,
      enum: ['state'],
      description: "Discriminator — must be 'state'",
      default: 'state',
    },
    run_status: {
      type: 'str',
      required: true,
      enum: RUN_STATUSES,
      description: 'Overall run lifecycle status',
      default: 'pending',
    },
    slug: {
      type: 'str',
      required: true,
      description: 'Run slug (matches directory name under .prove/runs/<branch>/)',
    },
    branch: {
      type: 'str',
      required: false,
      description: "Namespace branch under .prove/runs/ (e.g., 'feature', 'fix', 'main')",
      default: 'main',
    },
    current_task: {
      type: 'str',
      required: false,
      description: 'Task id currently executing (empty when none active)',
      default: '',
    },
    current_step: {
      type: 'str',
      required: false,
      description: 'Step id currently executing (empty when none active)',
      default: '',
    },
    started_at: { type: 'str', required: false, default: '' },
    updated_at: { type: 'str', required: true, description: 'Last mutation timestamp' },
    ended_at: { type: 'str', required: false, default: '' },
    tasks: {
      type: 'list',
      required: true,
      items: TASK_STATE_SPEC,
      description: 'Per-task execution state',
    },
    dispatch: {
      type: 'dict',
      required: false,
      fields: {
        dispatched: {
          type: 'list',
          items: DISPATCH_ENTRY_SPEC,
          description: 'Reporter events already dispatched (dedup ledger)',
          default: [],
        },
      },
      description: 'Reporter dispatch ledger (replaces legacy dispatch-state.json)',
      default: { dispatched: [] },
    },
  },
};

// --- reports/<step_id>.json ---

const VALIDATOR_RESULT_SPEC: FieldSpec = {
  type: 'dict',
  fields: {
    name: { type: 'str', required: true, description: 'Validator name' },
    phase: {
      type: 'str',
      required: true,
      enum: VALIDATOR_PHASES,
      description: 'Validator phase',
    },
    status: {
      type: 'str',
      required: true,
      enum: VALIDATOR_STATUSES,
      description: 'Outcome',
    },
    duration_s: {
      type: 'int',
      required: false,
      description: 'Runtime in seconds (int or float)',
      default: 0,
    },
    output: {
      type: 'str',
      required: false,
      description: 'Truncated stdout/stderr on failure',
      default: '',
    },
  },
};

export const REPORT_SCHEMA: Schema = {
  kind: 'report',
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    schema_version: {
      type: 'str',
      required: true,
      default: CURRENT_SCHEMA_VERSION,
    },
    kind: {
      type: 'str',
      required: true,
      enum: ['report'],
      default: 'report',
    },
    step_id: { type: 'str', required: true, description: 'Step id this report covers' },
    task_id: { type: 'str', required: true, description: 'Parent task id' },
    status: {
      type: 'str',
      required: true,
      enum: STEP_STATUSES,
      description: 'Terminal status captured in this report',
    },
    started_at: { type: 'str', required: false, default: '' },
    ended_at: { type: 'str', required: false, default: '' },
    commit_sha: { type: 'str', required: false, default: '' },
    diff_stats: {
      type: 'dict',
      required: false,
      fields: {
        files_changed: { type: 'int', default: 0 },
        insertions: { type: 'int', default: 0 },
        deletions: { type: 'int', default: 0 },
      },
      default: { files_changed: 0, insertions: 0, deletions: 0 },
    },
    validators: {
      type: 'list',
      required: false,
      items: VALIDATOR_RESULT_SPEC,
      description: 'Per-validator results for this step',
      default: [],
    },
    artifacts: {
      type: 'list',
      required: false,
      items: { type: 'str' },
      description: 'Paths to artifacts produced by the step (logs, diffs, etc.)',
      default: [],
    },
    notes: {
      type: 'str',
      required: false,
      description: 'Free-form notes',
      default: '',
    },
  },
};

export const SCHEMA_BY_KIND: Record<string, Schema> = {
  prd: PRD_SCHEMA,
  plan: PLAN_SCHEMA,
  state: STATE_SCHEMA,
  report: REPORT_SCHEMA,
};

/**
 * Map a filename (basename or full path) to the schema kind that governs it.
 * Returns null when the filename does not match a known run-state artifact.
 *
 * Matches:
 *   - prd.json          -> 'prd'
 *   - plan.json         -> 'plan'
 *   - state.json        -> 'state'
 *   - reports/<x>.json  -> 'report'
 */
export function inferKind(filename: string): string | null {
  const base = basename(filename);
  if (base === 'prd.json') return 'prd';
  if (base === 'plan.json') return 'plan';
  if (base === 'state.json') return 'state';
  // reports/<anything>.json — match on the immediate parent directory.
  const parent = basename(dirname(filename));
  if (parent === 'reports' && base.endsWith('.json')) return 'report';
  return null;
}

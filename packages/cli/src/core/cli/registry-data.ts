/**
 * The action-registry data for `scrum` and `run-state` — the two topics whose
 * flat help and one-at-a-time positional errors this registry exists to fix.
 *
 * Each entry's `flags` list the long option names that scope to that action;
 * descriptions are NOT duplicated here — the help renderer reads them live off
 * the cac command's registered `.option()` calls. Positionals are listed in
 * the order they appear on the command line.
 *
 * Keeping this table beside the dispatchers (rather than inline in each
 * handler) lets a maintainer audit every action's contract in one place and
 * keeps the help and error paths reading one source of truth.
 */

import type { ActionRegistry, TopicActions } from './action-registry';

const SCRUM_ACTIONS: TopicActions = {
  init: { positionals: [], flags: ['workspace-root'] },
  status: { positionals: [], flags: ['human', 'workspace-root'] },
  'next-ready': {
    positionals: [],
    flags: ['limit', 'milestone', 'human', 'workspace-root'],
  },
  'compile-plan': { positionals: [], flags: ['milestone', 'out', 'workspace-root'] },
  alerts: { positionals: [], flags: ['human', 'stalled-after-days', 'workspace-root'] },

  // task <subaction>
  'task create': {
    positionals: [],
    flags: [
      'title',
      'description',
      'milestone',
      'team',
      'id',
      'parent',
      'layer',
      'bounds',
      'workspace-root',
    ],
  },
  'task show': { positionals: ['id'], flags: ['workspace-root'] },
  'task list': { positionals: [], flags: ['status', 'milestone', 'tag', 'workspace-root'] },
  'task tag': { positionals: ['id', 'tag'], flags: ['workspace-root'] },
  'task link-decision': { positionals: ['id', 'decision-path'], flags: ['workspace-root'] },
  'task status': { positionals: ['id', 'new-status'], flags: ['workspace-root'] },
  'task cancel': {
    positionals: ['id'],
    flags: ['cascade', 'reason', 'detail', 'workspace-root'],
  },
  'task move': { positionals: ['id'], flags: ['milestone', 'unassign', 'team', 'workspace-root'] },
  'task delete': { positionals: ['id'], flags: ['workspace-root'] },
  'task add-dep': { positionals: ['from', 'to'], flags: ['kind', 'workspace-root'] },
  'task remove-dep': { positionals: ['from', 'to'], flags: ['kind', 'workspace-root'] },
  'task acceptance': {
    positionals: ['subaction', 'id'],
    flags: [
      'text',
      'verifies-by',
      'check',
      'idempotent',
      'scope',
      'timeout',
      'criterion',
      'verdict',
      'reason',
      'by',
      'workspace-root',
    ],
  },
  'task bounds': { positionals: ['subaction', 'id'], flags: ['bounds', 'workspace-root'] },

  'gate respond': {
    positionals: ['criterion-id', 'verdict'],
    flags: ['task', 'comment', 'by', 'workspace-root'],
  },

  // milestone <subaction>
  'milestone create': {
    positionals: [],
    flags: ['title', 'description', 'target-state', 'id', 'initiative', 'workspace-root'],
  },
  'milestone list': { positionals: [], flags: ['status', 'initiative', 'workspace-root'] },
  'milestone show': { positionals: ['id'], flags: ['workspace-root'] },
  'milestone activate': { positionals: ['id'], flags: ['workspace-root'] },
  'milestone reopen': { positionals: ['id'], flags: ['workspace-root'] },
  'milestone close': { positionals: ['id'], flags: ['status', 'workspace-root'] },

  // tag <subaction>
  'tag add': { positionals: ['task-id', 'tag'], flags: ['workspace-root'] },
  'tag remove': { positionals: ['task-id', 'tag'], flags: ['workspace-root'] },
  'tag list': { positionals: [], flags: ['task', 'tag', 'workspace-root'] },

  // decision <subaction>
  'decision record': { positionals: ['path'], flags: ['kind', 'workspace-root'] },
  'decision approve': { positionals: ['id'], flags: ['by', 'workspace-root'] },
  'decision reject': { positionals: ['id'], flags: ['by', 'reason', 'workspace-root'] },
  'decision get': { positionals: ['id'], flags: ['workspace-root'] },
  'decision list': {
    positionals: [],
    flags: ['topic', 'status', 'kind', 'human', 'workspace-root'],
  },
  'decision review-stale': { positionals: [], flags: ['days', 'human', 'workspace-root'] },
  'decision recover': { positionals: [], flags: ['from-git', 'workspace-root'] },

  // contributor <subaction>
  'contributor register': {
    positionals: [],
    flags: ['slug', 'display-name', 'github', 'email', 'id', 'status', 'workspace-root'],
  },
  'contributor list': { positionals: [], flags: ['status', 'human', 'workspace-root'] },
  'contributor resolve': { positionals: [], flags: ['github', 'email', 'workspace-root'] },
  'contributor default': { positionals: ['subaction'], flags: ['project-root', 'id'] },

  // operator <subaction>
  'operator set': { positionals: [], flags: ['contributor', 'from-ts', 'workspace-root'] },
  'operator resolve': { positionals: [], flags: ['at', 'workspace-root'] },
  'operator history': { positionals: [], flags: ['human', 'workspace-root'] },

  // link-run
  'link-run': {
    positionals: ['task-id', 'run-path'],
    flags: ['branch', 'slug', 'workspace-root'],
  },

  // hook
  hook: { positionals: ['event'], flags: ['workspace-root'] },
};

const RUN_STATE_ACTIONS: TopicActions = {
  validate: { positionals: ['file'], flags: ['kind', 'strict', 'runs-root', 'branch', 'slug'] },
  init: {
    positionals: [],
    flags: ['branch', 'slug', 'runs-root', 'plan', 'prd', 'overwrite'],
  },
  show: { positionals: [], flags: ['runs-root', 'branch', 'slug', 'kind', 'format'] },
  'show-report': {
    positionals: ['step_id'],
    flags: ['runs-root', 'branch', 'slug', 'format'],
  },
  ls: { positionals: [], flags: ['runs-root'] },
  summary: { positionals: [], flags: ['runs-root'] },
  current: { positionals: [], flags: ['runs-root', 'branch', 'slug', 'format'] },
  step: {
    positionals: ['action', 'step_id'],
    flags: ['runs-root', 'branch', 'slug', 'commit', 'reason', 'format'],
  },
  'step-info': { positionals: ['step_id'], flags: ['runs-root', 'branch', 'slug'] },
  validator: {
    positionals: ['action', 'step_id', 'phase', 'status'],
    flags: ['runs-root', 'branch', 'slug', 'format'],
  },
  task: {
    positionals: ['action', 'task_id'],
    flags: ['runs-root', 'branch', 'slug', 'verdict', 'notes', 'reviewer', 'format'],
  },
  dispatch: {
    positionals: ['action', 'key', 'event'],
    flags: ['runs-root', 'branch', 'slug'],
  },
  report: {
    positionals: ['action', 'step_id'],
    flags: ['runs-root', 'branch', 'slug', 'status', 'commit', 'json', 'notes'],
  },
  migrate: { positionals: [], flags: ['runs-root', 'dry-run', 'overwrite'] },
  'migrate-runs': { positionals: [], flags: ['runs-root', 'branch', 'slug'] },
  hook: { positionals: ['event'], flags: [] },
};

export const ACTION_REGISTRY: ActionRegistry = {
  scrum: SCRUM_ACTIONS,
  'run-state': RUN_STATE_ACTIONS,
};

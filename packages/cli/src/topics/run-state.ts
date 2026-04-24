/**
 * Register the `run-state` topic on the cac instance.
 *
 * cac matches commands by a single token (the first positional arg), so
 * every run-state sub-action lives under one `run-state <action>`
 * command. Internal dispatch re-routes to per-action handler modules
 * under `./run-state/cli/`. The user-facing shape mirrors
 * `tools/run_state/__main__.py` 1:1 so hooks, skills, and orchestrator
 * wrappers flip over without interface drift:
 *
 *   prove run-state validate <file> [--kind K] [--strict]
 *   prove run-state init --branch B --slug S --plan FILE [--prd FILE] [--overwrite]
 *   prove run-state show [--kind K] [--format md|json]
 *   prove run-state show-report <step_id> [--format md|json]
 *   prove run-state ls
 *   prove run-state summary
 *   prove run-state current [--format json|text]
 *   prove run-state step <start|complete|fail|halt> <step_id> [--commit SHA] [--reason TEXT]
 *   prove run-state step-info <step_id>
 *   prove run-state validator set <step_id> <phase> <status>
 *   prove run-state task review <task_id> --verdict V [--notes T] [--reviewer N]
 *   prove run-state dispatch <record|has> <key> [<event>]
 *   prove run-state report write <step_id> --status S [--commit SHA] [--json FILE] [--notes TEXT]
 *   prove run-state migrate [--dry-run] [--overwrite]
 *   prove run-state hook <guard|validate|session-start|stop|subagent-stop>
 *
 * Exit codes mirror Python:
 *   0  success
 *   1  usage / validation error (missing args, unknown action, I/O)
 *   2  schema / state invariant violation (suitable for hook blocking)
 *   3  dispatch miss (`dispatch record` on dup key, `dispatch has` on absent)
 *
 * Render-dependent md views (`show --format md`, `show-report --format
 * md`, `summary`, `current --format text`) wire into `render.ts`.
 * `--format json` works across all read paths.
 *
 * Hooks (`run-state hook <event>`) read a Claude Code hook payload from
 * stdin, dispatch to `./run-state/hooks/<event>.ts`, and exit with a
 * Python-compatible code. See `./run-state/hooks/dispatch.ts`.
 */

import type { CAC } from 'cac';
import { runDispatch } from './run-state/cli/dispatch-cmd';
import { runInit } from './run-state/cli/init-cmd';
import { runLs } from './run-state/cli/ls-cmd';
import { runMigrate } from './run-state/cli/migrate-cmd';
import { runReportWrite } from './run-state/cli/report-cmd';
import { runCurrent, runShow, runShowReport, runSummary } from './run-state/cli/show-cmd';
import { type StepAction, runStep } from './run-state/cli/step-cmd';
import { runStepInfo } from './run-state/cli/step-info-cmd';
import { runTaskReview } from './run-state/cli/task-cmd';
import { runValidate } from './run-state/cli/validate-cmd';
import { runValidatorSet } from './run-state/cli/validator-cmd';
import { HOOK_EVENTS, isHookEvent, runHookFromStdin } from './run-state/hooks/dispatch';

/**
 * Every flag the run-state command accepts, typed as a union — individual
 * handlers pull the subset they care about. cac passes flags through as
 * the last action-callback argument with camelCased keys for multi-word
 * options (`--runs-root` -> `runsRoot`).
 */
interface RunStateFlags {
  runsRoot?: string;
  branch?: string;
  slug?: string;
  kind?: string;
  strict?: boolean;
  plan?: string;
  prd?: string;
  overwrite?: boolean;
  format?: string;
  commit?: string;
  reason?: string;
  verdict?: string;
  notes?: string;
  reviewer?: string;
  status?: string;
  json?: string;
  dryRun?: boolean;
}

type RunStateAction =
  | 'validate'
  | 'init'
  | 'show'
  | 'show-report'
  | 'ls'
  | 'summary'
  | 'current'
  | 'step'
  | 'step-info'
  | 'validator'
  | 'task'
  | 'dispatch'
  | 'report'
  | 'migrate'
  | 'hook';

const ACTIONS: RunStateAction[] = [
  'validate',
  'init',
  'show',
  'show-report',
  'ls',
  'summary',
  'current',
  'step',
  'step-info',
  'validator',
  'task',
  'dispatch',
  'report',
  'migrate',
  'hook',
];

const STEP_ACTIONS = new Set<StepAction>(['start', 'complete', 'fail', 'halt']);

export function register(cli: CAC): void {
  cli
    .command(
      'run-state <action> [arg1] [arg2] [arg3] [arg4]',
      'Orchestrator run-state CRUD — writer for .prove/runs/<branch>/<slug>/ JSON artifacts',
    )
    // Run selection (shared by every mutator)
    .option(
      '--runs-root <path>',
      'Override .prove/runs root (default: $CLAUDE_PROJECT_DIR/.prove/runs)',
    )
    .option('--branch <b>', 'Run branch namespace (default: $PROVE_RUN_BRANCH or autodetect)')
    .option('--slug <s>', 'Run slug (default: $PROVE_RUN_SLUG or .prove-wt-slug.txt)')
    // validate
    .option('--kind <kind>', 'Schema kind override (validate/show: prd | plan | state | report)')
    .option('--strict', 'Treat warnings as errors (validate)')
    // init
    .option('--plan <path>', 'Path to plan.json input file (init)')
    .option('--prd <path>', 'Path to prd.json input file (init)')
    .option('--overwrite', 'Replace existing artifacts (init, migrate)')
    // show/show-report/step/etc format
    .option('--format <fmt>', 'Output format (md|json or json|text)')
    // step
    .option('--commit <sha>', 'Git SHA of the completing commit (step complete, report write)')
    .option('--reason <text>', 'Reason captured on step halt/fail')
    // task review
    .option('--verdict <v>', 'Review verdict (approved | rejected | pending | n/a)')
    .option('--notes <t>', 'Free-form review / report notes')
    .option('--reviewer <name>', 'Reviewer identity captured on the review record')
    // report write
    .option('--status <s>', 'Terminal report status (completed | failed | halted | skipped)')
    .option('--json <path>', 'Path to full report JSON (report write)')
    // migrate
    .option('--dry-run', 'Plan migration without writing files (migrate)')
    .action(
      (
        action: string,
        arg1: string | undefined,
        arg2: string | undefined,
        arg3: string | undefined,
        arg4: string | undefined,
        flags: RunStateFlags,
      ) => {
        if (!isRunStateAction(action)) {
          console.error(
            `error: unknown run-state action '${action}'. expected one of: ${ACTIONS.join(', ')}`,
          );
          process.exit(1);
        }
        const code = dispatch(action, arg1, arg2, arg3, arg4, flags);
        process.exit(code);
      },
    );
}

function isRunStateAction(value: string): value is RunStateAction {
  return (ACTIONS as string[]).includes(value);
}

/**
 * Positional-arg bundle for one invocation. cac hands us up to four
 * positionals; each sub-dispatcher destructures only what it needs by
 * name, so handler bodies never reason about `arg1..arg4` slot meanings.
 */
interface Positionals {
  arg1: string | undefined;
  arg2: string | undefined;
  arg3: string | undefined;
  arg4: string | undefined;
}

/**
 * Adapter at dispatch entry: validates the top-level action, then routes
 * to a per-action sub-dispatcher. Each sub-dispatcher owns its own
 * positional destructuring and flag narrowing, mirroring the Facade
 * pattern — one switch, many typed entry points.
 */
function dispatch(
  action: RunStateAction,
  arg1: string | undefined,
  arg2: string | undefined,
  arg3: string | undefined,
  arg4: string | undefined,
  flags: RunStateFlags,
): number {
  const pos: Positionals = { arg1, arg2, arg3, arg4 };
  switch (action) {
    case 'validate':
      return dispatchValidate(pos, flags);
    case 'init':
      return dispatchInit(flags);
    case 'show':
      return dispatchShow(flags);
    case 'show-report':
      return dispatchShowReport(pos, flags);
    case 'ls':
      return runLs({ runsRoot: flags.runsRoot });
    case 'summary':
      return runSummary({ runsRoot: flags.runsRoot });
    case 'current':
      return dispatchCurrent(flags);
    case 'step':
      return dispatchStep(pos, flags);
    case 'step-info':
      return dispatchStepInfo(pos, flags);
    case 'validator':
      return dispatchValidator(pos, flags);
    case 'task':
      return dispatchTask(pos, flags);
    case 'dispatch':
      return dispatchDispatch(pos, flags);
    case 'report':
      return dispatchReport(pos, flags);
    case 'migrate':
      return runMigrate({
        runsRoot: flags.runsRoot,
        dryRun: flags.dryRun,
        overwrite: flags.overwrite,
      });
    case 'hook':
      return dispatchHook(pos);
  }
}

// run-state validate <file>
function dispatchValidate({ arg1: file }: Positionals, flags: RunStateFlags): number {
  if (!file) return usage('the following arguments are required: file');
  return runValidate(file, { kind: flags.kind, strict: flags.strict });
}

// run-state init  (all inputs via flags)
function dispatchInit(flags: RunStateFlags): number {
  return runInit({
    branch: flags.branch,
    slug: flags.slug,
    runsRoot: flags.runsRoot,
    plan: flags.plan,
    prd: flags.prd,
    overwrite: flags.overwrite,
  });
}

function dispatchShow(flags: RunStateFlags): number {
  return runShow({
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    kind: narrowShowKind(flags.kind),
    format: narrowMdJson(flags.format ?? 'md'),
  });
}

// run-state show-report <step_id>
function dispatchShowReport({ arg1: stepId }: Positionals, flags: RunStateFlags): number {
  if (!stepId) return usage('the following arguments are required: step_id');
  return runShowReport(stepId, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    format: narrowMdJson(flags.format ?? 'md'),
  });
}

function dispatchCurrent(flags: RunStateFlags): number {
  return runCurrent({
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    format: narrowJsonText(flags.format ?? 'text'),
  });
}

// run-state step <start|complete|fail|halt> <step_id>
function dispatchStep(
  { arg1: stepAction, arg2: stepId }: Positionals,
  flags: RunStateFlags,
): number {
  if (!stepAction) return usage('the following arguments are required: action');
  if (!STEP_ACTIONS.has(stepAction as StepAction)) {
    console.error(
      `error: unknown step action '${stepAction}' (expected: start | complete | fail | halt)`,
    );
    return 1;
  }
  if (!stepId) return usage('the following arguments are required: step_id');
  return runStep(stepAction as StepAction, stepId, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    commit: flags.commit,
    reason: flags.reason,
    format: narrowMdJson(flags.format ?? 'md'),
  });
}

// run-state step-info <step_id>
function dispatchStepInfo({ arg1: stepId }: Positionals, flags: RunStateFlags): number {
  if (!stepId) return usage('the following arguments are required: step_id');
  return runStepInfo(stepId, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
  });
}

// run-state validator set <step_id> <phase> <status>
function dispatchValidator(
  { arg1: subAction, arg2: stepId, arg3: phase, arg4: status }: Positionals,
  flags: RunStateFlags,
): number {
  if (subAction !== 'set') {
    console.error(`error: unknown validator action '${subAction ?? ''}' (expected: set)`);
    return 1;
  }
  if (!stepId || !phase || !status) {
    return usage('the following arguments are required: step_id, phase, status');
  }
  return runValidatorSet(stepId, phase, status, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    format: narrowMdJson(flags.format ?? 'md'),
  });
}

// run-state task review <task_id>
function dispatchTask(
  { arg1: subAction, arg2: taskId }: Positionals,
  flags: RunStateFlags,
): number {
  if (subAction !== 'review') {
    console.error(`error: unknown task action '${subAction ?? ''}' (expected: review)`);
    return 1;
  }
  if (!taskId) return usage('the following arguments are required: task_id');
  return runTaskReview(taskId, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    verdict: flags.verdict,
    notes: flags.notes,
    reviewer: flags.reviewer,
    format: narrowMdJson(flags.format ?? 'md'),
  });
}

// run-state dispatch <record|has> <key> [<event>]
function dispatchDispatch(
  { arg1: subAction, arg2: key, arg3: event }: Positionals,
  flags: RunStateFlags,
): number {
  if (subAction !== 'record' && subAction !== 'has') {
    console.error(`error: unknown dispatch action '${subAction ?? ''}' (expected: record | has)`);
    return 1;
  }
  if (!key) return usage('the following arguments are required: key');
  return runDispatch(subAction, key, event, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
  });
}

// run-state report write <step_id>
function dispatchReport(
  { arg1: subAction, arg2: stepId }: Positionals,
  flags: RunStateFlags,
): number {
  if (subAction !== 'write') {
    console.error(
      `error: unknown report action '${subAction ?? ''}' (expected: write). report action not implemented for this format`,
    );
    return 1;
  }
  if (!stepId) return usage('the following arguments are required: step_id');
  return runReportWrite(stepId, {
    runsRoot: flags.runsRoot,
    branch: flags.branch,
    slug: flags.slug,
    status: flags.status,
    commit: flags.commit,
    json: flags.json,
    notes: flags.notes,
  });
}

// run-state hook <event>  — reads Claude Code hook payload from stdin,
// dispatches to the TS hook module, writes stdout/stderr, returns exit.
function dispatchHook({ arg1: event }: Positionals): number {
  if (!event) {
    return usage(
      `the following arguments are required: hook event (one of: ${HOOK_EVENTS.join(', ')})`,
    );
  }
  if (!isHookEvent(event)) {
    console.error(`error: unknown hook event '${event}' (expected: ${HOOK_EVENTS.join(' | ')})`);
    return 1;
  }
  return runHookFromStdin(event);
}

function usage(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

// Format narrowers keep the existing default-on-miss return shape so the
// caller always gets a usable format, but now warn on unrecognized input
// instead of coercing silently. Unknown values usually mean a typo
// (`yml`, `yaml`, `markdown`) the user should correct.
function narrowMdJson(value: string): 'md' | 'json' {
  if (value === 'md' || value === 'json') return value;
  console.warn(`warning: unknown --format '${value}' (expected: md | json); defaulting to 'md'`);
  return 'md';
}

function narrowJsonText(value: string): 'json' | 'text' {
  if (value === 'json' || value === 'text') return value;
  console.warn(
    `warning: unknown --format '${value}' (expected: json | text); defaulting to 'text'`,
  );
  return 'text';
}

function narrowShowKind(value: string | undefined): 'state' | 'plan' | 'prd' | 'report' {
  if (value === 'prd' || value === 'plan' || value === 'report') return value;
  return 'state';
}

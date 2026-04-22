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
 *   prove run-state validator set <step_id> <phase> <status>
 *   prove run-state task review <task_id> --verdict V [--notes T] [--reviewer N]
 *   prove run-state dispatch <record|has> <key> [<event>]
 *   prove run-state report write <step_id> --status S [--commit SHA] [--json FILE] [--notes TEXT]
 *   prove run-state migrate [--dry-run] [--overwrite]
 *
 * Exit codes mirror Python:
 *   0  success
 *   1  usage / validation error (missing args, unknown action, I/O)
 *   2  schema / state invariant violation (suitable for hook blocking)
 *   3  dispatch miss (`dispatch record` on dup key, `dispatch has` on absent)
 *
 * Hooks (`run-state hook <event>`) land in Task 6. Render-dependent md
 * views (`show --format md`, `show-report --format md`, `summary`,
 * `current --format text`) are stubbed to exit 2 with a pointer; they
 * wire into `render.ts` in the Task 4+5 post-merge pass. `--format json`
 * works today across all read paths.
 */

import type { CAC } from 'cac';
import { runDispatch } from './run-state/cli/dispatch-cmd';
import { runInit } from './run-state/cli/init-cmd';
import { runLs } from './run-state/cli/ls-cmd';
import { runMigrate } from './run-state/cli/migrate-cmd';
import { runReportWrite } from './run-state/cli/report-cmd';
import {
  runCurrent,
  runShow,
  runShowReport,
  runSummary,
} from './run-state/cli/show-cmd';
import { runStep, type StepAction } from './run-state/cli/step-cmd';
import { runTaskReview } from './run-state/cli/task-cmd';
import { runValidate } from './run-state/cli/validate-cmd';
import { runValidatorSet } from './run-state/cli/validator-cmd';

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
  | 'validator'
  | 'task'
  | 'dispatch'
  | 'report'
  | 'migrate';

const ACTIONS: RunStateAction[] = [
  'validate',
  'init',
  'show',
  'show-report',
  'ls',
  'summary',
  'current',
  'step',
  'validator',
  'task',
  'dispatch',
  'report',
  'migrate',
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

function dispatch(
  action: RunStateAction,
  arg1: string | undefined,
  arg2: string | undefined,
  arg3: string | undefined,
  arg4: string | undefined,
  flags: RunStateFlags,
): number {
  switch (action) {
    case 'validate':
      // run-state validate <file>
      if (!arg1) return usage('the following arguments are required: file');
      return runValidate(arg1, { kind: flags.kind, strict: flags.strict });

    case 'init':
      // run-state init  (all inputs via flags)
      return runInit({
        branch: flags.branch,
        slug: flags.slug,
        runsRoot: flags.runsRoot,
        plan: flags.plan,
        prd: flags.prd,
        overwrite: flags.overwrite,
      });

    case 'show':
      return runShow({
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        kind: narrowShowKind(flags.kind),
        format: narrowMdJson(flags.format ?? 'md'),
      });

    case 'show-report':
      if (!arg1) return usage('the following arguments are required: step_id');
      return runShowReport(arg1, {
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        format: narrowMdJson(flags.format ?? 'md'),
      });

    case 'ls':
      return runLs({ runsRoot: flags.runsRoot });

    case 'summary':
      return runSummary({ runsRoot: flags.runsRoot });

    case 'current':
      return runCurrent({
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        format: narrowJsonText(flags.format ?? 'text'),
      });

    case 'step': {
      // run-state step <start|complete|fail|halt> <step_id>
      const stepAction = arg1;
      const stepId = arg2;
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

    case 'validator': {
      // run-state validator set <step_id> <phase> <status>
      const subAction = arg1;
      if (subAction !== 'set') {
        console.error(`error: unknown validator action '${subAction ?? ''}' (expected: set)`);
        return 1;
      }
      if (!arg2 || !arg3 || !arg4) {
        return usage('the following arguments are required: step_id, phase, status');
      }
      return runValidatorSet(arg2, arg3, arg4, {
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        format: narrowMdJson(flags.format ?? 'md'),
      });
    }

    case 'task': {
      // run-state task review <task_id>
      const subAction = arg1;
      if (subAction !== 'review') {
        console.error(`error: unknown task action '${subAction ?? ''}' (expected: review)`);
        return 1;
      }
      if (!arg2) return usage('the following arguments are required: task_id');
      return runTaskReview(arg2, {
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        verdict: flags.verdict,
        notes: flags.notes,
        reviewer: flags.reviewer,
        format: narrowMdJson(flags.format ?? 'md'),
      });
    }

    case 'dispatch': {
      // run-state dispatch <record|has> <key> [<event>]
      const subAction = arg1;
      if (subAction !== 'record' && subAction !== 'has') {
        console.error(
          `error: unknown dispatch action '${subAction ?? ''}' (expected: record | has)`,
        );
        return 1;
      }
      if (!arg2) return usage('the following arguments are required: key');
      return runDispatch(subAction, arg2, arg3, {
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
      });
    }

    case 'report': {
      // run-state report write <step_id>
      const subAction = arg1;
      if (subAction !== 'write') {
        console.error(
          `error: unknown report action '${subAction ?? ''}' (expected: write; show wiring lands with Task 4 render port)`,
        );
        return 1;
      }
      if (!arg2) return usage('the following arguments are required: step_id');
      return runReportWrite(arg2, {
        runsRoot: flags.runsRoot,
        branch: flags.branch,
        slug: flags.slug,
        status: flags.status,
        commit: flags.commit,
        json: flags.json,
        notes: flags.notes,
      });
    }

    case 'migrate':
      return runMigrate({
        runsRoot: flags.runsRoot,
        dryRun: flags.dryRun,
        overwrite: flags.overwrite,
      });
  }
}

function usage(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

function narrowMdJson(value: string): 'md' | 'json' {
  return value === 'json' ? 'json' : 'md';
}

function narrowJsonText(value: string): 'json' | 'text' {
  return value === 'json' ? 'json' : 'text';
}

function narrowShowKind(value: string | undefined): 'state' | 'plan' | 'prd' | 'report' {
  if (value === 'prd' || value === 'plan' || value === 'report') return value;
  return 'state';
}

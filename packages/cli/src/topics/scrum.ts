/**
 * Register the `scrum` topic on the cac instance.
 *
 * Subcommand surface (agents and operators hit the same CLI):
 *
 *   claude-prove scrum init
 *   claude-prove scrum status                    [--human]
 *   claude-prove scrum next-ready                [--limit N] [--milestone M] [--human]
 *   claude-prove scrum compile-plan              --milestone M [--out plan.json]
 *   claude-prove scrum task create               --title X [--description Y] [--milestone M] [--id I] [--parent P] [--layer epic|story|task] [--bounds JSON]
 *   claude-prove scrum task show <id>
 *   claude-prove scrum task list                 [--status S] [--milestone M] [--tag T]
 *   claude-prove scrum task tag <id> <tag>
 *   claude-prove scrum task link-decision <id> <decision-path>
 *   claude-prove scrum task status <id> <new-status>
 *   claude-prove scrum task cancel <id>            [--cascade] [--reason R] [--detail D]
 *   claude-prove scrum task delete <id>
 *   claude-prove scrum task add-dep <from> <to>    [--kind blocks|blocked_by]
 *   claude-prove scrum task remove-dep <from> <to> [--kind blocks|blocked_by]
 *   claude-prove scrum task acceptance add <id>    --text T --verifies-by K --check C [--idempotent] [--timeout 30s] [--criterion ID]
 *   claude-prove scrum task acceptance list <id>
 *   claude-prove scrum task acceptance verify <id> --verdict verified|failed [--criterion ID] [--reason R] [--by WHO]
 *   claude-prove scrum task acceptance supersede <id> --criterion ID --reason R [--by NEW-ID]
 *   claude-prove scrum task bounds set <id>      --bounds JSON   (pass --bounds '' to clear)
 *   claude-prove scrum task bounds show <id>
 *   claude-prove scrum gate respond <criterion-id> <approve|reject> --task <id> [--comment T] [--by R]
 *   claude-prove scrum alerts                    [--human] [--stalled-after-days N]
 *   claude-prove scrum milestone create          --title X [--description Y] [--target-state S] [--id I] [--initiative N]
 *   claude-prove scrum milestone list            [--status S] [--initiative N]
 *   claude-prove scrum milestone show <id>
 *   claude-prove scrum milestone activate <id>
 *   claude-prove scrum milestone reopen <id>
 *   claude-prove scrum milestone close <id>
 *   claude-prove scrum tag add <task-id> <tag>
 *   claude-prove scrum tag remove <task-id> <tag>
 *   claude-prove scrum tag list                  [--task <id>] [--tag <tag>]
 *   claude-prove scrum decision record <path>    [--kind adr|glossary|pattern]   (gated kind lands as a draft, not yet accepted)
 *   claude-prove scrum decision approve <id>     --by <responder>   (accept a gated draft; glossary requires a tech_lead responder)
 *   claude-prove scrum decision reject <id>      --by <responder> [--reason R]   (block a gated draft; never becomes accepted)
 *   claude-prove scrum decision get <id>
 *   claude-prove scrum decision list             [--topic T] [--status S] [--kind K] [--human]
 *   claude-prove scrum decision review-stale     [--days N] [--human]
 *   claude-prove scrum decision recover          --from-git
 *   claude-prove scrum contributor register      --slug S [--display-name N] [--github G] [--email E] [--id CT-UUID] [--status active|inactive]
 *   claude-prove scrum contributor list          [--status active|inactive] [--human]
 *   claude-prove scrum contributor resolve       [--github G] [--email E]   (github match first, then email fallback)
 *   claude-prove scrum contributor default set   [--project-root P] --id CT-UUID   (home-dir map: project root → default contributor)
 *   claude-prove scrum contributor default show  [--project-root P]   (prints the resolved CT-UUID, or null when unmapped)
 *   claude-prove scrum operator set              --contributor CT-UUID [--from-ts ISO]   (transfer the operator-of-record + sync charter.md)
 *   claude-prove scrum operator resolve          --at ISO   (point-in-time holder — the interval containing the instant, NOT the current holder)
 *   claude-prove scrum operator history          [--human]
 *   claude-prove scrum team create               --slug S --team-type T [--charter C] [--lifetime persistent|terminates_on_milestone]
 *   claude-prove scrum team show <slug>
 *   claude-prove scrum team list                 [--human]
 *   claude-prove scrum team scope-set <slug>     [--read csv] [--write csv]   (REPLACE read/write globs; rejects cross-team write overlap)
 *   claude-prove scrum team scope-show <slug>
 *   claude-prove scrum team rotate <slug>        --role tech_lead|engineer|implementer --contributor CT-UUID [--reason text]   (rotate a role slot; warns on multi-slot, never rejects)
 *   claude-prove scrum team roster <slug>        (current holder per role)
 *   claude-prove scrum team accept-add <slug>    --ask-type KEBAB   (append a closed kebab-case ask type the team handles)
 *   claude-prove scrum team accept-supersede <slug> --id ID --reason R [--by NEW-ID]   (retire an accept entry in place; never deletes)
 *   claude-prove scrum team expose-add <slug>    --name N --schema-ref R   (append an exposed output other teams consume)
 *   claude-prove scrum team expose-supersede <slug> --id ID --reason R [--by NEW-ID]   (retire an expose entry in place; never deletes)
 *   claude-prove scrum team interface <slug>     (active accepts[] + exposes[])
 *   claude-prove scrum team terminate <slug>     [--reason text]   (manual team-local disband: release scope, supersede exposes, vacate roster, flip status to inactive)
 *   claude-prove scrum lore record <slug>        --body TEXT --author CT-UUID   (append a team-scoped Lore entry; rejects a non-tech_lead author, warns when no tech_lead seated)
 *   claude-prove scrum lore list <slug>          [--live] [--human]   (team Lore entries, oldest-first; --live = not yet superseded)
 *   claude-prove scrum lore show <id>            (one Lore entry by id)
 *   claude-prove scrum lore supersede <id>       (--by LORE-ID | --by-decision DECISION-ID) --reason R --author CT-UUID   (retire a live entry by pointer; never deletes)
 *   claude-prove scrum lore promote <id>         [--kind adr|glossary|pattern] [--title T] [--id D] (lift Lore into the Codex as a gated draft; approve auto-retires the source)
 *   claude-prove scrum annotation add            --target-kind task|team|decision --target REF --body TEXT --author ID   (append a per-artifact note; target is a soft reference, no authorship gate)
 *   claude-prove scrum annotation list           --target-kind K --target REF [--human]   (a target's notes, oldest-first)
 *   claude-prove scrum escalation raise          --task ID --type blocked|ambiguous|conflict|missing_context --summary TEXT [--layer RUNG] [--by ID]   (raise a typed escalation at a rung of the walk-up chain; default layer implementer)
 *   claude-prove scrum escalation show <id>      (one escalation by id)
 *   claude-prove scrum escalation list           [--task ID] [--human]   (a task's escalations oldest-first, or every open escalation across all tasks)
 *   claude-prove scrum escalation resolve <id>   --mode resolve|re_decompose|re_escalate [--note TEXT] [--by ID]   (receiver resolution: resolve→resolved, re_decompose→resolved+signal, re_escalate→walks one rung up)
 *   claude-prove scrum escalation chain <id>     [--human]   (reconstruct the full walk-up chain one escalation climbed, root rung first)
 *   claude-prove scrum manifest show             [--human]   (cross-team contracts: every team's active accepts[] + exposes[], both-teams-visible)
 *   claude-prove scrum ask file                  --from-team A --to-team B --ask-type T --blocking-artifact ART   (file a cross-team ask; to-team must accept T; ART must exist)
 *   claude-prove scrum ask respond <ask-id>      --verdict accept|reject|counter [--comment TEXT] [--by ID]   (mechanically apply a triage verdict: accept wires a child + blocked_by dep; reject/counter record --comment; no model spawn)
 *   claude-prove scrum ask await <ask-id>        (mechanical poll for the team-as-workflow-kind sugar: reports phase pending|waiting|ready|rejected|countered + to-team outputs on ready; no model spawn)
 *   claude-prove scrum link-run <task-id> <run-path> [--branch B] [--slug G]
 *   claude-prove scrum hook <event>              (event: session-start | subagent-stop | stop)
 *
 * All subcommands accept `--workspace-root W` (default: git common-dir via
 * mainWorktreeRoot(), falling back to process.cwd()).
 *
 * Stdout/stderr split (byte-equal across every handler):
 *   - stdout: JSON (machine-readable), or a human table when `--human` is set
 *   - stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action/event, parse error, or invariant violation
 */

import type { CAC } from 'cac';
import { runAlertsCmd } from './scrum/cli/alerts-cmd';
import { runAnnotationCmd } from './scrum/cli/annotation-cmd';
import { runAskCmd } from './scrum/cli/ask-cmd';
import { runCompilePlanCmd } from './scrum/cli/compile-plan-cmd';
import { runContributorCmd } from './scrum/cli/contributor-cmd';
import { runDecisionCmd } from './scrum/cli/decision-cmd';
import { runEscalationCmd } from './scrum/cli/escalation-cmd';
import { runGateCmd } from './scrum/cli/gate-cmd';
import { runHookCmd } from './scrum/cli/hook-cmd';
import { runInitCmd } from './scrum/cli/init-cmd';
import { runLinkRunCmd } from './scrum/cli/link-run-cmd';
import { runLoreCmd } from './scrum/cli/lore-cmd';
import { runManifestCmd } from './scrum/cli/manifest-cmd';
import { runMilestoneCmd } from './scrum/cli/milestone-cmd';
import { runNextReadyCmd } from './scrum/cli/next-ready-cmd';
import { runOperatorCmd } from './scrum/cli/operator-cmd';
import { runStatusCmd } from './scrum/cli/status-cmd';
import { runTagCmd } from './scrum/cli/tag-cmd';
import { runTaskCmd } from './scrum/cli/task-cmd';
import { runTeamCmd } from './scrum/cli/team-cmd';

type ScrumAction =
  | 'init'
  | 'status'
  | 'next-ready'
  | 'compile-plan'
  | 'alerts'
  | 'task'
  | 'gate'
  | 'milestone'
  | 'tag'
  | 'decision'
  | 'contributor'
  | 'operator'
  | 'team'
  | 'lore'
  | 'annotation'
  | 'escalation'
  | 'manifest'
  | 'ask'
  | 'link-run'
  | 'hook';

const SCRUM_ACTIONS: ScrumAction[] = [
  'init',
  'status',
  'next-ready',
  'compile-plan',
  'alerts',
  'task',
  'gate',
  'milestone',
  'tag',
  'decision',
  'contributor',
  'operator',
  'team',
  'lore',
  'annotation',
  'escalation',
  'manifest',
  'ask',
  'link-run',
  'hook',
];

interface ScrumFlags {
  human?: boolean;
  limit?: number | string;
  milestone?: string;
  // `task create` / `task move` team binding (--team <slug>); validated against
  // the registry at the store boundary.
  team?: string;
  title?: string;
  description?: string;
  id?: string;
  status?: string;
  tag?: string;
  task?: string;
  topic?: string;
  parent?: string;
  layer?: string;
  targetState?: string;
  initiative?: string;
  branch?: string;
  slug?: string;
  unassign?: boolean;
  kind?: string;
  stalledAfterDays?: number | string;
  fromGit?: boolean;
  by?: string;
  reason?: string;
  out?: string;
  workspaceRoot?: string;
  // `task acceptance` authoring flags (v5).
  text?: string;
  verifiesBy?: string;
  check?: string;
  idempotent?: boolean;
  scope?: string;
  timeout?: string;
  criterion?: string;
  // `gate respond` flag: human responder's optional rationale on the verdict.
  comment?: string;
  // `task create` + `task bounds set` declared-bounds JSON blob (v6).
  bounds?: string;
  // `task cancel` cascade + terminal provenance (v7).
  cascade?: boolean;
  detail?: string;
  // `decision review-stale` threshold in days (v7).
  days?: number | string;
  // `contributor` registry fields (v12). `slug` is shared with link-run's
  // run-slug flag above — distinct actions, so the value is correct per call.
  displayName?: string;
  github?: string;
  email?: string;
  // `contributor default <set|show>`: the project root keyed in the home-dir
  // config (default: cwd). Store-independent — never touches .prove/prove.db.
  projectRoot?: string;
  // `operator` position-history fields (v13). `contributor` is the new holder's
  // CT-UUID for `set`; `fromTs` backdates the handoff; `at` is the resolve instant.
  contributor?: string;
  fromTs?: string;
  at?: string;
  // `team` registry fields (v14). `slug` is shared with the contributor/link-run
  // slug flags above — distinct actions, so the value is correct per call.
  teamType?: string;
  charter?: string;
  lifetime?: string;
  // `team create` (v18): the terminating-lifetime team's target milestone.
  terminatesOn?: string;
  // `team scope-set` read/write glob CSVs (v15).
  read?: string;
  write?: string;
  // `team rotate` role-roster fields (v16). `role` is the slot being rotated;
  // `contributor` (shared with operator above) is the new holder; `reason`
  // (shared with decision supersede above) is the rotation rationale.
  role?: string;
  // `team accept-add`/`expose-add` + `*-supersede` interface fields (v17).
  // `askType` is the kebab-case ask type; `name`/`schemaRef` an exposed output;
  // `id` the interface row to supersede; `by` (shared with decision supersede
  // above) the replacement row id; `reason` (shared above) the supersession
  // rationale.
  askType?: string;
  name?: string;
  schemaRef?: string;
  // `lore record` (v19). `body` is the Lore entry's free text; `author` is the
  // writer's CT-UUID (must be the team's current tech_lead when one is seated).
  // `body` + `author` are shared by `annotation add` (v20) below.
  body?: string;
  author?: string;
  // `lore supersede`/`list` (v28). `byDecision` is the replacement Codex
  // decision id (the `--by` lore-id form shares the decision-supersede flag
  // above); `live` filters `lore list` to entries no supersession has retired.
  byDecision?: string;
  live?: boolean;
  // `annotation add`/`list` (v20). `targetKind` is the artifact class the note
  // attaches to (task | team | decision); `target` is the soft reference to the
  // specific target within that class.
  targetKind?: string;
  target?: string;
  // `ask file` (v23). `fromTeam` raises the ask, `toTeam` is the sibling asked
  // (must accept `askType`, shared with the team interface flags above), and
  // `blockingArtifact` is the task id blocked on the ask.
  fromTeam?: string;
  toTeam?: string;
  blockingArtifact?: string;
  // `ask respond` (v25). `verdict` is the closed triage verdict (accept | reject
  // | counter); `comment` (shared with `gate respond` above) is the
  // verdict-specific rationale (rejected_reason / counter_proposal); `by` (shared
  // with decision/escalation above) is who produced the verdict.
  verdict?: string;
  // `escalation raise`/`resolve` (v24). `type` is the closed escalation kind
  // (blocked | ambiguous | conflict | missing_context); `summary` the
  // receiver-facing prose; `mode` the resolution mode (resolve | re_decompose |
  // re_escalate); `note` the receiver's rationale. `task` (above) is the owning
  // task; `layer` (shared with `task create`'s containment tier above — distinct
  // actions, so the value is correct per call) is the rung to raise at (default
  // implementer); `by` (shared with decision/team supersede above) is who raised
  // / resolved.
  type?: string;
  summary?: string;
  mode?: string;
  note?: string;
}

export function register(cli: CAC): void {
  cli
    .command('scrum <action> [arg1] [arg2] [arg3]', 'Agentic task management')
    .option('--human', 'Emit a human-readable table instead of JSON')
    .option('--limit <n>', 'Max rows for next-ready (default: 10)')
    .option('--milestone <id>', 'Milestone filter or foreign key')
    .option(
      '--team <slug>',
      "task create / task move: bind the task to a registered team (validated against the registry); on move, --team='' unbinds",
    )
    .option('--title <t>', 'Task or milestone title (create actions)')
    .option('--description <d>', 'Task or milestone description')
    .option('--id <id>', 'Explicit id (create actions; default: generated from title)')
    .option('--parent <id>', 'Parent task id for `task create` (the epic→story→task tree)')
    .option('--layer <l>', 'Containment tier for `task create` (epic | story | task)')
    .option('--status <s>', 'Status filter (list / close / create)')
    .option('--tag <t>', 'Tag filter')
    .option('--task <id>', 'Task filter for `tag list`; owning task for `gate respond`')
    .option('--topic <t>', 'Topic filter for `decision list`')
    .option('--target-state <s>', 'Milestone target state (milestone create)')
    .option(
      '--initiative <i>',
      'Initiative grouping (milestone create sets it; milestone list filters by it)',
    )
    .option('--branch <b>', 'Branch name for link-run')
    .option('--slug <g>', 'Run slug for link-run')
    .option('--unassign', 'Clear milestone_id (scrum task move)')
    .option(
      '--kind <k>',
      'Dep-edge kind for task add-dep/remove-dep (blocks | blocked_by); also decision record Codex subtype (adr | glossary | pattern)',
    )
    .option('--stalled-after-days <n>', 'Alerts: stalled WIP threshold in days (default: 7)')
    .option('--from-git', 'decision recover: scan git history for .prove/decisions/*.md blobs')
    .option(
      '--by <id>',
      'decision supersede: id of the replacement decision; decision approve/reject: the gate responder (required; glossary approve needs a current tech_lead)',
    )
    .option(
      '--reason <text>',
      'decision supersede: rationale recorded on the retired decision; decision reject: optional gate rationale recorded on the row',
    )
    .option('--out <path>', 'compile-plan: write plan.json here + scrum-map.json sibling')
    .option('--text <t>', 'task acceptance add: criterion text')
    .option('--verifies-by <k>', 'task acceptance add: bash | assert | gate | agent')
    .option('--check <c>', 'task acceptance add: kind-specific check payload (command/expr/prompt)')
    .option('--idempotent', 'task acceptance add: mark the criterion safe to re-run')
    .option(
      '--scope <s>',
      'task acceptance add: copy-down scope (descendants | self | both); absent defaults to both',
    )
    .option('--timeout <t>', 'task acceptance add: optional wall-clock budget (e.g. 30s)')
    .option('--criterion <id>', 'task acceptance: explicit criterion id (default: generated)')
    .option('--comment <text>', 'gate respond: optional human rationale recorded on the verdict')
    .option(
      '--bounds <json>',
      "task create / task bounds set: declared bounds JSON ({ read?, write?, tools?, budgets? }); pass '' to clear",
    )
    .option(
      '--cascade',
      'task cancel: recursively cancel every descendant in the parent_id subtree',
    )
    .option('--detail <text>', 'task cancel: free-text elaboration recorded as terminal_detail')
    .option('--days <n>', 'decision review-stale: staleness threshold in days (default: 90)')
    .option('--slug <s>', 'contributor register: human-friendly handle (the CT-UUID is derived)')
    .option('--display-name <n>', 'contributor register: display name')
    .option('--github <g>', 'contributor register/resolve: GitHub handle (primary resolution key)')
    .option('--email <e>', 'contributor register/resolve: email (fallback resolution key)')
    .option(
      '--project-root <p>',
      'contributor default set/show: project root keyed in the home-dir config (default: cwd)',
    )
    .option(
      '--contributor <id>',
      'operator set: new operator-of-record holder (a contributor CT-UUID)',
    )
    .option(
      '--from-ts <iso>',
      'operator set: ISO-8601 effective instant of the handoff (default: now)',
    )
    .option(
      '--at <iso>',
      'operator resolve: ISO-8601 instant to attribute — resolves the holder at that point in time',
    )
    .option(
      '--team-type <t>',
      'team create: interaction archetype (stream_aligned | platform | enabling | complicated_subsystem)',
    )
    .option('--charter <c>', 'team create: one-line mission statement')
    .option(
      '--lifetime <l>',
      'team create: expected longevity (persistent | terminates_on_milestone); default persistent',
    )
    .option(
      '--terminates-on <m>',
      'team create: target milestone a terminates_on_milestone team disbands on (required for that lifetime, forbidden for persistent)',
    )
    .option(
      '--read <csv>',
      'team scope-set: comma-separated read globs (REPLACE; omit to clear). Read scopes may overlap across teams',
    )
    .option(
      '--write <csv>',
      'team scope-set: comma-separated write globs (REPLACE; omit to clear). Write scopes must be disjoint across teams (single writer per path)',
    )
    .option('--role <r>', 'team rotate: role slot to rotate (tech_lead | engineer | implementer)')
    .option(
      '--ask-type <a>',
      'team accept-add: closed kebab-case ask type the team handles (e.g. schema-change)',
    )
    .option('--name <n>', 'team expose-add: handle of the exposed output')
    .option('--schema-ref <r>', "team expose-add: pointer to the exposed output's shape")
    .option(
      '--body <text>',
      'lore record / annotation add: the entry body (Lore wisdom or per-artifact note)',
    )
    .option(
      '--author <id>',
      'lore record/supersede: the writing author (a contributor CT-UUID; must be the team current tech_lead when one is seated). annotation add: the note author (recorded, not gated)',
    )
    .option(
      '--by-decision <id>',
      'lore supersede: the replacement Codex decision id (the promotion / codex-duplicate retire form; --by takes the consolidation lore id)',
    )
    .option(
      '--live',
      'lore list: only entries no supersession has retired (the team-artifact window set)',
    )
    .option(
      '--target-kind <k>',
      'annotation add/list: the target artifact class (task | team | decision)',
    )
    .option(
      '--target <ref>',
      'annotation add/list: the target identifier within its class (a soft reference — existence is not checked)',
    )
    .option('--from-team <slug>', 'ask file: the team raising the ask')
    .option(
      '--to-team <slug>',
      'ask file: the sibling team asked (must accept the --ask-type in its active interface)',
    )
    .option(
      '--blocking-artifact <task-id>',
      'ask file: the task id blocked on the ask (must be an existing task)',
    )
    .option(
      '--verdict <v>',
      'ask respond: the triage verdict (accept | reject | counter; accept wires a child + dep, reject/counter record --comment only); task acceptance verify: the recorded verdict (verified | failed)',
    )
    .option(
      '--type <t>',
      'escalation raise: the escalation kind (blocked | ambiguous | conflict | missing_context)',
    )
    .option('--summary <text>', 'escalation raise: the receiver-facing prose')
    .option(
      '--mode <m>',
      'escalation resolve: the resolution mode (resolve | re_decompose | re_escalate)',
    )
    .option('--note <text>', 'escalation resolve: the receiver rationale recorded on resolution')
    .option(
      '--workspace-root <w>',
      'Main worktree root; pins store to <root>/.prove/prove.db (default: git common-dir)',
    )
    .action(
      async (
        action: string,
        arg1: string | undefined,
        arg2: string | undefined,
        arg3: string | undefined,
        flags: ScrumFlags,
      ) => {
        if (!isScrumAction(action)) {
          console.error(
            `error: unknown scrum action '${action}'. expected one of: ${SCRUM_ACTIONS.join(', ')}`,
          );
          process.exit(1);
        }
        const code = await dispatch(action, arg1, arg2, arg3, flags);
        process.exit(code);
      },
    );
}

function isScrumAction(value: string): value is ScrumAction {
  return (SCRUM_ACTIONS as string[]).includes(value);
}

async function dispatch(
  action: ScrumAction,
  arg1: string | undefined,
  arg2: string | undefined,
  arg3: string | undefined,
  flags: ScrumFlags,
): Promise<number> {
  switch (action) {
    case 'init':
      return runInitCmd({ workspaceRoot: flags.workspaceRoot });

    case 'status':
      return runStatusCmd({ human: flags.human, workspaceRoot: flags.workspaceRoot });

    case 'next-ready':
      return runNextReadyCmd({
        limit: flags.limit,
        milestone: flags.milestone,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'compile-plan':
      return runCompilePlanCmd({
        milestone: flags.milestone,
        out: flags.out,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'alerts':
      return runAlertsCmd({
        human: flags.human,
        stalledAfterDays: flags.stalledAfterDays,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'task':
      if (arg1 === undefined) {
        console.error(
          'error: scrum task: sub-action required (one of: create | show | list | tag | link-decision | status | cancel | move | delete | add-dep | remove-dep | acceptance | bounds)',
        );
        return 1;
      }
      return runTaskCmd(arg1, [arg2, arg3], {
        title: flags.title,
        description: flags.description,
        milestone: flags.milestone,
        team: flags.team,
        id: flags.id,
        parent: flags.parent,
        layer: flags.layer,
        status: flags.status,
        tag: flags.tag,
        unassign: flags.unassign,
        kind: flags.kind,
        text: flags.text,
        verifiesBy: flags.verifiesBy,
        check: flags.check,
        idempotent: flags.idempotent,
        scope: flags.scope,
        timeout: flags.timeout,
        criterion: flags.criterion,
        verdict: flags.verdict,
        reason: flags.reason,
        by: flags.by,
        bounds: flags.bounds,
        cascade: flags.cascade,
        detail: flags.detail,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'gate':
      if (arg1 === undefined) {
        console.error('error: scrum gate: sub-action required (one of: respond)');
        return 1;
      }
      return runGateCmd(arg1, [arg2, arg3], {
        task: flags.task,
        comment: flags.comment,
        by: flags.by,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'milestone':
      if (arg1 === undefined) {
        console.error(
          'error: scrum milestone: sub-action required (one of: create | list | show | close | activate | reopen)',
        );
        return 1;
      }
      return runMilestoneCmd(arg1, [arg2, arg3], {
        title: flags.title,
        description: flags.description,
        targetState: flags.targetState,
        id: flags.id,
        status: flags.status,
        initiative: flags.initiative,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'tag':
      if (arg1 === undefined) {
        console.error('error: scrum tag: sub-action required (one of: add | remove | list)');
        return 1;
      }
      return runTagCmd(arg1, [arg2, arg3], {
        task: flags.task,
        tag: flags.tag,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'decision':
      if (arg1 === undefined) {
        console.error(
          'error: scrum decision: sub-action required (one of: record | approve | reject | get | list | recover | supersede | review-stale)',
        );
        return 1;
      }
      return runDecisionCmd(arg1, [arg2, arg3], {
        topic: flags.topic,
        status: flags.status,
        human: flags.human,
        fromGit: flags.fromGit,
        by: flags.by,
        reason: flags.reason,
        days: flags.days,
        kind: flags.kind,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'contributor':
      if (arg1 === undefined) {
        console.error(
          'error: scrum contributor: sub-action required (one of: register | list | resolve | default)',
        );
        return 1;
      }
      return runContributorCmd(
        arg1,
        {
          slug: flags.slug,
          id: flags.id,
          status: flags.status,
          displayName: flags.displayName,
          github: flags.github,
          email: flags.email,
          human: flags.human,
          projectRoot: flags.projectRoot,
          workspaceRoot: flags.workspaceRoot,
        },
        arg2,
      );

    case 'operator':
      if (arg1 === undefined) {
        console.error(
          'error: scrum operator: sub-action required (one of: set | resolve | history)',
        );
        return 1;
      }
      return runOperatorCmd(arg1, {
        contributor: flags.contributor,
        fromTs: flags.fromTs,
        at: flags.at,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'team':
      if (arg1 === undefined) {
        console.error(
          'error: scrum team: sub-action required (one of: create | show | list | scope-set | scope-show | rotate | roster | accept-add | accept-supersede | expose-add | expose-supersede | interface | terminate | sync-agents)',
        );
        return 1;
      }
      return runTeamCmd(arg1, [arg2], {
        slug: flags.slug,
        teamType: flags.teamType,
        charter: flags.charter,
        lifetime: flags.lifetime,
        terminatesOn: flags.terminatesOn,
        read: flags.read,
        write: flags.write,
        role: flags.role,
        contributor: flags.contributor,
        reason: flags.reason,
        askType: flags.askType,
        name: flags.name,
        schemaRef: flags.schemaRef,
        id: flags.id,
        by: flags.by,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'lore':
      if (arg1 === undefined) {
        console.error(
          'error: scrum lore: sub-action required (one of: record | list | show | supersede | promote)',
        );
        return 1;
      }
      return runLoreCmd(arg1, [arg2], {
        body: flags.body,
        author: flags.author,
        // CAC auto-casts numeric option values (`--by 6` arrives as the number
        // 6); normalize to strings so the handler's parsing owns the shape.
        by: flags.by === undefined ? undefined : String(flags.by),
        byDecision: flags.byDecision,
        reason: flags.reason,
        kind: flags.kind,
        title: flags.title,
        id: flags.id === undefined ? undefined : String(flags.id),
        live: flags.live,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'annotation':
      if (arg1 === undefined) {
        console.error('error: scrum annotation: sub-action required (one of: add | list)');
        return 1;
      }
      return runAnnotationCmd(arg1, {
        targetKind: flags.targetKind,
        target: flags.target,
        body: flags.body,
        author: flags.author,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'escalation':
      if (arg1 === undefined) {
        console.error(
          'error: scrum escalation: sub-action required (one of: raise | show | list | resolve | chain)',
        );
        return 1;
      }
      return runEscalationCmd(arg1, [arg2], {
        task: flags.task,
        type: flags.type,
        summary: flags.summary,
        layer: flags.layer,
        mode: flags.mode,
        note: flags.note,
        by: flags.by,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'manifest':
      if (arg1 === undefined) {
        console.error('error: scrum manifest: sub-action required (one of: show)');
        return 1;
      }
      return runManifestCmd(arg1, {
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'ask':
      if (arg1 === undefined) {
        console.error('error: scrum ask: sub-action required (one of: file | respond | await)');
        return 1;
      }
      return runAskCmd(arg1, [arg2], {
        fromTeam: flags.fromTeam,
        toTeam: flags.toTeam,
        askType: flags.askType,
        blockingArtifact: flags.blockingArtifact,
        verdict: flags.verdict,
        comment: flags.comment,
        by: flags.by,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'link-run':
      return runLinkRunCmd(arg1, arg2, {
        branch: flags.branch,
        slug: flags.slug,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'hook':
      if (arg1 === undefined) {
        console.error(
          'error: scrum hook: event required (one of: session-start | subagent-stop | stop)',
        );
        return 1;
      }
      return runHookCmd(arg1, { workspaceRoot: flags.workspaceRoot });
  }
}

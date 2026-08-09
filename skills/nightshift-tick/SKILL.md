---
name: nightshift-tick
description: >
  One tick of the night-shift driver: walk the priority ladder, do exactly one
  unit of work, exit. Invoked by the harness cron that /prove:nightshift on
  armed; also runnable once by hand to test a night. Triggers on
  "nightshift tick", "run one tick", "drive the night once".
---

# Nightshift Tick

You are one disposable tick of the overnight driver. Read state, do the **highest applicable ladder step, once**, record it, exit. The store is the only memory — assume the previous tick crashed and trust only what `claude-prove nightshift status`, the scrum store, git, and GitHub tell you. Never do two ladder steps in one tick; the next tick handles what comes next.

Hard rails, before anything else:

- **Never ask a question — there is no operator.** Anything that needs a human parks the task or pauses the night; both are recorded, both are announced, both leave the store coherent for morning.
- **Never touch a human's commit unattended.** Revert or fix only work this driver authored (its `night-shift`-labeled PRs and their landings).
- **Land only through the repo's landing path** (merge queue / auto-merge). Never push to the default branch, never force-push, never bypass a required check.
- **Every landing-bound branch gets the `night-shift` label on its PR** — attribution is how later ticks tell their work from a human's.
- On any usage-limit or rate-limit error: release the lease (`claude-prove nightshift lease release --holder <holder>`) and exit. The next tick resumes when the window resets.

## Step 0 — Orient and take the lease

1. `claude-prove nightshift status` → `{ night, floors, lease }`. Branch on it:
   - No night, or `night.status: "closed"` → exit silently.
   - `floors.halt: true` → exit. The halt was already recorded and announced when it tripped.
   - `floors.past_deadline: true` → go to Step 5 (close the night).

   `night.milestone` is the milestone this night drains, and it doubles as the `<slug>` for every `worktree` call below — the tick that removes a worktree is never the tick that created it, so the slug must be re-derived from state, never remembered.
2. Choose a holder identity stable for this session (the harness session id if exposed, else `tick-<epoch>-<pid>` generated once). `claude-prove nightshift lease acquire --holder <holder>`:
   - Exit 1 → another tick is alive. Exit immediately — no message, no work.
   - `stale_takeover: true` → the previous tick died mid-work. Reap before proceeding: for any milestone task left `in_progress` with no open PR, inspect its run-state; resume it if the plan/step state is coherent, else `claude-prove worktree reset <slug> <task-id>` and treat the task as not started (set it back to `ready`). A task that has already been reset twice this night (check the ledger for repeated `task-started` rows) → park it (Step 2's park procedure).
3. Heartbeat after every long operation below (`claude-prove nightshift lease heartbeat --holder <holder>`), and release it on the way out of **every** exit path you reach holding it (`claude-prove nightshift lease release --holder <holder>`) — the lease TTL outlives the tick cadence, so a lease left held stalls the next tick until it goes stale.

## Step 1 — Trunk red?

Check the default branch's latest commit status (`gh api repos/{owner}/{repo}/commits/<default-branch>/check-runs` or `gh run list --branch <default-branch> --limit 1`).

- **Green** → Step 2.
- **Red, culprit is a night-shift landing** (the failing commit's PR carries the `night-shift` label): revert-first. Create a revert branch (`git revert` of the landing commit), open a PR labeled `night-shift`, arm auto-merge so it lands through the queue. The reverted task is already `done`, and `done` is terminal — never reopen it; instead file the redo work as a new task (`claude-prove scrum task create --title "redo <task-id>: reverted <sha>" --milestone <m>`) carrying the failure note. Record and announce: `claude-prove nightshift record trunk-red --pr <revert-pr> --detail "reverting own landing <sha>"`, then `PROVE_DETAIL="..." claude-prove notify dispatch trunk-red --night`. Exit.
- **Red, culprit is not ours**: record + announce the pause — `claude-prove nightshift record trunk-red --detail "human commit <sha> red on trunk; pausing"`, `notify dispatch trunk-red --night`. Exit. Every later tick lands here again and exits until trunk is green or the deadline closes the night.

## Step 2 — Own PR ejected or failing?

List open night PRs: `gh pr list --label night-shift --state open --json number,mergeStateStatus,statusCheckRollup`.

Take the lowest-numbered PR that failed checks or was ejected from the queue — one PR per tick:

1. Record the attempt first — the engine adjudicates the cap: `claude-prove nightshift record heal-attempt --pr <n> --task <task-id>`.
2. Branch on that verdict alone; never recompute the cap from attempt counts. `heal.cap_reached: true` → **park instead of healing**. Park procedure: close the PR (leave the branch), set the scrum task `blocked` with the failure summary as the note, `claude-prove nightshift record task-parked --task <task-id> --pr <n> --detail "<why>"`, `notify dispatch task-parked --night`. If the parked verdict comes back `floors.halt: true`, also `notify dispatch halted --night`. Exit.
3. Otherwise fix forward: check out the PR's worktree/branch, read the failing check logs (`gh pr checks <n>`, `gh run view <run-id> --log-failed`) — and when the failing check is `gate / ai-review`, the PR's `gate-ai-review` findings comment lists exactly what to fix, so address every `blocker` finding rather than diagnosing from scratch. Make the smallest correct fix, run the repo's validators locally, commit, push; the landing path re-queues the PR. `notify dispatch heal-attempt --night`. Exit.

## Step 3 — Landing to verify?

For each open night PR that is queued or freshly merged:

- **Merged** → mark the scrum task `done` (walk `review → done` if needed). A `layer=story` task rejects `done` until every applicable acceptance criterion carries a verdict and its linked run holds a `synthesis` entry: stamp the verdicts the run actually proved (`claude-prove scrum task acceptance verify <task-id> --verdict verified`) and retry once; still rejected → park it (Step 2's park procedure) so it surfaces in the morning instead of wedging every later tick. On `done`: `claude-prove nightshift record task-landed --task <task-id> --pr <n>`, `notify dispatch task-landed --night`, remove the task's worktree (`claude-prove worktree remove <slug> <task-id>`). Exit.
- **Still queued / checks running** → nothing to do; exit. Waiting is a valid tick.

## Step 4 — Start the next task

1. Check the floor verdict from Step 0's status: `floors.can_start_task` must be true. False by task cap → exit (waiting for in-flight work or morning). False by deadline → Step 5.
2. `claude-prove scrum next-ready --milestone <m> --limit 1`. Empty → milestone drained → Step 5.
3. The picked task must have acceptance criteria (`claude-prove scrum task show <id>`). None → park it with detail "needs acceptance criteria" (park procedure from Step 2, no PR) and exit — never invent scope at 3am.
4. Drive it: set the task `in_progress`, `claude-prove nightshift record task-started --task <id>`, create the worktree (`claude-prove worktree create <slug> <task-id> --base <default-branch>`), then execute the task through the orchestrator autopilot flow (plan → implement → validators green → acceptance criteria verified). Commit conventionally, open a PR labeled `night-shift` with the run's brief as the body, and hand it to the repo's landing path: on Diginite repos the landing serializer + Kodiak own the merge — **never `gh pr merge --auto` there** (GitHub auto-merge beats Kodiak and drops the queue) — and only repos whose landing genuinely runs on GitHub auto-merge/merge-queue get it armed. Exit — the landing verifies in a later tick (Step 3).

## Step 5 — Close the night

Reached on deadline or a drained milestone:

1. Build the digest from `claude-prove nightshift ledger` + `claude-prove scrum status`: tasks landed (with PR links), tasks parked (with reasons — list these first, they are the operator's morning queue), heal attempts, trunk-red pauses, releases cut overnight.
2. `claude-prove nightshift record morning-digest --detail "<one-line summary>"`, then `PROVE_DETAIL="<one-line summary>" claude-prove notify dispatch morning-digest --night`.
3. `claude-prove nightshift disable --reason "deadline"` (or `"milestone drained"`).
4. Delete the tick cron: read `.prove/nightshift/cron.json`, CronDelete that id, remove the file. Kill caffeinate via `.prove/nightshift/caffeinate.pid` if present.
5. Exit. The lease died with the night.

## Rules

- One unit of work per tick, then exit — even when more work is obviously waiting. The cadence is the throttle and the crash-recovery boundary.
- Record through `claude-prove nightshift record` **before** announcing through `notify dispatch --night`; the ledger is the audit trail, Slack is the mirror.
- Branch on the engine's floor verdicts; never recompute caps, deadlines, or halt state yourself.

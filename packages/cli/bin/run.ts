#!/usr/bin/env bun
// Embed the review-ui web bundle into the compiled binary. `bun build --compile`
// traces this side-effect `type: "file"` import and bakes `web-dist.tar` into the
// executable's virtual filesystem, where it surfaces at runtime via
// `Bun.embeddedFiles`. The review-ui server (compiled into the same binary by the
// daemon entry) reads it from there and materializes it to a cache dir on first
// boot — see packages/review-ui/server/src/embedded-assets.ts. The committed
// `web-dist.tar` is a stub the web build overwrites with the real bundle before
// the compile step; under `bun run`/`tsx` from source the import is inert
// (`Bun.embeddedFiles` is empty), so nothing reads it.
import './web-dist.tar' with { type: 'file' };
import { cac } from 'cac';
import pjson from '../package.json' with { type: 'json' };
import { interceptActionHelp } from '../src/core/cli/help-interceptor';
import { bindCli } from '../src/core/cli/usage';
import { register as registerAcb } from '../src/topics/acb';
import { register as registerCafi } from '../src/topics/cafi';
import { register as registerClaudeMd } from '../src/topics/claude-md';
import { register as registerCommit } from '../src/topics/commit';
import { register as registerHandoff } from '../src/topics/handoff';
import { register as registerHook } from '../src/topics/hook';
import { register as registerInstall } from '../src/topics/install';
import { register as registerIntake } from '../src/topics/intake';
import { register as registerNotify } from '../src/topics/notify';
import { register as registerOrchestrator } from '../src/topics/orchestrator';
import { register as registerPcd } from '../src/topics/pcd';
import { register as registerPrompting } from '../src/topics/prompting';
import { register as registerReport } from '../src/topics/report';
import { register as registerReviewUi } from '../src/topics/review-ui';
import { register as registerRunState } from '../src/topics/run-state';
import { register as registerSchema } from '../src/topics/schema';
import { register as registerScrum } from '../src/topics/scrum';
import { register as registerStore } from '../src/topics/store';
import { register as registerWorktree } from '../src/topics/worktree';

const cli = cac('claude-prove');

// Register topics in the canonical port order so `claude-prove --help` lists
// them in a stable sequence that mirrors the phase plan in
// .prove/decisions/2026-04-21-typescript-cli-unification.md. Every topic
// exports register(cli); stubs wrap registerStubTopic, real topics
// (starting with store in phase 2) register their own subcommand tree.
registerStore(cli);
registerSchema(cli);
registerCafi(cli);
registerRunState(cli);
registerPcd(cli);
registerAcb(cli);
registerPrompting(cli);
registerInstall(cli);
registerReport(cli);
registerReviewUi(cli);
registerIntake(cli);
registerScrum(cli);
registerCommit(cli);
registerClaudeMd(cli);
registerOrchestrator(cli);
registerNotify(cli);
registerHook(cli);
registerWorktree(cli);
registerHandoff(cli);

cli.help();
cli.version(pjson.version);

// Bind the action registry's usage helpers to this cac instance so
// per-action dispatchers can raise full-usage errors and the help
// interceptor can render action-scoped help.
bindCli(cli);

// Intercept `<topic> <action> [<subaction>] ... --help` before cac parses:
// cac's stock help only knows the topic command, so it would print the flat
// all-flags dump. The interceptor prints the action-scoped usage line + only
// that action's flags for registered actions; everything else falls through
// to cac unchanged.
if (interceptActionHelp(process.argv.slice(2))) {
  process.exit(0);
}

// Parse with run: false so we can await async action handlers (install
// upgrade needs to fetch the release binary). Sync handlers still work
// unchanged — `runMatchedCommand()` just returns undefined for them.
cli.parse(process.argv, { run: false });
await cli.runMatchedCommand();

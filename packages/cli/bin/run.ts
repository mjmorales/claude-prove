#!/usr/bin/env bun
import { cac } from 'cac';
import pjson from '../package.json' with { type: 'json' };
import { register as registerAcb } from '../src/topics/acb';
import { register as registerCafi } from '../src/topics/cafi';
import { register as registerHook } from '../src/topics/hook';
import { register as registerInstall } from '../src/topics/install';
import { register as registerPcd } from '../src/topics/pcd';
import { register as registerPrompting } from '../src/topics/prompting';
import { register as registerReviewUi } from '../src/topics/review-ui';
import { register as registerRunState } from '../src/topics/run-state';
import { register as registerSchema } from '../src/topics/schema';
import { register as registerScrum } from '../src/topics/scrum';
import { register as registerStore } from '../src/topics/store';

const cli = cac('prove');

// Register topics in the canonical port order so `prove --help` lists them
// in a stable sequence that mirrors the phase plan in
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
registerReviewUi(cli);
registerScrum(cli);
registerHook(cli);

cli.help();
cli.version(pjson.version);

// Parse with run: false so we can await async action handlers (install
// upgrade needs to fetch the release binary). Sync handlers still work
// unchanged — `runMatchedCommand()` just returns undefined for them.
cli.parse(process.argv, { run: false });
await cli.runMatchedCommand();

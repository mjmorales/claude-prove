#!/usr/bin/env bun
import { cac } from 'cac';
import pjson from '../package.json' with { type: 'json' };
import { registerStubTopic } from '../src/stub-topic';
import { topic as acb } from '../src/topics/acb';
import { topic as cafi } from '../src/topics/cafi';
import { topic as hook } from '../src/topics/hook';
import { topic as install } from '../src/topics/install';
import { topic as pcd } from '../src/topics/pcd';
import { topic as roundTable } from '../src/topics/round-table';
import { topic as runState } from '../src/topics/run-state';
import { topic as schema } from '../src/topics/schema';
import { topic as scrum } from '../src/topics/scrum';
import { topic as store } from '../src/topics/store';

const cli = cac('prove');

// Register topics in the canonical port order so `prove --help` lists them
// in a stable sequence that mirrors the phase plan in
// .prove/decisions/2026-04-21-typescript-cli-unification.md.
for (const topic of [store, schema, cafi, runState, pcd, roundTable, acb, install, scrum, hook]) {
  registerStubTopic(cli, topic);
}

cli.help();
cli.version(pjson.version);
cli.parse();

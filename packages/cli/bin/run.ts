#!/usr/bin/env bun
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '@oclif/core';
import pjson from '../package.json' with { type: 'json' };
// Side-effect imports embed each command module in the compiled binary.
// Without these, `bun build --compile` skips the dynamic imports oclif
// performs at runtime.
import '../src/commands/acb/index';
import '../src/commands/cafi/index';
import '../src/commands/hook/index';
import '../src/commands/install/index';
import '../src/commands/pcd/index';
import '../src/commands/round-table/index';
import '../src/commands/run-state/index';
import '../src/commands/schema/index';
import '../src/commands/scrum/index';
import '../src/commands/store/index';

// Root differs between dev and compiled binaries:
//   dev: parent directory of bin/ (the package root)
//   bun compile: a virtual FS path like /$bunfs/root
// Passing pjson explicitly short-circuits oclif's upward filesystem walk
// for package.json, which fails inside the virtual FS.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

await execute({
  dir: import.meta.url,
  loadOptions: {
    root,
    pjson: pjson as never,
  },
});

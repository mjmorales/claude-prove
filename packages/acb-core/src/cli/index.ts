#!/usr/bin/env node

import { runValidate } from "./validate.js";
import { runGenerate } from "./generate.js";
import { runAssemble } from "./assemble.js";
import { runInstall, runUninstall } from "./install.js";

const USAGE = `acb-review - Agent Change Brief CLI

Usage:
  acb-review install [--link] [--force]
  acb-review uninstall
  acb-review validate <file> [--json] [--acb <path>]
  acb-review generate --base <ref> --head <ref> [--output <path>]
  acb-review assemble [--base <ref>] [--head <ref>] [--manifests <dir>] [--output <path>] [--task <file>]
  acb-review --help

Commands:
  install    Install ACB git hooks (pre-commit + post-commit)
  uninstall  Remove ACB git hooks
  validate   Validate an .acb.json or .acb-review.json file
  generate   Generate a skeleton .acb.json from a git diff
  assemble   Merge per-commit intent manifests into a single .acb.json

Options:
  --help     Show this help message

Install options:
  --link     Use core.hooksPath instead of copying hooks (stays in sync with package updates)
  --force    Overwrite existing hooks

Validate options:
  --json     Output results as JSON
  --acb      Path to the ACB document (for review validation)

Generate options:
  --base     Base git ref for the diff
  --head     Head git ref for the diff
  --output   Output file path (default: stdout)

Assemble options:
  --base       Base git ref (default: main)
  --head       Head git ref (default: HEAD)
  --manifests  Directory containing .json manifest files (default: .acb/intents)
  --output     Output file path (default: stdout)
  --task       Path to task description file (PRD, plan, etc.)
`;

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  let exitCode: number;

  switch (command) {
    case "validate":
      exitCode = runValidate(commandArgs);
      break;
    case "generate":
      exitCode = runGenerate(commandArgs);
      break;
    case "assemble":
      exitCode = runAssemble(commandArgs);
      break;
    case "install":
      exitCode = runInstall(commandArgs);
      break;
    case "uninstall":
      exitCode = runUninstall(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      exitCode = 2;
  }

  process.exit(exitCode);
}

main();

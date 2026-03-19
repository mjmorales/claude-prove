#!/usr/bin/env node

import { runValidate } from "./validate.js";
import { runGenerate } from "./generate.js";

const USAGE = `acb - Agent Change Brief CLI

Usage:
  acb validate <file> [--json] [--acb <path>]
  acb generate --base <ref> --head <ref> [--output <path>]
  acb --help

Commands:
  validate   Validate an .acb.json or .acb-review.json file
  generate   Generate a skeleton .acb.json from a git diff

Options:
  --help     Show this help message

Validate options:
  --json     Output results as JSON
  --acb      Path to the ACB document (for review validation)

Generate options:
  --base     Base git ref for the diff
  --head     Head git ref for the diff
  --output   Output file path (default: stdout)
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
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      exitCode = 2;
  }

  process.exit(exitCode);
}

main();

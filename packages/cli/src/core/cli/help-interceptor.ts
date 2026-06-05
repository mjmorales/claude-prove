/**
 * Pre-parse `--help` interceptor for action-scoped help.
 *
 * cac mounts each topic as a single command (`scrum <action> ...`), so its
 * built-in `--help` can only ever print the topic's full flag dump — it has no
 * notion of the sub-action the operator typed. This interceptor runs BEFORE
 * `cli.parse`: when the argv is `<topic> <action> [<subaction>] ... (--help|-h)`
 * and that action is registered, it prints the action-scoped usage line plus
 * only that action's flags and returns true (the caller exits without parsing).
 * For every other shape it returns false and cac handles help as before.
 */

import { renderActionHelp } from './usage';

/** Long and short help flags cac recognizes. */
const HELP_FLAGS = new Set(['--help', '-h']);

/** True when a token is an option (starts with `-`) rather than a positional. */
function isFlag(token: string): boolean {
  return token.startsWith('-');
}

/**
 * Inspect the user-supplied argv (already sliced past the runtime + script
 * path). When it is an action-scoped help request for a registered action,
 * print the scoped help and return true. Otherwise return false.
 */
export function interceptActionHelp(userArgs: string[]): boolean {
  if (!userArgs.some((arg) => HELP_FLAGS.has(arg))) return false;

  // Collect the leading positionals up to the first flag: [topic, action, sub?].
  const positionals: string[] = [];
  for (const arg of userArgs) {
    if (isFlag(arg)) break;
    positionals.push(arg);
  }

  const [topic, action, maybeSub] = positionals;
  // A bare `scrum --help` (no action) keeps cac's topic-level help.
  if (!topic || !action) return false;

  const help = renderActionHelp(topic, action, maybeSub);
  if (help === undefined) return false;

  console.log(help);
  return true;
}

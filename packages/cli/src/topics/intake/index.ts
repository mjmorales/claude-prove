/**
 * Register the `intake` topic — the intake/v1 interactive HTML form surface.
 *
 *   claude-prove intake render   --form <name> | --file <spec.json> [--out <path>]
 *   claude-prove intake validate --form <name> | --file <spec.json> --payload <p.json>
 *   claude-prove intake spec     --form <name> | --file <spec.json> [--out <path>]
 *   claude-prove intake list
 *
 * An intake form (see `forms.ts`) is a closed model of typed fields; the
 * vendored renderer (`render-form.ts`) maps it to a self-contained interactive
 * HTML page that copies the operator's answers back as an `IntakePayload`.
 * `render` emits the HTML; `validate` checks a pasted-back payload against the
 * form (`validate-payload.ts`); `spec` emits the resolved form JSON; `list`
 * names the built-in forms (`builtins.ts`). The form and the conversational
 * interview are two front-ends to one writer — the intake skill drives the
 * writer from a validated payload.
 *
 * Form resolution: `--form <name>` loads a built-in; `--file <path>` reads a
 * custom spec JSON. Either way the spec is validated before use.
 *
 * Stdout: rendered HTML / spec JSON / form names. Stderr: a one-line human
 * summary, or validation errors one per line. Exit: 0 success/PASS, 1 usage /
 * invalid spec / invalid payload / IO error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { CAC } from 'cac';
import { BUILTIN_FORM_NAMES, getBuiltinForm } from './builtins';
import { type IntakeForm, validateFormSpec } from './forms';
import { renderIntakeForm } from './render-form';
import { validatePayload } from './validate-payload';

type IntakeAction = 'render' | 'validate' | 'spec' | 'list';

const INTAKE_ACTIONS: IntakeAction[] = ['render', 'validate', 'spec', 'list'];

interface IntakeFlags {
  form?: string;
  file?: string;
  payload?: string;
  out?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'intake <action>',
      `intake/v1 HTML form surface (action: ${INTAKE_ACTIONS.join(' | ')})`,
    )
    .option('--form <name>', `built-in form (${BUILTIN_FORM_NAMES.join(' | ')})`)
    .option('--file <path>', 'path to a custom intake/v1 form spec JSON')
    .option('--payload <path>', 'validate: path to the pasted-back payload JSON')
    .option('--out <path>', 'render/spec: write output here instead of stdout')
    .action((action: string, flags: IntakeFlags) => {
      if (!isIntakeAction(action)) {
        process.stderr.write(
          `claude-prove intake: unknown action '${action}'. expected one of: ${INTAKE_ACTIONS.join(', ')}\n`,
        );
        process.exit(1);
      }
      process.exit(dispatch(action, flags));
    });
}

function isIntakeAction(value: string): value is IntakeAction {
  return (INTAKE_ACTIONS as string[]).includes(value);
}

function dispatch(action: IntakeAction, flags: IntakeFlags): number {
  if (action === 'list') {
    process.stdout.write(`${BUILTIN_FORM_NAMES.join('\n')}\n`);
    return 0;
  }

  const resolved = resolveForm(flags);
  if (resolved.error !== null) {
    process.stderr.write(`claude-prove intake ${action}: ${resolved.error}\n`);
    return 1;
  }
  const form = resolved.form;

  switch (action) {
    case 'render':
      return emit(renderIntakeForm(form), action, flags);
    case 'spec':
      return emit(`${JSON.stringify(form, null, 2)}\n`, action, flags);
    case 'validate':
      return dispatchValidate(form, flags);
  }
}

/** Resolve the form spec from `--form` (built-in) or `--file` (custom), validated. */
function resolveForm(
  flags: IntakeFlags,
): { form: IntakeForm; error: null } | { form: null; error: string } {
  const hasForm = flags.form !== undefined && flags.form.length > 0;
  const hasFile = flags.file !== undefined && flags.file.length > 0;
  if (hasForm === hasFile) {
    return { form: null, error: 'exactly one of --form <name> or --file <path> is required' };
  }

  let value: unknown;
  if (hasForm) {
    const builtin = getBuiltinForm(flags.form as string);
    if (builtin === null) {
      return {
        form: null,
        error: `unknown form '${flags.form}'. available: ${BUILTIN_FORM_NAMES.join(', ')}`,
      };
    }
    value = builtin;
  } else {
    const parsed = readJson(flags.file as string);
    if (parsed.error !== null) return { form: null, error: parsed.error };
    value = parsed.value;
  }

  const errors = validateFormSpec(value);
  if (errors.length > 0) {
    return {
      form: null,
      error: `invalid intake/v1 form spec (${errors.length}):\n  - ${errors.join('\n  - ')}`,
    };
  }
  return { form: value as IntakeForm, error: null };
}

/** `validate`: check a pasted-back payload against the resolved form. */
function dispatchValidate(form: IntakeForm, flags: IntakeFlags): number {
  if (flags.payload === undefined || flags.payload.length === 0) {
    process.stderr.write('claude-prove intake validate: --payload <path> is required\n');
    return 1;
  }
  const parsed = readJson(flags.payload);
  if (parsed.error !== null) {
    process.stderr.write(`claude-prove intake validate: ${parsed.error}\n`);
    return 1;
  }
  const errors = validatePayload(form, parsed.value);
  if (errors.length > 0) {
    process.stderr.write(
      `claude-prove intake validate: FAIL — payload does not satisfy form "${form.form}" (${errors.length}):\n`,
    );
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }
  process.stderr.write(
    `claude-prove intake validate: PASS — payload satisfies form "${form.form}"\n`,
  );
  return 0;
}

/** Write output to `--out` (file) or stdout, with a stderr summary on `--out`. */
function emit(text: string, action: IntakeAction, flags: IntakeFlags): number {
  if (flags.out !== undefined && flags.out.length > 0) {
    try {
      writeFileSync(flags.out, text);
    } catch (err) {
      process.stderr.write(
        `claude-prove intake ${action}: cannot write ${flags.out}: ${errMsg(err)}\n`,
      );
      return 1;
    }
    const src = flags.form ?? flags.file ?? '(form)';
    process.stderr.write(`claude-prove intake ${action}: ${src} -> ${flags.out}\n`);
    return 0;
  }
  process.stdout.write(text);
  return 0;
}

function readJson(file: string): { value: unknown; error: null } | { value: null; error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { value: null, error: `cannot read ${file}: ${errMsg(err)}` };
  }
  try {
    return { value: JSON.parse(raw), error: null };
  } catch (err) {
    return { value: null, error: `invalid JSON in ${file}: ${errMsg(err)}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Closed boolean expression grammar + in-process evaluator for `assert`-kind
 * acceptance criteria.
 *
 * An `assert` criterion's `check` payload is a boolean expression evaluated
 * against a run/plan context — entirely in-process, with NO worktree and NO
 * shell. This is the half of acceptance verification the engine owns: a fixed
 * grammar walked over a fixed context shape, never an open `eval`.
 *
 * # Why a closed grammar (no eval/Function)
 *
 * The operator and accessor vocabularies are a CLOSED set: extending either is
 * a deliberate code change to the constants below, not an open-ended runtime
 * input. The expression is lexed, parsed to an AST, then walked. Nothing is
 * ever passed to `eval`/`new Function`, so a criterion author cannot smuggle
 * arbitrary code into a verification gate, and the model + engine share one
 * fixed vocabulary that cannot drift.
 *
 * # Grammar (EBNF)
 *
 *   expr        = or_expr
 *   or_expr     = and_expr { "or" and_expr }
 *   and_expr    = not_expr { "and" not_expr }
 *   not_expr    = "not" not_expr | primary
 *   primary     = "(" expr ")" | comparison | accessor | literal
 *   comparison  = operand cmp_op operand
 *   cmp_op      = "==" | "!=" | "<" | "<=" | ">" | ">="
 *   operand     = accessor | literal
 *   accessor    = dotted identifier drawn from CONTEXT_ACCESSORS
 *   literal     = string ('...' | "...") | number | "true" | "false"
 *
 * Precedence (lowest → highest): `or` < `and` < `not` < comparison/primary.
 * A bare accessor or literal in boolean position is coerced to a boolean
 * (truthiness rules below), so `task.review == "approved"` and a future
 * boolean-typed accessor both compose under `and`/`or`/`not`.
 *
 * # Context accessors (the closed operand set)
 *
 * Every accessor resolves a field of `AssertContext`, a flattened view derived
 * from run-state. The set is fixed:
 *
 *   run.status         — overall run lifecycle status
 *   task.status        — the focused task's lifecycle status
 *   task.review        — the focused task's principal-architect review verdict
 *   step.status        — the focused step's lifecycle status
 *   validator.build    — build-phase validator outcome
 *   validator.lint     — lint-phase validator outcome
 *   validator.test     — test-phase validator outcome
 *   validator.custom   — custom-phase validator outcome
 *   validator.llm      — llm-phase validator outcome
 *
 * An accessor whose context value is absent resolves to the empty string, so
 * `validator.test == "pass"` is simply false when no test ran — it never throws.
 *
 * # Truthiness (bare operand in boolean position)
 *
 *   string  — non-empty is true; "" is false
 *   number  — non-zero is true; 0 is false
 *   boolean — itself
 *
 * # Comparison value coercion
 *
 *   <, <=, >, >=  — both operands coerced to number; a non-numeric operand
 *                   makes the comparison a typed error (it is almost always an
 *                   authoring mistake, not a legitimately-false fact).
 *   ==, !=        — compared as-is after string/number/boolean normalization.
 *
 * # Errors
 *
 * Any lex/parse/resolve failure — an unknown accessor, an unknown operator, an
 * unterminated string, a numeric comparison on a non-numeric operand, a
 * dangling token — throws `AssertGrammarError` (a typed error). Evaluation
 * NEVER silently passes a malformed expression.
 *
 * # Result
 *
 * `evaluateAssert(expr, context)` returns `{ ok, reason }`. On a satisfied
 * expression `ok` is true. On an unsatisfied one `ok` is false and `reason`
 * names the offending sub-expression — the smallest `and`/comparison branch
 * whose falsity makes the whole expression false — so a failing gate points at
 * what to fix rather than just "false".
 */

import type { StateData } from '../run-state/state';
import type { AcceptanceCriterion } from './types';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown on any invalid or unknown expression: a lex failure, a parse failure,
 * an unknown accessor, an unknown operator, or a numeric comparison against a
 * non-numeric operand. A malformed assert criterion fails loudly here rather
 * than evaluating to a silent pass.
 */
export class AssertGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertGrammarError';
  }
}

// ---------------------------------------------------------------------------
// Closed accessor vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed set of context accessors. Extending verification to a new
 * run/plan field is a deliberate edit here plus a matching branch in
 * `resolveAccessor` — never an open-ended runtime lookup.
 */
export const CONTEXT_ACCESSORS = [
  'run.status',
  'task.status',
  'task.review',
  'step.status',
  'validator.build',
  'validator.lint',
  'validator.test',
  'validator.custom',
  'validator.llm',
] as const;

export type ContextAccessor = (typeof CONTEXT_ACCESSORS)[number];

const ACCESSOR_SET: ReadonlySet<string> = new Set(CONTEXT_ACCESSORS);

// ---------------------------------------------------------------------------
// Context object
// ---------------------------------------------------------------------------

/**
 * Flattened run/plan view an assert expression evaluates against. Built by
 * `buildAssertContext` from run-state `StateData` plus the focused task/step
 * ids. Every field is a plain string mirroring the corresponding run-state
 * status/verdict enum; an absent field is the empty string (never undefined),
 * so an accessor on missing context resolves to "" rather than throwing.
 */
export interface AssertContext {
  run: { status: string };
  task: { status: string; review: string };
  step: { status: string };
  validator: {
    build: string;
    lint: string;
    test: string;
    custom: string;
    llm: string;
  };
}

/**
 * Project run-state `StateData` into the flat `AssertContext` an expression
 * reads. `taskId`/`stepId` focus the context on one task and step; when either
 * is absent or unmatched the corresponding fields stay empty strings.
 */
export function buildAssertContext(
  state: StateData,
  taskId?: string,
  stepId?: string,
): AssertContext {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;
  const step = task && stepId ? task.steps.find((s) => s.id === stepId) : undefined;
  const validator = step?.validator_summary;
  return {
    run: { status: state.run_status },
    task: { status: task?.status ?? '', review: task?.review.verdict ?? '' },
    step: { status: step?.status ?? '' },
    validator: {
      build: validator?.build ?? '',
      lint: validator?.lint ?? '',
      test: validator?.test ?? '',
      custom: validator?.custom ?? '',
      llm: validator?.llm ?? '',
    },
  };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Closed comparison-operator vocabulary. Order matters: longest match first. */
export const COMPARISON_OPERATORS = ['==', '!=', '<=', '>=', '<', '>'] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/** Closed boolean-keyword vocabulary. */
export const BOOLEAN_KEYWORDS = ['and', 'or', 'not'] as const;

type TokenKind =
  | 'accessor'
  | 'string'
  | 'number'
  | 'boolean'
  | 'cmp'
  | 'and'
  | 'or'
  | 'not'
  | 'lparen'
  | 'rparen';

interface Token {
  kind: TokenKind;
  /** Raw source text of the token (used in offending-sub-expression rendering). */
  text: string;
  /** Decoded value for literal tokens; the dotted name for accessors. */
  value: string | number | boolean;
}

const COMPARISON_SET: ReadonlySet<string> = new Set(COMPARISON_OPERATORS);

/**
 * Lex `expr` into the closed token vocabulary. Throws `AssertGrammarError` on
 * an unterminated string or any character that is not part of the grammar.
 */
function lex(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    // The loop guard guarantees this index is in range.
    const ch = expr[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: '(', value: '(' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ')', value: ')' });
      i += 1;
      continue;
    }
    const twoChar = expr.slice(i, i + 2);
    if (COMPARISON_SET.has(twoChar)) {
      tokens.push({ kind: 'cmp', text: twoChar, value: twoChar });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>') {
      tokens.push({ kind: 'cmp', text: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '=' || ch === '!') {
      throw new AssertGrammarError(
        `lex: stray '${ch}' at position ${i} — did you mean '==' or '!='? (expr: ${expr})`,
      );
    }
    if (ch === "'" || ch === '"') {
      const { token, next } = lexString(expr, i, ch);
      tokens.push(token);
      i = next;
      continue;
    }
    if (isWordStart(ch)) {
      const { token, next } = lexWord(expr, i);
      tokens.push(token);
      i = next;
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(expr[i + 1] ?? ''))) {
      const { token, next } = lexNumber(expr, i);
      tokens.push(token);
      i = next;
      continue;
    }
    throw new AssertGrammarError(
      `lex: unexpected character '${ch}' at position ${i} (expr: ${expr})`,
    );
  }
  return tokens;
}

function lexString(expr: string, start: number, quote: string): { token: Token; next: number } {
  let j = start + 1;
  let out = '';
  while (j < expr.length && expr[j] !== quote) {
    if (expr[j] === '\\' && j + 1 < expr.length) {
      out += expr[j + 1];
      j += 2;
      continue;
    }
    out += expr[j];
    j += 1;
  }
  if (j >= expr.length) {
    throw new AssertGrammarError(
      `lex: unterminated string literal starting at position ${start} (expr: ${expr})`,
    );
  }
  return {
    token: { kind: 'string', text: expr.slice(start, j + 1), value: out },
    next: j + 1,
  };
}

function lexNumber(expr: string, start: number): { token: Token; next: number } {
  let j = start;
  if (expr[j] === '-') j += 1;
  while (j < expr.length && (isDigit(expr[j] ?? '') || expr[j] === '.')) j += 1;
  const text = expr.slice(start, j);
  const value = Number(text);
  if (Number.isNaN(value)) {
    throw new AssertGrammarError(`lex: malformed number '${text}' at position ${start}`);
  }
  return { token: { kind: 'number', text, value }, next: j };
}

function lexWord(expr: string, start: number): { token: Token; next: number } {
  let j = start;
  while (j < expr.length && isWordPart(expr[j] ?? '')) j += 1;
  const text = expr.slice(start, j);
  if (text === 'and') return { token: { kind: 'and', text, value: text }, next: j };
  if (text === 'or') return { token: { kind: 'or', text, value: text }, next: j };
  if (text === 'not') return { token: { kind: 'not', text, value: text }, next: j };
  if (text === 'true') return { token: { kind: 'boolean', text, value: true }, next: j };
  if (text === 'false') return { token: { kind: 'boolean', text, value: false }, next: j };
  if (!ACCESSOR_SET.has(text)) {
    throw new AssertGrammarError(
      `lex: unknown accessor '${text}' — allowed accessors: ${CONTEXT_ACCESSORS.join(', ')}`,
    );
  }
  return { token: { kind: 'accessor', text, value: text }, next: j };
}

function isWordStart(ch: string): boolean {
  return /[a-zA-Z_]/.test(ch);
}

function isWordPart(ch: string): boolean {
  return /[a-zA-Z0-9_.]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type AstNode =
  | { type: 'and'; left: AstNode; right: AstNode }
  | { type: 'or'; left: AstNode; right: AstNode }
  | { type: 'not'; operand: AstNode }
  | { type: 'comparison'; op: ComparisonOperator; left: OperandNode; right: OperandNode }
  | OperandNode;

type OperandNode =
  | { type: 'accessor'; name: ContextAccessor }
  | { type: 'literal'; value: string | number | boolean };

// ---------------------------------------------------------------------------
// Parser — recursive descent over the closed grammar
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const node = this.parseOr();
    if (this.pos !== this.tokens.length) {
      const stray = this.tokens[this.pos];
      throw new AssertGrammarError(`parse: unexpected trailing token '${stray?.text ?? ''}'`);
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.advance();
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.peek()?.kind === 'and') {
      this.advance();
      const right = this.parseNot();
      left = { type: 'and', left, right };
    }
    return left;
  }

  private parseNot(): AstNode {
    if (this.peek()?.kind === 'not') {
      this.advance();
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();
    if (!tok) throw new AssertGrammarError('parse: unexpected end of expression');
    if (tok.kind === 'lparen') {
      this.advance();
      const inner = this.parseOr();
      const close = this.peek();
      if (close?.kind !== 'rparen') {
        throw new AssertGrammarError("parse: missing closing ')'");
      }
      this.advance();
      return inner;
    }
    // A comparison or a bare operand. Parse the left operand, then look for a
    // comparison operator; absent one, the operand stands alone (boolean coercion).
    const left = this.parseOperand();
    if (this.peek()?.kind === 'cmp') {
      const opTok = this.advance();
      const right = this.parseOperand();
      return { type: 'comparison', op: opTok.value as ComparisonOperator, left, right };
    }
    return left;
  }

  private parseOperand(): OperandNode {
    const tok = this.peek();
    if (!tok)
      throw new AssertGrammarError('parse: expected an operand but reached end of expression');
    if (tok.kind === 'accessor') {
      this.advance();
      return { type: 'accessor', name: tok.value as ContextAccessor };
    }
    if (tok.kind === 'string' || tok.kind === 'number' || tok.kind === 'boolean') {
      this.advance();
      return { type: 'literal', value: tok.value };
    }
    throw new AssertGrammarError(`parse: expected an operand, found '${tok.text}'`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    // Every call site first confirms a token via `peek()`, so the index is in range.
    return this.tokens[this.pos++] as Token;
  }
}

/**
 * Parse an assert expression string into an AST. Throws `AssertGrammarError`
 * on any lex or parse failure (including an empty expression). Exposed so a
 * caller can validate an expression at authoring time, independent of any
 * context.
 */
export function parseAssert(expr: string): AstNode {
  const tokens = lex(expr);
  if (tokens.length === 0) {
    throw new AssertGrammarError('parse: empty expression');
  }
  return new Parser(tokens).parse();
}

// ---------------------------------------------------------------------------
// Evaluator — walk the AST
// ---------------------------------------------------------------------------

export interface AssertResult {
  ok: boolean;
  /**
   * On failure, the rendered offending sub-expression — the smallest branch
   * whose falsity makes the whole expression false. Empty string on success.
   */
  reason: string;
}

/**
 * Parse and evaluate an assert expression against a context. A satisfied
 * expression returns `{ ok: true, reason: '' }`; an unsatisfied one returns
 * `{ ok: false, reason }` naming the offending sub-expression. Throws
 * `AssertGrammarError` on an invalid/unknown expression — never a silent pass.
 */
export function evaluateAssert(expr: string, context: AssertContext): AssertResult {
  const ast = parseAssert(expr);
  const ok = evalNode(ast, context);
  if (ok) return { ok: true, reason: '' };
  return { ok: false, reason: offendingSubExpression(ast, context) };
}

function evalNode(node: AstNode, ctx: AssertContext): boolean {
  switch (node.type) {
    case 'and':
      return evalNode(node.left, ctx) && evalNode(node.right, ctx);
    case 'or':
      return evalNode(node.left, ctx) || evalNode(node.right, ctx);
    case 'not':
      return !evalNode(node.operand, ctx);
    case 'comparison':
      return evalComparison(node, ctx);
    case 'accessor':
    case 'literal':
      return truthy(operandValue(node, ctx));
  }
}

function evalComparison(
  node: { op: ComparisonOperator; left: OperandNode; right: OperandNode },
  ctx: AssertContext,
): boolean {
  const left = operandValue(node.left, ctx);
  const right = operandValue(node.right, ctx);
  // == / != compare by value (string-normalized); the ordering operators
  // coerce both operands to numbers via a single numericPair call per arm so
  // the throw path for a non-numeric operand is evaluated once, not twice.
  switch (node.op) {
    case '==':
      return equalsValue(left, right);
    case '!=':
      return !equalsValue(left, right);
    case '<': {
      const [a, b] = numericPair(left, right, node.op);
      return a < b;
    }
    case '<=': {
      const [a, b] = numericPair(left, right, node.op);
      return a <= b;
    }
    case '>': {
      const [a, b] = numericPair(left, right, node.op);
      return a > b;
    }
    case '>=': {
      const [a, b] = numericPair(left, right, node.op);
      return a >= b;
    }
  }
}

/**
 * Coerce both operands of an ordering comparison to numbers. A non-numeric
 * operand is a typed error: ordering a status string by `<` is an authoring
 * mistake, not a legitimately-false fact.
 */
function numericPair(
  left: string | number | boolean,
  right: string | number | boolean,
  op: ComparisonOperator,
): [number, number] {
  const ln = toNumber(left);
  const rn = toNumber(right);
  if (ln === null || rn === null) {
    const offender = ln === null ? left : right;
    throw new AssertGrammarError(
      `eval: operator '${op}' requires numeric operands; '${String(offender)}' is not numeric`,
    );
  }
  return [ln, rn];
}

function toNumber(value: string | number | boolean): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function equalsValue(left: string | number | boolean, right: string | number | boolean): boolean {
  if (typeof left === typeof right) return left === right;
  // Cross-type equality normalizes to string so `step.status == 'completed'`
  // and a numeric literal each compare by their printed form.
  return String(left) === String(right);
}

function operandValue(node: OperandNode, ctx: AssertContext): string | number | boolean {
  if (node.type === 'literal') return node.value;
  return resolveAccessor(node.name, ctx);
}

/**
 * Resolve a closed accessor to its context value. A missing field resolves to
 * the empty string rather than throwing, so a comparison against absent context
 * is simply false. An accessor outside the closed set is impossible here (the
 * lexer rejects it), but the exhaustive switch guards the invariant.
 */
function resolveAccessor(name: ContextAccessor, ctx: AssertContext): string {
  switch (name) {
    case 'run.status':
      return ctx.run.status;
    case 'task.status':
      return ctx.task.status;
    case 'task.review':
      return ctx.task.review;
    case 'step.status':
      return ctx.step.status;
    case 'validator.build':
      return ctx.validator.build;
    case 'validator.lint':
      return ctx.validator.lint;
    case 'validator.test':
      return ctx.validator.test;
    case 'validator.custom':
      return ctx.validator.custom;
    case 'validator.llm':
      return ctx.validator.llm;
    default: {
      const exhaustive: never = name;
      throw new AssertGrammarError(`eval: unknown accessor '${String(exhaustive)}'`);
    }
  }
}

function truthy(value: string | number | boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value !== '';
}

// ---------------------------------------------------------------------------
// Offending-sub-expression rendering
// ---------------------------------------------------------------------------

/**
 * Walk a falsified AST to the smallest sub-expression that makes it false, then
 * render that node back to source-like text. For an `and`, descend into the
 * false branch; for an `or`, both branches are false, so render the whole `or`;
 * for `not`/comparison/operand, the node itself is the offender.
 */
function offendingSubExpression(node: AstNode, ctx: AssertContext): string {
  switch (node.type) {
    case 'and': {
      if (!evalNode(node.left, ctx)) return offendingSubExpression(node.left, ctx);
      return offendingSubExpression(node.right, ctx);
    }
    case 'or':
      // Both sides are false (else the `or` would be true); the whole `or` is
      // the smallest falsifying unit.
      return renderNode(node);
    default:
      return renderNode(node);
  }
}

function renderNode(node: AstNode): string {
  switch (node.type) {
    case 'and':
      return `${renderNode(node.left)} and ${renderNode(node.right)}`;
    case 'or':
      return `${renderNode(node.left)} or ${renderNode(node.right)}`;
    case 'not':
      return `not ${renderNode(node.operand)}`;
    case 'comparison':
      return `${renderOperand(node.left)} ${node.op} ${renderOperand(node.right)}`;
    case 'accessor':
    case 'literal':
      return renderOperand(node);
  }
}

function renderOperand(node: OperandNode): string {
  if (node.type === 'accessor') return node.name;
  if (typeof node.value === 'string') return `'${node.value}'`;
  return String(node.value);
}

// ---------------------------------------------------------------------------
// Criterion dispatch
// ---------------------------------------------------------------------------

/**
 * Outcome of verifying one acceptance criterion. `assert` criteria are decided
 * in-process here (`ok` is authoritative). The other three kinds are NOT
 * evaluated in-process — they delegate to machinery the driver session owns —
 * so `verifyCriterion` returns `delegated: true` for them, naming the
 * downstream channel rather than guessing a pass/fail.
 *
 *   ok        — true/false for an `assert` criterion; false (unverified) for a
 *               delegated kind until its downstream channel reports.
 *   reason    — offending sub-expression on an `assert` failure, or the
 *               delegation note for a delegated kind.
 *   delegated — true when verification is handled outside this process.
 *   channel   — for a delegated kind, the downstream verifier:
 *               `'validators'` (bash) | `'gate'` (AskUserQuestion) |
 *               `'validation-agent'` (agent). Undefined for `assert`.
 */
export interface CriterionVerification {
  ok: boolean;
  reason: string;
  delegated: boolean;
  channel?: 'validators' | 'gate' | 'validation-agent';
}

/**
 * Dispatch a single acceptance criterion by its `verifies_by` kind. Only
 * `assert` is decided in-process: its `check` is parsed and evaluated against
 * `context` via `evaluateAssert`, and an invalid expression throws
 * `AssertGrammarError` (never a silent pass). The `bash`/`gate`/`agent` kinds
 * delegate to their downstream channels (validators / operator gate /
 * validation-agent) and return `delegated: true` — this function does not run a
 * shell, show a prompt, or call a model.
 */
export function verifyCriterion(
  criterion: AcceptanceCriterion,
  context: AssertContext,
): CriterionVerification {
  switch (criterion.verifies_by) {
    case 'assert': {
      const result = evaluateAssert(criterion.check, context);
      return { ok: result.ok, reason: result.reason, delegated: false };
    }
    case 'bash':
      return {
        ok: false,
        reason: 'bash criterion runs as a validator command, not in-process',
        delegated: true,
        channel: 'validators',
      };
    case 'gate':
      return {
        ok: false,
        reason: 'gate criterion is decided by an operator AskUserQuestion prompt',
        delegated: true,
        channel: 'gate',
      };
    case 'agent':
      return {
        ok: false,
        reason: 'agent criterion is judged by the validation-agent',
        delegated: true,
        channel: 'validation-agent',
      };
    default: {
      const exhaustive: never = criterion.verifies_by;
      throw new AssertGrammarError(`verifyCriterion: unknown verifies_by '${String(exhaustive)}'`);
    }
  }
}

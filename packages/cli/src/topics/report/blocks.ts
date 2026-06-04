/**
 * report/v1 — the single closed block-document model every HTML surface compiles
 * to. An author never emits markup: they build a `ReportDocument` (a closed set
 * of typed blocks) and the static renderer (`render.ts`) maps blocks → HTML. The
 * model is the contract between the producers (brief, dashboard, timeline,
 * decomposition preview, intake) and the one renderer.
 *
 * The block set is CLOSED — adding a kind is a deliberate change here, mirrored
 * in `render.ts` and `validateReportDocument`. Keeping it closed is what lets a
 * single vendored renderer cover every surface without per-surface markup.
 *
 * Inline code convention: in FLOWING text nodes (paragraph text, list items,
 * table cells, key-value values, callout bodies) a backtick-delimited span
 * renders as an inline `<code>` chip — the prose/code distinction without
 * opening the model to markup. Label voices (headings, section titles, badge
 * labels, callout titles, key-value keys) render backticks literally. Producers
 * mark code with `codeSpan` rather than hand-writing backticks. Block-level
 * code uses the `code` block kind.
 */

/** Severity/intent tone shared by badges and callouts (closed enum). */
export type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

/** Runtime-checkable list of the closed `Tone` set. */
export const TONES: Tone[] = ['neutral', 'info', 'success', 'warn', 'danger'];

/** A section/heading level (closed: 1–3). */
export type HeadingLevel = 1 | 2 | 3;

/** A row of `{ key, value }` pairs for a key-value block. */
export interface KeyValuePair {
  key: string;
  value: string;
}

/**
 * One block in a report document. `type` is the closed discriminant; every
 * variant carries only the fields its renderer reads. `section` nests blocks,
 * so a document is a shallow tree.
 */
export type Block =
  | { type: 'heading'; level: HeadingLevel; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'badge'; label: string; tone: Tone }
  | { type: 'keyValue'; items: KeyValuePair[] }
  | { type: 'callout'; tone: Tone; title?: string; body: string }
  | { type: 'code'; text: string; label?: string }
  | { type: 'section'; title?: string; blocks: Block[] }
  | { type: 'divider' };

/** The closed set of block discriminants. */
export const BLOCK_TYPES: Block['type'][] = [
  'heading',
  'paragraph',
  'list',
  'table',
  'badge',
  'keyValue',
  'callout',
  'code',
  'section',
  'divider',
];

/**
 * Mark a value as inline code for a flowing text node (see the inline code
 * convention above). Returns the value backtick-wrapped; left untouched when it
 * is empty or already contains a backtick (so shell command substitution never
 * produces a broken span).
 */
export function codeSpan(text: string): string {
  if (text === '' || text.includes('`')) return text;
  return `\`${text}\``;
}

/**
 * A report/v1 document: a titled, ordered list of blocks. `schema_version` pins
 * the model version (a block-set change bumps it). This is the only shape the
 * renderer accepts and the only shape producers emit.
 */
export interface ReportDocument {
  schema_version: '2';
  title: string;
  blocks: Block[];
}

/** Current report-document model version. Bump on a closed-set change. */
export const REPORT_SCHEMA_VERSION = '2';

/**
 * Validate a parsed value as a `ReportDocument`. Returns a list of human-readable
 * error strings (empty = valid) rather than throwing, so a CLI `validate` action
 * can report every problem at once. Walks the block tree, checking each block's
 * discriminant and required fields against the closed model.
 */
export function validateReportDocument(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['document must be a JSON object'];
  }
  const doc = value as Record<string, unknown>;
  if (doc.schema_version !== REPORT_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be "${REPORT_SCHEMA_VERSION}", got ${stringify(doc.schema_version)}`,
    );
  }
  if (typeof doc.title !== 'string') {
    errors.push(`title must be a string, got ${stringify(doc.title)}`);
  }
  if (!Array.isArray(doc.blocks)) {
    errors.push(`blocks must be an array, got ${stringify(doc.blocks)}`);
    return errors;
  }
  doc.blocks.forEach((block, i) => validateBlock(block, `blocks[${i}]`, errors));
  return errors;
}

function validateBlock(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${path}: block must be a JSON object`);
    return;
  }
  const block = value as Record<string, unknown>;
  const type = block.type;
  if (typeof type !== 'string' || !(BLOCK_TYPES as string[]).includes(type)) {
    errors.push(`${path}.type: must be one of ${BLOCK_TYPES.join(', ')}, got ${stringify(type)}`);
    return;
  }
  switch (type as Block['type']) {
    case 'heading':
      if (block.level !== 1 && block.level !== 2 && block.level !== 3) {
        errors.push(`${path}.level: must be 1, 2, or 3, got ${stringify(block.level)}`);
      }
      requireString(block.text, `${path}.text`, errors);
      break;
    case 'paragraph':
      requireString(block.text, `${path}.text`, errors);
      break;
    case 'list':
      if (typeof block.ordered !== 'boolean') {
        errors.push(`${path}.ordered: must be a boolean, got ${stringify(block.ordered)}`);
      }
      requireStringArray(block.items, `${path}.items`, errors);
      break;
    case 'table':
      requireStringArray(block.columns, `${path}.columns`, errors);
      if (!Array.isArray(block.rows)) {
        errors.push(`${path}.rows: must be an array of string rows`);
      } else {
        block.rows.forEach((row, i) => requireStringArray(row, `${path}.rows[${i}]`, errors));
      }
      break;
    case 'badge':
      requireString(block.label, `${path}.label`, errors);
      requireTone(block.tone, `${path}.tone`, errors);
      break;
    case 'keyValue':
      if (!Array.isArray(block.items)) {
        errors.push(`${path}.items: must be an array of { key, value }`);
      } else {
        block.items.forEach((pair, i) => {
          const p = pair as Record<string, unknown>;
          requireString(p?.key, `${path}.items[${i}].key`, errors);
          requireString(p?.value, `${path}.items[${i}].value`, errors);
        });
      }
      break;
    case 'callout':
      requireTone(block.tone, `${path}.tone`, errors);
      requireString(block.body, `${path}.body`, errors);
      if (block.title !== undefined) requireString(block.title, `${path}.title`, errors);
      break;
    case 'code':
      requireString(block.text, `${path}.text`, errors);
      if (block.label !== undefined) requireString(block.label, `${path}.label`, errors);
      break;
    case 'section':
      if (block.title !== undefined) requireString(block.title, `${path}.title`, errors);
      if (!Array.isArray(block.blocks)) {
        errors.push(`${path}.blocks: must be an array`);
      } else {
        block.blocks.forEach((child, i) => validateBlock(child, `${path}.blocks[${i}]`, errors));
      }
      break;
    case 'divider':
      break;
  }
}

function requireString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'string') errors.push(`${path}: must be a string, got ${stringify(value)}`);
}

function requireStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    errors.push(`${path}: must be an array of strings`);
  }
}

function requireTone(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'string' || !(TONES as string[]).includes(value)) {
    errors.push(`${path}: must be one of ${TONES.join(', ')}, got ${stringify(value)}`);
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

/**
 * Regex-based heuristic tokenizer ported from `scripts/token-count.py::_TOKEN_RE`.
 *
 * Approximates BPE tokenization by splitting on:
 *   - word boundaries, punctuation, whitespace runs
 *   - camelCase / PascalCase boundaries
 *   - common programming tokens (::, ->, $$, etc.)
 *
 * The regex must match the Python source alternative-by-alternative so token
 * counts stay byte-equal across the port. Python uses `re.VERBOSE` with a
 * multiline comment form; JavaScript has no VERBOSE flag, so the alternatives
 * are concatenated inline below.
 *
 * Python alternatives, in order:
 *   1. [A-Z]?[a-z]+        -- words (including camelCase splits)
 *   2. [A-Z]+(?=[A-Z][a-z]) -- ALLCAPS before CamelCase transition
 *   3. [A-Z]+              -- remaining ALLCAPS
 *   4. \d+\.?\d*           -- numbers (int or float)
 *   5. ---?|\.{2,3}        -- markdown dashes, ellipsis
 *   6. ->|=>|::|\*\*|```   -- common multi-char tokens
 *   7. [^\s\w]             -- single punctuation / symbol
 *
 * Calibrated against Claude's tokenizer: typically within 10-15% for English
 * prose with markdown/code. Tends to slightly overcount.
 */

const TOKEN_PATTERN = [
  '[A-Z]?[a-z]+',
  '[A-Z]+(?=[A-Z][a-z])',
  '[A-Z]+',
  '\\d+\\.?\\d*',
  '---?|\\.{2,3}',
  '->|=>|::|\\*\\*|```',
  '[^\\s\\w]',
].join('|');

// Global flag — each findall iteration advances lastIndex. Mirrors
// Python's re.findall which walks the whole string non-overlappingly.
const TOKEN_RE = new RegExp(TOKEN_PATTERN, 'g');

/** Count tokens in `text` using the ported heuristic. */
export function countTokens(text: string): number {
  // Reset global-state safety: use matchAll so we don't share lastIndex
  // state across calls with the same `TOKEN_RE` instance.
  const matches = text.matchAll(TOKEN_RE);
  let n = 0;
  for (const _ of matches) n += 1;
  return n;
}

/**
 * Strip a leading YAML frontmatter block (`^---\n...\n---\n?`) if present.
 *
 * Mirrors Python's `re.sub(r"\A---\n.*?\n---\n?", "", text, count=1, flags=re.DOTALL)`.
 * Only the first block is removed; no-op when the file doesn't start with `---\n`.
 */
export function stripFrontmatter(text: string): string {
  // `[\s\S]` stands in for Python's DOTALL. Non-greedy `*?` matches
  // the minimal body before the closing `---`.
  const re = /^---\n[\s\S]*?\n---\n?/;
  return text.replace(re, '');
}

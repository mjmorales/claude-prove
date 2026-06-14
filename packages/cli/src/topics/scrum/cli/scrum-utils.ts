/**
 * Shared helpers for scrum CLI subcommands.
 *
 * Kept intentionally tiny — anything that grows domain logic belongs in
 * the store layer, not here.
 */

/**
 * Slugify a human title to a lowercase, hyphen-delimited stem capped at 30
 * chars. When the title carries no alphanumerics the stem is empty and the
 * caller substitutes a prefix.
 */
function slugStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/**
 * Derive an id from a human title plus a base36 timestamp suffix for
 * best-effort uniqueness. When the title contains no alphanumerics, the
 * `prefix` stands in as the slug so the return value is still useful.
 *
 * Used for EXPLICIT-key entities (task / milestone ids) where the natural key is
 * either user-supplied or accept-and-surface under sync: a same-millisecond
 * timestamp collision there degrades to a last-push overwrite the post-pull pass
 * surfaces, not a sync-blocking secondary-UNIQUE throw. Auto-generated
 * acceptance-criterion ids — which DO ride a secondary UNIQUE(task_id,
 * criterion_id) — use `generateCriterionId` instead for a collision-resistant
 * suffix.
 *
 * Examples:
 *   generateId('Ship onboarding', 'task')      -> 'ship-onboarding-lv8r2a'
 *   generateId('!!!', 'milestone')             -> 'milestone-lv8r2a'
 */
export function generateId(title: string, prefix: string): string {
  const slug = slugStem(title);
  const suffix = Date.now().toString(36);
  return slug.length > 0 ? `${slug}-${suffix}` : `${prefix}-${suffix}`;
}

/**
 * Derive a COLLISION-RESISTANT acceptance-criterion external id from a human
 * text. The external id rides the secondary `UNIQUE(task_id, criterion_id)` on
 * `scrum_acceptance_criteria`, which the shipped sync engine does NOT absorb
 * into its PK-keyed UPSERT replay — a duplicate would raise `UNIQUE constraint
 * failed` and block sync. A bare timestamp suffix collides when two operators
 * auto-generate an id for the same task in the same millisecond, so the suffix
 * pairs the base36 timestamp with random base36 entropy: two distinct concurrent
 * auto-generated adds carry distinct criterion ids and both survive the rebase.
 * An EXPLICIT user-supplied `--criterion <id>` bypasses this and stays the
 * verbatim key, so a genuine same-id duplicate is still caught as a true
 * duplicate by the app-level guard.
 *
 * Example: generateCriterionId('builds clean') -> 'builds-clean-lv8r2a-k3p9'
 */
export function generateCriterionId(text: string): string {
  const slug = slugStem(text);
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  const suffix = `${ts}-${rand}`;
  return slug.length > 0 ? `${slug}-${suffix}` : `ac-${suffix}`;
}

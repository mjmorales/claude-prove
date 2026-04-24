/**
 * Shared helpers for scrum CLI subcommands.
 *
 * Kept intentionally tiny — anything that grows domain logic belongs in
 * the store layer, not here.
 */

/**
 * Derive an id from a human title plus a base36 timestamp suffix for
 * best-effort uniqueness. When the title contains no alphanumerics, the
 * `prefix` stands in as the slug so the return value is still useful.
 *
 * Examples:
 *   generateId('Ship onboarding', 'task')      -> 'ship-onboarding-lv8r2a'
 *   generateId('!!!', 'milestone')             -> 'milestone-lv8r2a'
 */
export function generateId(title: string, prefix: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const suffix = Date.now().toString(36);
  return slug.length > 0 ? `${slug}-${suffix}` : `${prefix}-${suffix}`;
}

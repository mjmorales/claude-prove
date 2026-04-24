/**
 * Shared JSON fetch helper. Extracted from `lib/api.ts` and `lib/scrumApi.ts`
 * so both clients throw identically shaped errors and stay in sync.
 */
export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json() as Promise<T>;
}

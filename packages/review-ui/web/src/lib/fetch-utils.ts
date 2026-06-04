/**
 * Shared JSON fetch helpers. Extracted from `lib/api.ts` and `lib/scrumApi.ts`
 * so both clients throw identically shaped errors and stay in sync.
 *
 * SINGLE-SOURCE INVARIANT: the active project key (`?project=<id>`) is injected
 * HERE and nowhere else. Every data request both clients issue funnels through
 * `getJSON`/`postJSON`, so threading the key through this one seam guarantees no
 * per-route call site repeats the wiring. `ActiveProjectProvider` is the only
 * writer — it calls `setActiveProjectKeyForRequests` from an effect on key
 * change; the data layer reads the module-level value at request time.
 */

// The active project key the provider broadcasts. `null` means the caller
// targets the server's startup-root default (no `?project=` appended).
let activeProjectKey: string | null = null;

/**
 * Set the project key appended to every `/api/*` request. Called only by
 * `ActiveProjectProvider` on key change — this is the provider→fetch-layer
 * seam that keeps injection single-sourced.
 */
export function setActiveProjectKeyForRequests(key: string | null): void {
  activeProjectKey = key;
}

/**
 * Append `project=<activeProjectKey>` to an `/api/*` URL when a key is set.
 * No-ops when the key is null, when the URL already carries a `project` param
 * (an explicit caller-passed value wins), or for non-`/api/` URLs. Preserves
 * any pre-existing query string.
 */
function withProject(url: string): string {
  if (activeProjectKey === null) return url;
  if (!url.startsWith("/api/")) return url;

  const [pathAndQuery, hash] = splitHash(url);
  const queryStart = pathAndQuery.indexOf("?");
  const path = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  const existingQuery = queryStart === -1 ? "" : pathAndQuery.slice(queryStart + 1);

  const params = new URLSearchParams(existingQuery);
  if (params.has("project")) return url;
  params.set("project", activeProjectKey);

  return `${path}?${params.toString()}${hash}`;
}

/** Split a URL into its path+query and `#fragment` halves so the fragment
 * survives query-param surgery. */
function splitHash(url: string): [string, string] {
  const hashStart = url.indexOf("#");
  if (hashStart === -1) return [url, ""];
  return [url.slice(0, hashStart), url.slice(hashStart)];
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(withProject(url));
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json() as Promise<T>;
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(withProject(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    // Surface the server's JSON error body (e.g. {error:'milestone not found'})
    // so callers can show actionable detail instead of a bare status line.
    let detail = "";
    try {
      detail = await r.text();
    } catch {
      /* body unreadable — fall back to the status line alone */
    }
    throw new Error(
      `${r.status} ${r.statusText}: ${url}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
    );
  }
  return r.json() as Promise<T>;
}

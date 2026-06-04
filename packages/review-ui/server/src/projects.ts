/**
 * Per-request project resolution for the multi-project review-ui server.
 *
 * The server is a single process that fronts EVERY prove project on the
 * machine (the machine-global registry at `~/.claude-prove/projects.json`).
 * Data routes exec `git` and read the filesystem against a project root, so
 * the `?project=<key>` the frontend sends is an attacker-influenced value that
 * MUST be resolved through a security boundary before any root reaches a
 * subprocess or `fs` call. That boundary is `resolveProjectRoot`: a key only
 * ever resolves to a path that EXACTLY equals a currently-registered root —
 * never a path derived from, prefixed by, or escaping a registered root.
 *
 * Project-id scheme: the `id` is the registry's absolute `path`, URL-encoded
 * (`encodeURIComponent`). The registry keys entries by exact `path`, so the
 * encoded path is a lossless, collision-free transport of that primary key:
 * resolve/normalize → exact-match a registry entry. A basename + short-hash
 * scheme was rejected because it is lossy (the server would have to scan and
 * reverse-map every entry to recover the root, and two roots sharing a basename
 * could collide), whereas the encoded path round-trips by URL-decode alone and
 * the registry lookup stays an O(n) exact-equality scan with no ambiguity. The
 * encoding only makes the key URL-safe; it grants no trust — the registry
 * membership check is the sole authority.
 *
 * Decode discipline: the `?project=` value is decoded EXACTLY ONCE end-to-end.
 * Fastify URL-decodes the query string on the HTTP path, so by the time a
 * handler reads `req.query.project` the key is already the raw registry path —
 * `resolveProjectRoot` therefore expects an already-decoded key and does NOT
 * decode again. Decoding twice would corrupt any registered root containing a
 * literal `%` (the byte that survives the first decode would be mis-read as the
 * start of a second escape), breaking that project fail-closed.
 */

import path from "node:path";
import {
  type ProjectEntry,
  list as listRegistry,
  prune as pruneRegistry,
} from "@claude-prove/store";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Resolve a request to a validated absolute root, replying with a structured
 * 400/404 and returning null on rejection. The single pre-handler every data
 * route shares: call it first, bail when it returns null (the reply is sent).
 *
 * The closure binds the per-app startup root (the absent-`?project=` fallback)
 * and the registry test seam, so route registrars receive ONE callable instead
 * of threading both values into every handler.
 */
export type ProjectResolver = (req: FastifyRequest, reply: FastifyReply) => string | null;

/**
 * A registry-backed project the routes operate against. `id` is the URL-safe
 * `?project=` key (the encoded registry path); `path` is the validated absolute
 * root; `name` is the display basename. Constructed ONLY from a registry entry,
 * so a `ProjectRef` always denotes a currently-registered root.
 */
export interface ProjectRef {
  /** URL-safe `?project=` key — `encodeURIComponent(entry.path)`. */
  id: string;
  /** Absolute repository root, exactly as stored in the registry. */
  path: string;
  /** Display name — the registry entry's basename. */
  name: string;
}

/** Structured error body for a rejected/missing project, matching route style. */
export interface ProjectError {
  error: string;
  /** The offending `?project=` key, echoed back for client diagnostics. */
  project: string;
}

/** Derive the URL-safe `?project=` key for a registry entry. */
function refIdFor(entryPath: string): string {
  return encodeURIComponent(entryPath);
}

/** Map a registry entry to the route-facing `ProjectRef` shape. */
function toRef(entry: ProjectEntry): ProjectRef {
  return { id: refIdFor(entry.path), path: entry.path, name: entry.name };
}

/**
 * List the visible projects as `ProjectRef[]`, most-recently-seen first, AFTER
 * pruning dead roots. Prune-on-read drops a project whose root or
 * `.prove/prove.db` has vanished so it never appears as a selectable option,
 * then `list` returns the survivors. This is the ONLY read path that mutates
 * the registry (prune is a write); the per-request resolve path below uses the
 * read-only `listProjectsReadOnly` instead so a high-volume data route never
 * triggers registry writes. `baseOverride` is the registry's test seam (a tmp
 * dir), threaded through so tests never touch the real `~/.claude-prove/`.
 */
export function listProjects(baseOverride?: string): ProjectRef[] {
  pruneRegistry(baseOverride);
  return listRegistry(baseOverride).map(toRef);
}

/**
 * List the visible projects as `ProjectRef[]` WITHOUT pruning — a pure read.
 * Per-request resolution uses this so a data route's membership check never
 * incurs a registry write. A dead root lingers in this view until the
 * `/api/projects` listing path (the prune owner) next evicts it; that is
 * acceptable because the resolved root is still re-validated for existence by
 * the git/fs call the route makes against it.
 */
export function listProjectsReadOnly(baseOverride?: string): ProjectRef[] {
  return listRegistry(baseOverride).map(toRef);
}

/**
 * Resolve an ALREADY-DECODED `?project=` key to a validated absolute root, or
 * null on any rejection, WITHOUT pruning the registry (a pure read). THE
 * security boundary for the per-request data path: the only path ever returned
 * is one that EXACTLY equals a currently-registered visible root.
 *
 * Callers pass the key Fastify has already URL-decoded (`req.query.project`),
 * so this function performs NO decode of its own — see the module header's
 * single-decode discipline. A non-string/empty key is the only malformed-input
 * guard needed here; the membership check below rejects everything else.
 *
 * The check is deliberately strict and membership-based rather than
 * prefix-based, so none of the usual escapes get through:
 *   - an unregistered key → null;
 *   - a relative key carrying `..` → resolves to some path, but unless that
 *     resolved path is itself a registered root it is rejected (no "starts
 *     with a registered root" prefix trick);
 *   - an absolute path that is not a registered root → null (no passthrough);
 *   - a leading-dash key → cannot equal an absolute registry path → null.
 */
export function resolveProjectRoot(key: string, baseOverride?: string): string | null {
  if (typeof key !== "string" || key.length === 0) return null;

  // Normalize the candidate to a canonical absolute form for comparison. The
  // registry stores already-resolved absolute roots, so resolve()+the registry
  // entries are compared on the same canonical footing — `..` segments collapse
  // here, leaving an exact-equality membership test as the sole gate.
  const candidate = path.resolve(key);

  // Membership against the (read-only) registry: the resolved candidate must be
  // byte-for-byte one of the registered roots. No prefix/containment check —
  // exact equality is what blocks every traversal and passthrough variant.
  const roots = listProjectsReadOnly(baseOverride).map((p) => p.path);
  return roots.includes(candidate) ? candidate : null;
}

/**
 * Resolve the requesting `?project=` key to a `ProjectRef`, or reply with a
 * structured error and return null. Shares the per-request resolve path (no
 * prune); call it first, bail when it returns null (the reply is already sent).
 *
 *   - missing/empty `project` → 400 `{ error: "missing project", project: "" }`
 *   - present but unresolved  → 404 `{ error: "unknown project", project }`
 *
 * A returned `ProjectRef` is guaranteed to denote a registered root, so the
 * route may hand `ref.path` straight to git/fs without re-validating.
 */
export function requireProject(
  req: FastifyRequest,
  reply: FastifyReply,
  baseOverride?: string,
): ProjectRef | null {
  const raw = (req.query as { project?: unknown } | undefined)?.project;
  const key = typeof raw === "string" ? raw : "";
  if (key.length === 0) {
    reply.code(400).send({ error: "missing project", project: "" } satisfies ProjectError);
    return null;
  }

  const root = resolveProjectRoot(key, baseOverride);
  if (root === null) {
    reply.code(404).send({ error: "unknown project", project: key } satisfies ProjectError);
    return null;
  }

  return toRef({ path: root, name: path.basename(root), last_seen: "" });
}

/**
 * Build the per-app project resolver every data-route registrar receives. The
 * returned closure resolves each request to a validated absolute root:
 *
 *   - `?project=<registered-id>` → that root (the security boundary above).
 *   - `?project=<unknown/escaping>` → 404, returns null (reply already sent).
 *   - absent `?project=` → `defaultRoot` (the buildApp startup repoRoot).
 *
 * The absent-param fallback keeps the single-project web UI working while the
 * frontend's project-selector shell is still landing: a request that names no
 * project transparently scopes to the root the server booted against, exactly
 * as the pre-multi-project closure did. Once every client sends `?project=`,
 * this fallback simply stops being exercised — it never weakens the boundary
 * because a PRESENT key is always membership-checked.
 *
 * `baseOverride` is the registry test seam, captured here so route handlers
 * stay seam-agnostic.
 */
export function makeProjectResolver(defaultRoot: string, baseOverride?: string): ProjectResolver {
  return (req, reply) => {
    const raw = (req.query as { project?: unknown } | undefined)?.project;
    const key = typeof raw === "string" ? raw : "";
    if (key.length === 0) return defaultRoot;

    const root = resolveProjectRoot(key, baseOverride);
    if (root === null) {
      reply.code(404).send({ error: "unknown project", project: key } satisfies ProjectError);
      return null;
    }
    return root;
  };
}

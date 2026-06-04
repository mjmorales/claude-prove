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
 * decode → resolve/normalize → exact-match a registry entry. A basename +
 * short-hash scheme was rejected because it is lossy (the server would have to
 * scan and reverse-map every entry to recover the root, and two roots sharing a
 * basename could collide), whereas the encoded path is reversible by decode
 * alone and the registry lookup stays an O(n) exact-equality scan with no
 * ambiguity. The encoding only makes the key URL-safe; it grants no trust —
 * the registry membership check is the sole authority.
 */

import path from "node:path";
import {
  type ProjectEntry,
  list as listRegistry,
  prune as pruneRegistry,
} from "@claude-prove/store";
import type { FastifyReply, FastifyRequest } from "fastify";

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
 * List the visible projects as `ProjectRef[]`, most-recently-seen first.
 * Prune-on-read first so a project whose root or `.prove/prove.db` has vanished
 * never appears as a selectable option — the registry's `prune` drops dead
 * roots, then `list` returns the survivors. `baseOverride` is the registry's
 * test seam (a tmp dir), threaded through so tests never touch the real
 * `~/.claude-prove/`.
 */
export function listProjects(baseOverride?: string): ProjectRef[] {
  pruneRegistry(baseOverride);
  return listRegistry(baseOverride).map(toRef);
}

/**
 * Resolve a `?project=` key to a validated absolute root, or null on any
 * rejection. THE security boundary: the only path ever returned is one that
 * EXACTLY equals a currently-registered (visible, alive-after-prune) root.
 *
 * The check is deliberately strict and membership-based rather than
 * prefix-based, so none of the usual escapes get through:
 *   - an unregistered key (decoded or not) → null;
 *   - a relative key carrying `..` → resolves to some path, but unless that
 *     resolved path is itself a registered root it is rejected (no "starts
 *     with a registered root" prefix trick);
 *   - an absolute path that is not a registered root → null (no passthrough);
 *   - a leading-dash key → cannot equal an absolute registry path → null.
 *
 * The key is first decoded (it is normally `encodeURIComponent(path)`); a
 * malformed `%`-escape that throws is treated as a miss, not an exception.
 */
export function resolveProjectRoot(key: string, baseOverride?: string): string | null {
  if (key.length === 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // A malformed percent-escape is an invalid key, not a server fault.
    return null;
  }

  // Normalize the candidate to a canonical absolute form for comparison. The
  // registry stores already-resolved absolute roots, so resolve()+the registry
  // entries are compared on the same canonical footing — `..` segments collapse
  // here, leaving an exact-equality membership test as the sole gate.
  const candidate = path.resolve(decoded);

  // Membership against the live (pruned) registry: the resolved candidate must
  // be byte-for-byte one of the registered roots. No prefix/containment check —
  // exact equality is what blocks every traversal and passthrough variant.
  const roots = listProjects(baseOverride).map((p) => p.path);
  return roots.includes(candidate) ? candidate : null;
}

/**
 * Resolve the requesting `?project=` key to a `ProjectRef`, or reply with a
 * structured error and return null. The single pre-handler every data route
 * shares: call it first, bail when it returns null (the reply is already sent).
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

  return { id: encodeURIComponent(root), path: root, name: path.basename(root) };
}

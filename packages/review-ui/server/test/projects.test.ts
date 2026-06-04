/**
 * Tests for the per-request project resolution layer — the security boundary
 * the multi-project data routes share.
 *
 * The registry's `baseOverride` seam points every read/write at a tmp dir so no
 * test ever touches the real `~/.claude-prove/`. A "registered" project here is
 * a tmp repo root with a `.prove/prove.db` file, since the registry's `prune`
 * (which `listProjects`/`resolveProjectRoot` run on every read) drops any root
 * whose directory or `.prove/prove.db` has vanished.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add as registryAdd, registryFilePath } from "@claude-prove/store";
import {
  listProjects,
  listProjectsReadOnly,
  makeProjectResolver,
  requireProject,
  resolveProjectRoot,
} from "../src/projects";

let baseDir: string;
let workspace: string;

/**
 * Create a tmp repo root with a `.prove/prove.db` (so `prune` keeps it) and
 * register it in the tmp-dir registry. Returns the absolute root path.
 */
function registerLiveProject(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  writeFileSync(join(root, ".prove", "prove.db"), "");
  registryAdd(root, baseDir);
  return root;
}

beforeEach(() => {
  // `baseDir` holds `projects.json`; `workspace` holds the fake project roots.
  baseDir = mkdtempSync(join(tmpdir(), "prove-projects-base-"));
  workspace = mkdtempSync(join(tmpdir(), "prove-projects-ws-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  test("resolves a registered key (the encoded path) to its absolute root", () => {
    const root = registerLiveProject("alpha");
    const key = encodeURIComponent(root);
    expect(resolveProjectRoot(key, baseDir)).toBe(root);
  });

  test("rejects an unregistered key", () => {
    registerLiveProject("alpha");
    const stranger = encodeURIComponent(join(workspace, "not-registered"));
    expect(resolveProjectRoot(stranger, baseDir)).toBeNull();
  });

  test("rejects a `..` traversal key that does not land on a registered root", () => {
    const root = registerLiveProject("alpha");
    // `<root>/../alpha-sibling` normalizes to a sibling of the registered root —
    // path-shaped, escapes the root, and is not itself registered.
    const traversal = encodeURIComponent(join(root, "..", "alpha-sibling"));
    expect(resolveProjectRoot(traversal, baseDir)).toBeNull();
  });

  test("rejects a `..` key even when it normalizes to a prefix of a registered root", () => {
    const root = registerLiveProject("alpha");
    // `<root>/sub/..` normalizes back to the registered root via traversal. It
    // MUST still resolve (the normalized path equals a registered root) — this
    // asserts normalization is applied so traversal cannot be used to smuggle a
    // non-root through, while a path that genuinely normalizes to a root works.
    const normalized = encodeURIComponent(join(root, "sub", ".."));
    expect(resolveProjectRoot(normalized, baseDir)).toBe(root);
    // The parent dir itself (a prefix of the root) is NOT registered → rejected.
    const parent = encodeURIComponent(join(root, ".."));
    expect(resolveProjectRoot(parent, baseDir)).toBeNull();
  });

  test("rejects an absolute path that is not a registered root", () => {
    registerLiveProject("alpha");
    expect(resolveProjectRoot(encodeURIComponent("/etc/passwd"), baseDir)).toBeNull();
    // Raw (un-encoded) absolute path also fails — no passthrough.
    expect(resolveProjectRoot("/etc/passwd", baseDir)).toBeNull();
  });

  test("rejects a leading-dash key", () => {
    registerLiveProject("alpha");
    expect(resolveProjectRoot("--output=/tmp/pwn", baseDir)).toBeNull();
    expect(resolveProjectRoot(encodeURIComponent("-rf"), baseDir)).toBeNull();
  });

  test("rejects an empty key", () => {
    registerLiveProject("alpha");
    expect(resolveProjectRoot("", baseDir)).toBeNull();
  });

  test("treats a malformed percent-escape as a miss, not an exception", () => {
    registerLiveProject("alpha");
    expect(resolveProjectRoot("%E0%A4%A", baseDir)).toBeNull();
  });
});

describe("listProjects", () => {
  test("maps registered projects to ProjectRef with the encoded-path id", () => {
    const root = registerLiveProject("alpha");
    const refs = listProjects(baseDir);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      id: encodeURIComponent(root),
      path: root,
      name: "alpha",
    });
  });

  test("prune-on-read drops a dead root before listing", () => {
    const live = registerLiveProject("alpha");
    const dead = registerLiveProject("beta");
    // Remove the dead project's root from disk; prune-on-read must evict it.
    rmSync(dead, { recursive: true, force: true });

    const paths = listProjects(baseDir).map((p) => p.path);
    expect(paths).toContain(live);
    expect(paths).not.toContain(dead);
  });
});

describe("requireProject", () => {
  /** Minimal fastify reply double capturing the status code and body. */
  function fakeReply() {
    const captured: { code?: number; body?: unknown } = {};
    const reply = {
      code(c: number) {
        captured.code = c;
        return reply;
      },
      send(b: unknown) {
        captured.body = b;
        return reply;
      },
    };
    return { reply, captured };
  }

  test("returns a ProjectRef for a registered key", () => {
    const root = registerLiveProject("alpha");
    const { reply, captured } = fakeReply();
    const req = { query: { project: encodeURIComponent(root) } } as never;
    const ref = requireProject(req, reply as never, baseDir);
    expect(ref).toEqual({ id: encodeURIComponent(root), path: root, name: "alpha" });
    expect(captured.code).toBeUndefined();
  });

  test("400s a missing project key", () => {
    registerLiveProject("alpha");
    const { reply, captured } = fakeReply();
    const req = { query: {} } as never;
    expect(requireProject(req, reply as never, baseDir)).toBeNull();
    expect(captured.code).toBe(400);
    expect(captured.body).toEqual({ error: "missing project", project: "" });
  });

  test("404s an unknown project key, echoing it back", () => {
    registerLiveProject("alpha");
    const { reply, captured } = fakeReply();
    const stranger = encodeURIComponent(join(workspace, "not-registered"));
    const req = { query: { project: stranger } } as never;
    expect(requireProject(req, reply as never, baseDir)).toBeNull();
    expect(captured.code).toBe(404);
    expect(captured.body).toEqual({ error: "unknown project", project: stranger });
  });
});

describe("read-only resolve path", () => {
  /**
   * Mtime-stable witness that the registry file was NOT written: capture the
   * raw bytes before and after, asserting they are byte-identical. The listing
   * path (`listProjects`) prunes and rewrites; the per-request path must not.
   */
  function registryBytes(): string {
    const p = registryFilePath(baseDir);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  test("listProjectsReadOnly returns the same refs as listProjects without pruning", () => {
    const root = registerLiveProject("alpha");
    expect(listProjectsReadOnly(baseDir)).toEqual([
      { id: encodeURIComponent(root), path: root, name: "alpha" },
    ]);
  });

  test("resolveProjectRoot does NOT prune a dead root from disk (pure read)", () => {
    const live = registerLiveProject("alpha");
    const dead = registerLiveProject("beta");
    rmSync(dead, { recursive: true, force: true });

    const before = registryBytes();
    // A dead root lingers in the read-only view, so resolving it still succeeds
    // (the route's own fs call is the existence re-check). Crucially, the
    // resolve leaves the registry file untouched — no prune write.
    expect(resolveProjectRoot(encodeURIComponent(dead), baseDir)).toBe(dead);
    expect(resolveProjectRoot(encodeURIComponent(live), baseDir)).toBe(live);
    expect(registryBytes()).toBe(before);
  });
});

describe("makeProjectResolver", () => {
  /** Reply double capturing code + body, mirroring requireProject's tests. */
  function fakeReply() {
    const captured: { code?: number; body?: unknown } = {};
    const reply = {
      code(c: number) {
        captured.code = c;
        return reply;
      },
      send(b: unknown) {
        captured.body = b;
        return reply;
      },
    };
    return { reply, captured };
  }

  test("absent ?project= falls back to the startup root", () => {
    const fallback = registerLiveProject("alpha");
    const resolve = makeProjectResolver(fallback, baseDir);
    const { reply, captured } = fakeReply();
    const req = { query: {} } as never;
    expect(resolve(req, reply as never)).toBe(fallback);
    expect(captured.code).toBeUndefined();
  });

  test("present registered ?project= resolves to that root, ignoring the fallback", () => {
    const fallback = registerLiveProject("alpha");
    const other = registerLiveProject("beta");
    const resolve = makeProjectResolver(fallback, baseDir);
    const { reply } = fakeReply();
    const req = { query: { project: encodeURIComponent(other) } } as never;
    expect(resolve(req, reply as never)).toBe(other);
  });

  test("present unregistered ?project= → 404 and null (reply sent)", () => {
    const fallback = registerLiveProject("alpha");
    const resolve = makeProjectResolver(fallback, baseDir);
    const { reply, captured } = fakeReply();
    const stranger = encodeURIComponent(join(workspace, "not-registered"));
    const req = { query: { project: stranger } } as never;
    expect(resolve(req, reply as never)).toBeNull();
    expect(captured.code).toBe(404);
    expect(captured.body).toEqual({ error: "unknown project", project: stranger });
  });
});

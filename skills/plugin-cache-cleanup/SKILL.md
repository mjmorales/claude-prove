---
name: plugin-cache-cleanup
description: Prune stale cached versions of the prove plugin from Claude Code's plugin cache. Use when superseded versions pile up under plugins/cache and agents read stale skills/references from them, or when reclaiming plugin-cache disk space. Triggers on "clean up cached plugin versions", "prune the plugin cache", "remove old prove versions", "stale plugin cache".
---

# Plugin Cache Cleanup

Claude Code keeps every installed version of a plugin under `<plugins-root>/cache/<marketplace>/<plugin>/<version>/` and never prunes superseded ones. Stale prove versions are actively harmful: agents that Glob/Grep or follow skill paths can read superseded SKILL.md, references, and CLI code. This skill removes every cached prove version that no install manifest references — behind one human gate, never touching anything else.

**Hard floor:** delete only `cache/<marketplace>/prove/<version>/` directories classified stale. Never touch `installed_plugins.json`, `known_marketplaces.json`, `plugin-catalog-cache.json`, `marketplaces/`, `data/`, or any non-prove plugin's cache; instead leave them exactly as found.

## Step 1: Discover plugin roots

Collect every plugins root that exists — claude-env multiplies them:

```bash
for root in ~/.claude/plugins ~/.claude-envs/*/plugins; do
  [ -d "$root/cache" ] || [ -f "$root/installed_plugins.json" ] || continue
  (cd "$root" && pwd -P)   # physical path — roots may be symlinked
done | sort -u
```

## Step 2: Build the active set

Active = every `installPath` referenced by **any** discovered manifest. Manifests in one root may reference paths in another root — collect globally before classifying:

```bash
for root in <discovered roots>; do
  [ -f "$root/installed_plugins.json" ] || continue
  jq -r '.plugins[][].installPath' "$root/installed_plugins.json"
done | sort -u
```

Resolve each to a physical path (`cd <path> && pwd -P`; keep unresolvable entries verbatim — a dangling installPath still marks intent).

## Step 3: Classify prove version dirs

For each root, list `cache/*/prove/*/` version dirs, resolve to physical paths, dedupe, and classify:

- **active** — physical path is in the active set
- **stale** — not referenced by any manifest

Safety overrides, applied in order:

1. If a prove cache has **no** active version in any manifest (orphan install), keep the newest version dir (highest semver, fallback mtime) and classify only the rest stale — never delete a plugin's last version.
2. If nothing is stale, report "cache is clean: <active versions kept>" and stop.

## Step 4: Gate

Present one table — version, physical path, `du -sh` size, classification — plus the total to reclaim. Then `AskUserQuestion` (header "Cleanup"):

- **"Delete stale versions"** — proceed to Step 5
- **"Pick individually"** — re-gate per version dir
- **"Abort"** — delete nothing, stop

## Step 5: Delete and verify

```bash
rm -rf <each approved stale version dir>
```

Then verify: every active path still exists (`test -d`), and `cache/*/prove/` now contains only kept versions. If an active path went missing, report it as an error immediately — do not continue.

Report one line per deleted version plus total disk reclaimed. If the running session's plugin commands came from a deleted version (the skill itself runs from the cache), note that a session restart re-resolves them.

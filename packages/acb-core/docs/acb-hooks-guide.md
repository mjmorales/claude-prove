# ACB Intent Hook System

A deep-dive reference for the three git hooks that enforce and automate ACB (Agent Change Brief) manifests. For a workflow overview and Claude Code slash command setup, see [claude-code-setup.md](./claude-code-setup.md).

## Hook Overview

Three hooks work together to gate and record agent intent:

| Hook | Trigger | What it does |
|------|---------|--------------|
| `pre-commit` | Before every commit | Validates that `.acb/intents/staged.json` exists and is structurally correct. Rejects the commit if it's missing or malformed. |
| `post-commit` | After a successful commit | Finalizes the manifest: renames `staged.json` to `<short-sha>.json`, fills in the real commit SHA, then progressively assembles `.acb/review.acb.json`. |
| `post-checkout` | After a branch checkout | Detects git worktrees and symlinks `.acb/intents/` back to the main repo so agents write manifests to a shared location. |

All three hooks are shell thin-wrappers that delegate immediately to the `acb-review` CLI (`dist/cli/index.js`). The logic lives in TypeScript, not in the hook scripts themselves.

### pre-commit in detail

The hook calls `acb-review check-manifest`. It exits 0 (pass) in these cases:

- `ACB_SKIP_MANIFEST=1` is set in the environment
- The commit is a merge commit (`.git/MERGE_HEAD` exists)
- `ACB_AMENDING=1` is set (set by post-commit to prevent re-triggering)
- The current branch is the configured trunk branch
- No files are staged, or the only staged file is the manifest itself

Otherwise, it looks for `.acb/intents/staged.json`. If the file is absent, it prints the full manifest template and exits 1. If the file exists, it parses and validates the structure — a manifest with an empty `intent_groups` array is also rejected.

Humans can always bypass: `git commit --no-verify`.

### post-commit in detail

After a successful commit, the hook calls `acb-review post-commit`, which:

1. Reads `.acb/intents/staged.json`
2. Replaces the `"commit_sha": "pending"` field with the real full SHA
3. Writes the updated document to `.acb/intents/<short-sha>.json`
4. Deletes `staged.json`
5. Runs `acb-review assemble` to rebuild `.acb/review.acb.json` from all manifests in `.acb/intents/`

If assembly fails (e.g., a corrupt manifest from a previous commit), the hook prints a warning and exits 0 — a post-commit failure should not block the developer. Run `acb-review assemble` manually to recover.

### post-checkout in detail

This hook runs on branch checkouts only (it checks that the third argument is `1`). It does nothing in the main repo. In a worktree it:

1. Detects the worktree by checking whether `.git` is a file rather than a directory
2. Resolves the main repo root via `git rev-parse --git-common-dir`
3. Creates `.acb/intents/` in the main repo if it doesn't exist
4. Creates `.acb/` in the worktree if needed
5. Symlinks `<worktree>/.acb/intents/` to `<main-repo>/.acb/intents/`

If a symlink or directory already exists at the target path, the hook skips silently.

---

## Installation

### Installing ACB hooks

The plugin install does **not** install hooks automatically — hooks are per-project and must be installed explicitly.

Install hooks in each project where you want ACB enforcement:

```bash
npx acb-review install --link
```

Add `--framework claudecode` to also scaffold the `/acb-resolve`, `/acb-fix`, and `/acb-discuss` slash commands:

```bash
npx acb-review install --link --framework claudecode
```

### Link mode vs copy mode

| | Link mode (`--link`) | Copy mode (default) |
|--|---------------------|---------------------|
| Mechanism | Sets `core.hooksPath` to the package's `hooks/` directory | Copies hook scripts to `.git/hooks/` |
| Updates | Automatic — hooks update when the package updates | Manual — must re-run install after updates |
| Worktree support | Shared — `core.hooksPath` applies to all worktrees | Not shared — each worktree needs its own copy |
| New hooks | Picked up automatically | Require explicit reinstall |
| Recommendation | **Use this** | Legacy only |

Link mode is recommended for all new installs. When using link mode, the hook scripts in `.git/hooks/` are not used — git reads hooks directly from the package directory.

### What install creates

Both modes create:

- `.acb/intents/` — working directory for per-commit manifests (gitignored)
- `.acb/.gitignore` — contains `intents/` so manifests are never committed

---

## Configuration

### `.acb/config.json`

```json
{
  "trunk_branch": "main"
}
```

This file tells the pre-commit hook which branch to skip. Commits on the trunk branch do not require an intent manifest — direct fixes, merge commits, and CI-driven changes on main should not be blocked.

The default trunk branch is `main` if no config file exists. To use a different name:

```json
{
  "trunk_branch": "master"
}
```

The config file is read on every commit. You can change the trunk branch name at any time without reinstalling hooks.

### `.acb/.gitignore`

Created automatically by `acb-review install`. Contents:

```
# Intent manifests are ephemeral — the assembled ACB is the artifact
intents/
```

The assembled review file (`.acb/review.acb.json`) is intentionally **not** gitignored — it is the artifact that reviewers interact with and should be committed to the branch.

---

## Hook Modes

### Link mode (recommended)

Link mode sets `git config core.hooksPath` to the absolute path of the package's `hooks/` directory:

```
core.hooksPath = /path/to/plugin/packages/acb-core/hooks
```

Verify it is set:

```bash
git config core.hooksPath
```

All three hooks (`pre-commit`, `post-commit`, `post-checkout`) live in that directory. Git reads them directly — no copies exist in `.git/hooks/`.

Because `core.hooksPath` is a repository-level git config setting, it applies to the main repo and all its worktrees automatically.

### Copy mode (legacy)

Copy mode places hook scripts in `.git/hooks/pre-commit`, `.git/hooks/post-commit`, and `.git/hooks/post-checkout`. Each script contains a hardcoded path pointing back to `dist/cli/index.js` in the package.

Copy mode works but has two drawbacks: worktrees do not inherit the hooks (each worktree needs its own `.git/hooks/` copy), and hooks go stale when the package updates.

---

## Worktree Support

Git worktrees share the main repo's `.git/` directory but have their own working tree. The `.acb/intents/` directory is gitignored and exists only on the filesystem — each worktree would normally have its own isolated copy, meaning a staged manifest written in one worktree would not be visible when assembling from another.

The `post-checkout` hook solves this by symlinking the worktree's `.acb/intents/` to the main repo's `.acb/intents/`. After checkout:

```
<worktree>/.acb/intents/  ->  <main-repo>/.acb/intents/
```

Agents write `staged.json` normally. It lands in the main repo's filesystem. The `post-commit` hook (running in the worktree context) reads and finalizes it there. The assembled `.acb/review.acb.json` is written to the main repo's `.acb/` as well.

This only works reliably in link mode. In copy mode, each worktree's `.git/hooks/` must be populated independently, and the `post-checkout` hook must already be present before the first worktree checkout — at which point it cannot symlink itself into existence.

---

## Trunk Branch Skip

Commits directly on the trunk branch bypass the manifest requirement entirely. This covers:

- Direct hotfixes on `main`
- Version bump commits from release tooling
- Merge commits (these are also always skipped regardless of branch)

The trunk branch is read from `.acb/config.json` on every commit. If the file doesn't exist or `trunk_branch` is not set, the hook defaults to `main`.

The branch check compares the exact name returned by `git rev-parse --abbrev-ref HEAD`. Detached HEAD state does not match any trunk name, so detached-HEAD commits require a manifest.

---

## Troubleshooting

### Hooks not running

Check which mode is active:

```bash
git config core.hooksPath
```

If this returns a path, you are in link mode. Verify the path exists and contains the hook scripts:

```bash
ls "$(git config core.hooksPath)"
# expected: post-checkout  post-commit  pre-commit
```

If `core.hooksPath` is empty, you are in copy mode. Verify hooks exist in `.git/hooks/`:

```bash
ls .git/hooks/pre-commit .git/hooks/post-commit .git/hooks/post-checkout
```

If the hooks are present but not executing, check that they are executable:

```bash
chmod +x "$(git config core.hooksPath)"/*
# or for copy mode:
chmod +x .git/hooks/pre-commit .git/hooks/post-commit .git/hooks/post-checkout
```

### Hooks not running in a worktree

In link mode, `core.hooksPath` is inherited automatically — no action needed. In copy mode, each worktree has its own `.git` file (not a directory) and its own hooks directory. The simplest fix is to migrate to link mode (see below).

### Missing `dist/` — hooks fail on execution

The hook scripts delegate to `dist/cli/index.js`. If that file is missing, the hooks will error with a `Cannot find module` message.

Rebuild the CLI:

```bash
cd /path/to/plugin/packages/acb-core
npm install
npx tsc
```

If the build was not run during plugin setup, the hooks will not work until it completes.

### Manifest validation errors

The pre-commit hook prints the full required structure when it rejects a commit. Common causes:

| Problem | Fix |
|---------|-----|
| `intent_groups` is an empty array | Add at least one intent group |
| Invalid `classification` value | Use `explicit`, `inferred`, or `speculative` |
| Missing `commit_sha` field | Set it to `"pending"` — post-commit fills in the real SHA |
| Missing required top-level fields | Check `acb_manifest_version`, `timestamp`, `intent_groups` are all present |

### Worktree symlink not created

The `post-checkout` hook runs on branch checkouts (third argument = `1`), not file checkouts. If you created a worktree but the symlink is missing, trigger it manually:

```bash
# From inside the worktree
mkdir -p .acb
ln -s "$(git rev-parse --git-common-dir)/../.acb/intents" .acb/intents
```

Or check out any branch inside the worktree to re-trigger the hook.

---

## Migration: Copy Mode to Link Mode

If your project has ACB hooks installed in copy mode (files in `.git/hooks/`), migrate to link mode to gain automatic updates and worktree support.

```bash
# Uninstall the copied hooks
npx acb-review uninstall

# Reinstall using link mode
npx acb-review install --link
```

`uninstall` identifies ACB-owned hooks by checking for both `ACB` and `intent` in the file content. It removes only those hooks — any non-ACB hooks in `.git/hooks/` are left untouched.

After migration, verify:

```bash
git config core.hooksPath
# should return a path ending in packages/acb-core/hooks
```

No changes to `.acb/config.json` or `.acb/.gitignore` are needed — those files are independent of hook mode.

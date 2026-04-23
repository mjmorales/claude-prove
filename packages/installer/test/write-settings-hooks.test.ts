import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROVE_HOOK_BLOCKS,
  type SettingsFile,
  SettingsParseError,
  writeSettingsHooks,
} from '../src/write-settings-hooks';

const PREFIX = 'bun run /Users/manuelmorales/dev/claude-prove/packages/cli/bin/run.ts';
const FIXTURES = resolve(__dirname, '__fixtures__/settings');

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `installer-settings-${label}-`));
}

function readJson(path: string): SettingsFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SettingsFile;
}

function copyFixture(name: string, dest: string): void {
  copyFileSync(join(FIXTURES, name), dest);
}

describe('writeSettingsHooks', () => {
  test('scaffolds full block list on missing file and matches current settings.json byte-shape', () => {
    const tmp = makeTmpDir('missing');
    try {
      const path = join(tmp, 'settings.json');
      const wrote = writeSettingsHooks(path, PREFIX);
      expect(wrote).toBe(true);

      const actual = readFileSync(path, 'utf8');
      // Byte-shape parity: emission against an empty file should reproduce
      // the current repo's `.claude/settings.json` exactly, modulo prefix
      // (which we already use as the canonical absolute path).
      const repoSettings = resolve(__dirname, '../../../.claude/settings.json');
      const expected = readFileSync(repoSettings, 'utf8');
      expect(actual).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('idempotent no-op when all blocks already in sync', () => {
    const tmp = makeTmpDir('noop');
    try {
      const path = join(tmp, 'settings.json');
      writeSettingsHooks(path, PREFIX);
      const firstMtime = readFileSync(path, 'utf8');

      const wrote = writeSettingsHooks(path, PREFIX);
      expect(wrote).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(firstMtime);
      // Tmp file should not linger after a no-op run.
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('updates stale prove blocks (prove-only file with old absolute prefix)', () => {
    const tmp = makeTmpDir('prove-only');
    try {
      const path = join(tmp, 'settings.json');
      copyFixture('prove-only-stale.json', path);

      const wrote = writeSettingsHooks(path, PREFIX);
      expect(wrote).toBe(true);

      const parsed = readJson(path);
      const acb = parsed.hooks?.PostToolUse?.find((b) => b._tool === 'acb');
      expect(acb?.hooks[0]?.command).toBe(
        `${PREFIX} acb hook post-commit --workspace-root $CLAUDE_PROJECT_DIR`,
      );
      expect(acb?.hooks[0]?.if).toBe('Bash(git commit*)');
      expect(acb?.hooks[0]?.timeout).toBe(10000);

      const runStateValidate = parsed.hooks?.PostToolUse?.find(
        (b) => b._tool === 'run_state' && b.matcher === 'Write|Edit|MultiEdit',
      );
      expect(runStateValidate?.hooks[0]?.command).toBe(`${PREFIX} run-state hook validate`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves user-authored blocks byte-for-byte, updates prove blocks', () => {
    const tmp = makeTmpDir('user-mixed');
    try {
      const path = join(tmp, 'settings.json');
      copyFixture('user-mixed.json', path);
      const before = readJson(path);
      const userBlockBefore = before.hooks?.PostToolUse?.[0];

      const wrote = writeSettingsHooks(path, PREFIX);
      expect(wrote).toBe(true);

      const after = readJson(path);
      // User block (matcher Bash, no _tool) must be identical to its
      // pre-merge shape and stay at index 0.
      const userBlockAfter = after.hooks?.PostToolUse?.find((b) => b._tool === undefined);
      expect(userBlockAfter).toEqual(userBlockBefore as object);
      expect(userBlockAfter?._tool).toBeUndefined();

      // acb block gets appended since no matching prove block existed.
      const acb = after.hooks?.PostToolUse?.find((b) => b._tool === 'acb');
      expect(acb).toBeDefined();
      expect(acb?.hooks[0]?.command).toContain('acb hook post-commit');

      // run_state validate was already present and in sync → still there.
      const rs = after.hooks?.PostToolUse?.find(
        (b) => b._tool === 'run_state' && b.matcher === 'Write|Edit|MultiEdit',
      );
      expect(rs).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('malformed JSON throws SettingsParseError and does not write', () => {
    const tmp = makeTmpDir('malformed');
    try {
      const path = join(tmp, 'settings.json');
      copyFixture('malformed.json', path);
      const before = readFileSync(path, 'utf8');

      expect(() => writeSettingsHooks(path, PREFIX)).toThrow(SettingsParseError);
      // Source file unchanged, no tmp residue.
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('atomic write: final file only appears after rename, no tmp residue', () => {
    const tmp = makeTmpDir('atomic');
    try {
      const path = join(tmp, 'settings.json');
      writeSettingsHooks(path, PREFIX);

      const entries = readdirSync(tmp);
      expect(entries).toContain('settings.json');
      expect(entries).not.toContain('settings.json.tmp');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--force rewrites already-in-sync blocks', () => {
    const tmp = makeTmpDir('force');
    try {
      const path = join(tmp, 'settings.json');
      writeSettingsHooks(path, PREFIX);

      // Mutate a prove block so we can observe force overwrites it.
      const parsed = readJson(path);
      const acb = parsed.hooks?.PostToolUse?.find((b) => b._tool === 'acb');
      if (acb) {
        acb.hooks[0] = {
          ...acb.hooks[0],
          type: 'command',
          command: 'drifted-but-sync-check-ignores-this',
        };
      }
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

      const wrote = writeSettingsHooks(path, PREFIX, { force: true });
      expect(wrote).toBe(true);

      const after = readJson(path);
      const acbAfter = after.hooks?.PostToolUse?.find((b) => b._tool === 'acb');
      expect(acbAfter?.hooks[0]?.command).toBe(
        `${PREFIX} acb hook post-commit --workspace-root $CLAUDE_PROJECT_DIR`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('all three _tool markers (acb, run_state, cafi) appear in emitted output', () => {
    const tmp = makeTmpDir('markers');
    try {
      const path = join(tmp, 'settings.json');
      writeSettingsHooks(path, PREFIX);
      const parsed = readJson(path);

      const allBlocks: Array<{ _tool?: string }> = [];
      for (const event of Object.keys(parsed.hooks ?? {}) as Array<
        keyof NonNullable<SettingsFile['hooks']>
      >) {
        const list = parsed.hooks?.[event];
        if (list) allBlocks.push(...list);
      }

      const tools = new Set(allBlocks.map((b) => b._tool).filter(Boolean));
      expect(tools.has('acb')).toBe(true);
      expect(tools.has('run_state')).toBe(true);
      expect(tools.has('cafi')).toBe(true);

      // All canonical specs land in the output.
      for (const spec of PROVE_HOOK_BLOCKS) {
        const match = parsed.hooks?.[spec.event]?.find(
          (b) => b._tool === spec.tool && b.matcher === spec.matcher,
        );
        expect(match, `missing block ${spec.event}/${spec.tool}/${spec.matcher}`).toBeDefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('blocks without _tool are never touched even when matcher collides', () => {
    const tmp = makeTmpDir('collide');
    try {
      const path = join(tmp, 'settings.json');
      // User block uses the same matcher "Bash" as the acb prove block, but
      // has no _tool → merge must not rewrite it; it must append a separate
      // acb block.
      const initial: SettingsFile = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'user-keeps-this', timeout: 1234 }],
            },
          ],
        },
      };
      writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');

      writeSettingsHooks(path, PREFIX);
      const after = readJson(path);
      const postToolUse = after.hooks?.PostToolUse ?? [];

      const user = postToolUse.find((b) => b._tool === undefined);
      expect(user?.hooks[0]?.command).toBe('user-keeps-this');
      expect(user?.hooks[0]?.timeout).toBe(1234);

      const acb = postToolUse.find((b) => b._tool === 'acb');
      expect(acb).toBeDefined();
      expect(acb?.hooks[0]?.command).toContain('acb hook post-commit');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('appends event array when event key is absent', () => {
    const tmp = makeTmpDir('absent-event');
    try {
      const path = join(tmp, 'settings.json');
      const initial: SettingsFile = { hooks: {} };
      writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');

      writeSettingsHooks(path, PREFIX);
      const after = readJson(path);

      expect(Array.isArray(after.hooks?.Stop)).toBe(true);
      expect(after.hooks?.Stop?.[0]?._tool).toBe('run_state');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

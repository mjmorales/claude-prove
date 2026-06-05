import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockTimeoutError, withFileLock } from './file-lock';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `file-lock-${prefix}-`));
}

/** Backdate a file's mtime so age-based staleness checks see it as old. */
function backdate(path: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
}

describe('withFileLock', () => {
  test('runs fn and removes the lockfile afterwards', async () => {
    const tmp = makeTmpDir('basic');
    const lockPath = join(tmp, 'x.lock');
    try {
      const result = await withFileLock(lockPath, () => {
        expect(existsSync(lockPath)).toBe(true);
        return 42;
      });
      expect(result).toBe(42);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('removes the lockfile when fn throws', async () => {
    const tmp = makeTmpDir('throws');
    const lockPath = join(tmp, 'x.lock');
    try {
      await expect(
        withFileLock(lockPath, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('serializes concurrent in-process read-modify-write sequences', async () => {
    const tmp = makeTmpDir('serialize');
    const lockPath = join(tmp, 'x.lock');
    const dataPath = join(tmp, 'counter.json');
    writeFileSync(dataPath, JSON.stringify({ n: 0 }), 'utf8');
    try {
      // Each task reads, yields (inviting interleaving), then writes — the
      // lost-update shape the lock must prevent.
      const bump = () =>
        withFileLock(
          lockPath,
          async () => {
            const data = JSON.parse(readFileSync(dataPath, 'utf8')) as { n: number };
            await new Promise((r) => setTimeout(r, 10));
            writeFileSync(dataPath, JSON.stringify({ n: data.n + 1 }), 'utf8');
          },
          { retryDelayMs: 5 },
        );
      await Promise.all([bump(), bump(), bump(), bump(), bump()]);
      expect(JSON.parse(readFileSync(dataPath, 'utf8'))).toEqual({ n: 5 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('serializes concurrent writers across process boundaries', async () => {
    const tmp = makeTmpDir('xproc');
    const lockPath = join(tmp, 'x.lock');
    const dataPath = join(tmp, 'counter.json');
    writeFileSync(dataPath, JSON.stringify({ n: 0 }), 'utf8');
    const lockModule = join(import.meta.dir, 'file-lock.ts');
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(lockModule)};
      await withFileLock(${JSON.stringify(lockPath)}, async () => {
        const data = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
        await new Promise((r) => setTimeout(r, 25));
        writeFileSync(${JSON.stringify(dataPath)}, JSON.stringify({ n: data.n + 1 }), 'utf8');
      }, { retryDelayMs: 5 });
    `;
    const scriptPath = join(tmp, 'bump.ts');
    writeFileSync(scriptPath, script, 'utf8');
    try {
      const procs = Array.from({ length: 3 }, () =>
        Bun.spawn({ cmd: ['bun', scriptPath], stdout: 'ignore', stderr: 'pipe' }),
      );
      const codes = await Promise.all(procs.map((p) => p.exited));
      expect(codes).toEqual([0, 0, 0]);
      expect(JSON.parse(readFileSync(dataPath, 'utf8'))).toEqual({ n: 3 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reclaims a stale lock whose holder PID is dead', async () => {
    const tmp = makeTmpDir('dead-pid');
    const lockPath = join(tmp, 'x.lock');
    try {
      // PID 4_000_000 exceeds darwin/linux PID ranges — never a live process.
      writeFileSync(lockPath, '4000000\n1999-01-01T00:00:00.000Z\n', 'utf8');
      backdate(lockPath, 60_000);
      const result = await withFileLock(lockPath, () => 'ok', {
        staleMs: 1_000,
        timeoutMs: 2_000,
        retryDelayMs: 5,
      });
      expect(result).toBe('ok');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reclaims an old lock with unparseable content', async () => {
    const tmp = makeTmpDir('garbage');
    const lockPath = join(tmp, 'x.lock');
    try {
      writeFileSync(lockPath, 'not-a-pid\n', 'utf8');
      backdate(lockPath, 60_000);
      const result = await withFileLock(lockPath, () => 'ok', {
        staleMs: 1_000,
        timeoutMs: 2_000,
        retryDelayMs: 5,
      });
      expect(result).toBe('ok');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects an old lock whose holder PID is alive', async () => {
    const tmp = makeTmpDir('live-pid');
    const lockPath = join(tmp, 'x.lock');
    try {
      // Our own PID is definitionally alive — age alone must not reclaim it.
      writeFileSync(lockPath, `${process.pid}\n1999-01-01T00:00:00.000Z\n`, 'utf8');
      backdate(lockPath, 60_000);
      await expect(
        withFileLock(lockPath, () => 'never', {
          staleMs: 1_000,
          timeoutMs: 300,
          retryDelayMs: 20,
        }),
      ).rejects.toThrow(FileLockTimeoutError);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects a fresh lock even when its holder is dead', async () => {
    const tmp = makeTmpDir('fresh-dead');
    const lockPath = join(tmp, 'x.lock');
    try {
      // Fresh mtime means the writer may be mid-rewrite — never steal early.
      writeFileSync(lockPath, '4000000\n2099-01-01T00:00:00.000Z\n', 'utf8');
      await expect(
        withFileLock(lockPath, () => 'never', {
          staleMs: 60_000,
          timeoutMs: 300,
          retryDelayMs: 20,
        }),
      ).rejects.toThrow(FileLockTimeoutError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

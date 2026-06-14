import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MACHINE_CONFIG_DIR_ENV_VAR,
  machineConfigBaseDir,
  machineConfigFilePath,
  readMachineConfig,
  resolveCloudToken,
  resolveDefaultContributor,
  setCloudToken,
  setDefaultContributor,
} from './machine-config';

/** Fresh tmp dir standing in for `~/.claude-prove` (the base-override seam). */
function makeBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'machine-config-'));
}

/** Write a legacy XDG config under `<base>/claude-prove/config.json`. */
function writeLegacyConfig(base: string, body: unknown): void {
  const dir = join(base, 'claude-prove');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(body), 'utf8');
}

describe('readMachineConfig', () => {
  test('returns an empty config when the file is absent', () => {
    const base = makeBaseDir();
    try {
      expect(readMachineConfig(base)).toEqual({ default_contributors: {} });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('backs a malformed file aside and returns an empty config', () => {
    const base = makeBaseDir();
    try {
      const path = machineConfigFilePath(base);
      writeFileSync(path, '{ this is not json', 'utf8');

      expect(readMachineConfig(base)).toEqual({ default_contributors: {} });

      // Original path no longer holds the corrupt bytes; a `.corrupt-*` sibling does.
      expect(existsSync(path)).toBe(false);
      const aside = readdirSync(base).filter((n) => n.includes('.corrupt-'));
      expect(aside.length).toBe(1);
      expect(readFileSync(join(base, aside[0] as string), 'utf8')).toBe('{ this is not json');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('machineConfigBaseDir', () => {
  test('env seam wins over the home default but loses to an explicit override', () => {
    const saved = process.env[MACHINE_CONFIG_DIR_ENV_VAR];
    try {
      process.env[MACHINE_CONFIG_DIR_ENV_VAR] = '/env/seam';
      expect(machineConfigBaseDir()).toBe('/env/seam');
      expect(machineConfigBaseDir('/explicit/override')).toBe('/explicit/override');

      delete process.env[MACHINE_CONFIG_DIR_ENV_VAR];
      expect(machineConfigBaseDir()).toContain('.claude-prove');
    } finally {
      if (saved === undefined) delete process.env[MACHINE_CONFIG_DIR_ENV_VAR];
      else process.env[MACHINE_CONFIG_DIR_ENV_VAR] = saved;
    }
  });
});

describe('setDefaultContributor', () => {
  test('writes atomically and round-trips through readMachineConfig', () => {
    const base = makeBaseDir();
    try {
      const key = setDefaultContributor('/repo/alpha', 'CT-aaaa', base);
      expect(key).toBe('/repo/alpha');

      const path = machineConfigFilePath(base);
      expect(existsSync(path)).toBe(true);
      // No tmp sibling left behind — the rename(2) consumed it.
      expect(readdirSync(base).filter((n) => n.endsWith('.tmp'))).toEqual([]);

      expect(readMachineConfig(base).default_contributors['/repo/alpha']).toBe('CT-aaaa');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('preserves unrelated top-level keys across a round-trip', () => {
    const base = makeBaseDir();
    try {
      const path = machineConfigFilePath(base);
      mkdirSync(base, { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          default_contributors: { '/repo/alpha': 'CT-aaaa' },
          future_key: { nested: ['preserved'] },
        }),
        'utf8',
      );

      setDefaultContributor('/repo/beta', 'CT-bbbb', base);

      const config = readMachineConfig(base);
      expect(config.default_contributors).toEqual({
        '/repo/alpha': 'CT-aaaa',
        '/repo/beta': 'CT-bbbb',
      });
      expect(config.future_key).toEqual({ nested: ['preserved'] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('resolveDefaultContributor', () => {
  test('returns null when the root is unmapped in both locations', () => {
    const base = makeBaseDir();
    const legacy = makeBaseDir();
    try {
      expect(resolveDefaultContributor('/repo/unmapped', base, legacy)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  test('resolves a legacy-only key via the fallback', () => {
    const base = makeBaseDir();
    const legacy = makeBaseDir();
    try {
      writeLegacyConfig(legacy, { default_contributors: { '/repo/alpha': 'CT-legacy' } });
      expect(resolveDefaultContributor('/repo/alpha', base, legacy)).toBe('CT-legacy');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  test('new location shadows legacy when both carry the key', () => {
    const base = makeBaseDir();
    const legacy = makeBaseDir();
    try {
      writeLegacyConfig(legacy, { default_contributors: { '/repo/alpha': 'CT-legacy' } });
      setDefaultContributor('/repo/alpha', 'CT-current', base);
      expect(resolveDefaultContributor('/repo/alpha', base, legacy)).toBe('CT-current');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(legacy, { recursive: true, force: true });
    }
  });
});

describe('cloud tokens', () => {
  test('setCloudToken round-trips through resolveCloudToken keyed by db name', () => {
    const base = makeBaseDir();
    try {
      setCloudToken('prove-acme', 'jwt-aaa', base);
      expect(resolveCloudToken('prove-acme', base)).toBe('jwt-aaa');
      // The token lives under cloud_tokens, not default_contributors.
      expect(readMachineConfig(base).cloud_tokens).toEqual({ 'prove-acme': 'jwt-aaa' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('resolveCloudToken returns null for an unprovisioned db', () => {
    const base = makeBaseDir();
    try {
      expect(resolveCloudToken('prove-missing', base)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a second db token is added without clobbering the first or the contributor map', () => {
    const base = makeBaseDir();
    try {
      setDefaultContributor('/repo/alpha', 'CT-aaaa', base);
      setCloudToken('prove-alpha', 'jwt-alpha', base);
      setCloudToken('prove-beta', 'jwt-beta', base);

      const config = readMachineConfig(base);
      expect(config.cloud_tokens).toEqual({
        'prove-alpha': 'jwt-alpha',
        'prove-beta': 'jwt-beta',
      });
      // The unrelated contributor mapping survived the token writes.
      expect(config.default_contributors).toEqual({ '/repo/alpha': 'CT-aaaa' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('overwriting a db token replaces it (re-provision / rotation)', () => {
    const base = makeBaseDir();
    try {
      setCloudToken('prove-acme', 'jwt-old', base);
      setCloudToken('prove-acme', 'jwt-new', base);
      expect(resolveCloudToken('prove-acme', base)).toBe('jwt-new');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

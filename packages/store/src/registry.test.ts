import { afterEach, describe, expect, test } from 'bun:test';
import { clearRegistry, getMigrations, listDomains, registerSchema } from './registry';

describe('schema registry', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('registerSchema + listDomains + getMigrations round-trip', () => {
    registerSchema({
      domain: 'alpha',
      migrations: [
        { version: 1, description: 'init alpha', up: () => {} },
        { version: 2, description: 'add index', up: () => {} },
      ],
    });
    registerSchema({
      domain: 'beta',
      migrations: [{ version: 1, description: 'init beta', up: () => {} }],
    });

    expect(listDomains()).toEqual(['alpha', 'beta']);

    const alphaMigs = getMigrations('alpha');
    expect(alphaMigs.map((m) => m.version)).toEqual([1, 2]);
    expect(alphaMigs.map((m) => m.description)).toEqual(['init alpha', 'add index']);
  });

  test('returns migrations sorted by version even when registered out of order', () => {
    registerSchema({
      domain: 'gamma',
      migrations: [
        { version: 3, description: 'third', up: () => {} },
        { version: 1, description: 'first', up: () => {} },
        { version: 2, description: 'second', up: () => {} },
      ],
    });
    expect(getMigrations('gamma').map((m) => m.version)).toEqual([1, 2, 3]);
  });

  test('throws on duplicate version within the same call', () => {
    expect(() =>
      registerSchema({
        domain: 'dup',
        migrations: [
          { version: 1, description: 'first', up: () => {} },
          { version: 1, description: 'collision', up: () => {} },
        ],
      }),
    ).toThrow("duplicate migration version 1 for domain 'dup'");
  });

  test('throws on duplicate version across separate registerSchema calls', () => {
    registerSchema({
      domain: 'cross',
      migrations: [{ version: 1, description: 'first', up: () => {} }],
    });
    expect(() =>
      registerSchema({
        domain: 'cross',
        migrations: [{ version: 1, description: 'second', up: () => {} }],
      }),
    ).toThrow("duplicate migration version 1 for domain 'cross'");
  });

  test('getMigrations returns a defensive copy', () => {
    registerSchema({
      domain: 'iso',
      migrations: [{ version: 1, description: 'one', up: () => {} }],
    });
    const first = getMigrations('iso');
    first.push({ version: 99, description: 'mutation', up: () => {} });
    expect(getMigrations('iso').map((m) => m.version)).toEqual([1]);
  });

  test('getMigrations for unknown domain returns empty array', () => {
    expect(getMigrations('unknown')).toEqual([]);
  });
});

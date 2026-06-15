/**
 * Reasoning-log model tests: round-trip every entry type through the strict
 * validator, episode derivation (incl. zero-decision), and strict rejection
 * of unknown types/fields and malformed per-type values.
 */

import { describe, expect, test } from 'bun:test';
import { type LogEntry, deriveEpisodes, parseLogEntry, validateLogEntry } from './reasoning-log';

// ---------------------------------------------------------------------------
// Fixture builders — one valid instance of each closed type
// ---------------------------------------------------------------------------

function envelope(type: string, id: string, ts: string): Record<string, unknown> {
  return { id, ts, type, agent: 'engineer', run_path: '.prove/runs/main/x', body: 'b' };
}

/** Look up `key`, asserting the entry exists (noUncheckedIndexedAccess). */
function pick<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`pick: no entry for key '${key}'`);
  return value;
}

function validEntries(): Record<string, Record<string, unknown>> {
  return {
    decision: {
      ...envelope('decision', 'd1', '2026-05-31T10:00:00Z'),
      alternatives: ['A', 'B'],
      selected_rationale: 'B is simpler',
    },
    discovery: envelope('discovery', 'disc1', '2026-05-31T10:01:00Z'),
    context: envelope('context', 'ctx1', '2026-05-31T10:01:30Z'),
    bailout: {
      ...envelope('bailout', 'bo1', '2026-05-31T10:02:00Z'),
      attempted: 'tried X',
      reason_abandoned: 'too slow',
    },
    hack: {
      ...envelope('hack', 'h1', '2026-05-31T10:03:00Z'),
      file_refs: ['src/a.ts'],
      cleanup_condition: 'before GA',
    },
    risk: {
      ...envelope('risk', 'r1', '2026-05-31T10:04:00Z'),
      severity: 'high',
      mitigation: 'add retry',
    },
    assumption: {
      ...envelope('assumption', 'a1', '2026-05-31T10:05:00Z'),
      resolved: false,
      resolution_ref: null,
    },
    synthesis: {
      ...envelope('synthesis', 's1', '2026-05-31T10:06:00Z'),
      outcome: 'shipped',
    },
    review_feedback: envelope('review_feedback', 'rf1', '2026-05-31T10:07:00Z'),
    verification: envelope('verification', 'v1', '2026-05-31T10:08:00Z'),
    capture: {
      ...envelope('capture', 'cap1', '2026-05-31T10:09:00Z'),
      tool: 'Write',
      target: 'packages/x.ts',
    },
  };
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('validateLogEntry — round-trip', () => {
  for (const [type, entry] of Object.entries(validEntries())) {
    test(`valid ${type} passes and round-trips through JSON`, () => {
      expect(validateLogEntry(entry)).toEqual([]);
      const parsed = parseLogEntry(JSON.parse(JSON.stringify(entry)));
      expect(parsed.type).toBe(type as LogEntry['type']);
      expect(parsed.id).toBe(entry.id as string);
    });
  }

  test('assumption accepts a resolved entry with a resolution_ref', () => {
    const e = {
      ...envelope('assumption', 'a2', '2026-05-31T11:00:00Z'),
      resolved: true,
      resolution_ref: 'd1',
    };
    expect(validateLogEntry(e)).toEqual([]);
  });

  test('capture accepts an entry with the optional target omitted', () => {
    const e = { ...envelope('capture', 'cap2', '2026-05-31T11:01:00Z'), tool: 'TodoWrite' };
    expect(validateLogEntry(e)).toEqual([]);
  });

  test('capture requires the tool field', () => {
    const { tool, ...e } = pick(validEntries(), 'capture');
    expect(validateLogEntry(e)).toContain("Missing required field for type 'capture': tool");
  });

  test('capture rejects a non-string target when present', () => {
    const e = { ...validEntries().capture, target: 42 };
    expect(validateLogEntry(e)).toContain("Invalid value for 'target' on type 'capture'");
  });
});

// ---------------------------------------------------------------------------
// Strict rejection
// ---------------------------------------------------------------------------

describe('validateLogEntry — strict rejection', () => {
  test('rejects non-object', () => {
    expect(validateLogEntry('nope')).toEqual(['Log entry must be a JSON object']);
  });

  test('rejects unknown type', () => {
    const e = envelope('musing', 'm1', '2026-05-31T10:00:00Z');
    expect(validateLogEntry(e).some((x) => x.includes("Invalid type 'musing'"))).toBe(true);
  });

  test('rejects unknown top-level field', () => {
    const e = { ...validEntries().discovery, sneaky: 1 };
    expect(validateLogEntry(e)).toContain("Unknown field 'sneaky' for type 'discovery'");
  });

  test('rejects unknown per-type field', () => {
    const e = { ...validEntries().decision, extra: true };
    expect(validateLogEntry(e)).toContain("Unknown field 'extra' for type 'decision'");
  });

  test('rejects missing per-type required field', () => {
    const { selected_rationale, ...e } = pick(validEntries(), 'decision');
    expect(validateLogEntry(e)).toContain(
      "Missing required field for type 'decision': selected_rationale",
    );
  });

  test('rejects wrong-typed per-type field', () => {
    const e = { ...validEntries().risk, severity: 'extreme' };
    expect(validateLogEntry(e)).toContain("Invalid value for 'severity' on type 'risk'");
  });

  test('rejects missing envelope field', () => {
    const { agent, ...e } = pick(validEntries(), 'discovery');
    expect(validateLogEntry(e)).toContain('Missing required field: agent');
  });

  test('rejects non-string envelope field', () => {
    const e = { ...validEntries().discovery, body: 42 };
    expect(validateLogEntry(e)).toContain("Field 'body' must be a string");
  });

  test('parseLogEntry throws on invalid', () => {
    expect(() => parseLogEntry({ type: 'nope' })).toThrow(/invalid log entry/);
  });
});

// ---------------------------------------------------------------------------
// Episode derivation
// ---------------------------------------------------------------------------

describe('deriveEpisodes', () => {
  function asList(...keys: string[]): LogEntry[] {
    const all = validEntries();
    return keys.map((k) => parseLogEntry(all[k]));
  }

  test('zero decisions => zero episodes', () => {
    expect(deriveEpisodes(asList('discovery', 'risk', 'hack'))).toEqual([]);
  });

  test('entries before first decision are dropped', () => {
    const eps = deriveEpisodes(asList('discovery', 'decision', 'risk'));
    expect(eps).toHaveLength(1);
    expect(eps[0]?.entries.map((e) => e.type)).toEqual(['risk']);
  });

  test('context is a non-decision entry that attaches to the open episode', () => {
    const eps = deriveEpisodes(asList('decision', 'context', 'synthesis'));
    expect(eps).toHaveLength(1);
    expect(eps[0]?.entries.map((e) => e.type)).toEqual(['context', 'synthesis']);
    expect(eps[0]?.closed_by?.type).toBe('synthesis');
  });

  test('decision opens, synthesis closes', () => {
    const eps = deriveEpisodes(asList('decision', 'hack', 'synthesis'));
    expect(eps).toHaveLength(1);
    expect(eps[0]?.entries.map((e) => e.type)).toEqual(['hack', 'synthesis']);
    expect(eps[0]?.closed_by?.type).toBe('synthesis');
  });

  test('a second decision closes the prior open episode', () => {
    const second = {
      ...validEntries().decision,
      id: 'd2',
      ts: '2026-05-31T12:00:00Z',
    };
    const list = [
      parseLogEntry(validEntries().decision),
      parseLogEntry(validEntries().risk),
      parseLogEntry(second),
    ];
    const eps = deriveEpisodes(list);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.closed_by?.type).toBe('decision');
    expect(eps[0]?.entries.map((e) => e.type)).toEqual(['risk']);
    expect(eps[1]?.entries).toEqual([]);
    expect(eps[1]?.closed_by).toBeNull();
  });

  test('entries after a synthesis-closed episode (no new decision) are dropped', () => {
    const tail = { ...validEntries().risk, id: 'r2', ts: '2026-05-31T13:00:00Z' };
    const list = [
      parseLogEntry(validEntries().decision),
      parseLogEntry(validEntries().synthesis),
      parseLogEntry(tail),
    ];
    const eps = deriveEpisodes(list);
    expect(eps).toHaveLength(1);
    expect(eps[0]?.entries.map((e) => e.type)).toEqual(['synthesis']);
  });
});

/**
 * Round 1b deterministic compression for PCD triage manifests.
 *
 * Ported 1:1 from `tools/pcd/collapse.py`. Reduces token usage by folding
 * low-risk, high-confidence cards into cluster summaries while preserving
 * full cards that need deep review in Round 2.
 *
 * Parity contract with the Python reference:
 *   - Preserve rules are byte-identical (risk >= medium OR confidence <= 3,
 *     except `status: "clean"` which always collapses).
 *   - `question_index` passes through with input key order preserved.
 *   - `compression_ratio` matches Python's repr() output — including the
 *     `.0` suffix for integer-valued floats. Use `serializeCollapsedManifest`
 *     for byte-equal JSON against Python captures.
 *
 * Known divergence (non-parity branch): when a card has no `cluster_id` the
 * Python fallback uses `hash(directory) % 10000`, which is non-deterministic
 * across interpreter runs (PEP 456). The TS port uses a stable FNV-1a 32-bit
 * hash so TS output is deterministic; parity fixtures MUST supply explicit
 * `cluster_id` on every card they feed into the collapse branch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural types mirroring TRIAGE_MANIFEST_SCHEMA and
 * COLLAPSED_MANIFEST_SCHEMA. Kept local until a later port promotes them
 * to `schemas.ts`; runtime correctness is enforced by `validateArtifact`.
 */
export type TriageCard = Record<string, unknown>;

export interface TriageManifest {
  version: number;
  stats: {
    files_reviewed: number;
    high_risk: number;
    medium_risk: number;
    low_risk: number;
    total_questions: number;
  };
  cards: TriageCard[];
  question_index: Array<Record<string, unknown>>;
}

export interface CollapsedSummary {
  cluster_id: number;
  file_count: number;
  files: string[];
  max_risk: string;
  aggregate_signals: string[];
}

export interface CollapsedManifest {
  version: number;
  stats: {
    total_cards: number;
    preserved: number;
    collapsed: number;
    compression_ratio: number;
  };
  preserved_cards: TriageCard[];
  collapsed_summaries: CollapsedSummary[];
  question_index: Array<Record<string, unknown>>;
}

type Finding = { brief?: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Risk ordering
// ---------------------------------------------------------------------------

const RISK_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const PRESERVE_RISK_THRESHOLD = 2; // >= medium is preserved
const PRESERVE_CONFIDENCE_THRESHOLD = 3; // <= 3 is preserved

// ---------------------------------------------------------------------------
// Preserve / collapse decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a triage card should be preserved in full.
 *
 * A card is preserved (not collapsed) if:
 *   - Its risk is >= medium (medium, high, or critical), OR
 *   - Its confidence is <= 3.
 *
 * Cards with `status === "clean"` are always collapsed regardless of risk
 * or confidence — the clean-bill format is already compressed.
 */
function shouldPreserve(card: TriageCard): boolean {
  if (card.status === 'clean') return false;

  const risk = typeof card.risk === 'string' ? card.risk : 'low';
  const riskLevel = RISK_ORDER[risk] ?? 1;
  if (riskLevel >= PRESERVE_RISK_THRESHOLD) return true;

  const confidence = typeof card.confidence === 'number' ? card.confidence : 5;
  if (confidence <= PRESERVE_CONFIDENCE_THRESHOLD) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Return the grouping key for a collapsed card.
 *
 * Uses `cluster_id` when present (preserves integer type for the downstream
 * `isinstance(key, int)` check). Otherwise falls back to the parent directory
 * of the card's `file` path — `"src/util.py"` -> `"src"`, `"util.py"` -> `"."`.
 */
function clusterKey(card: TriageCard): number | string {
  if ('cluster_id' in card) {
    const cid = card.cluster_id;
    if (typeof cid === 'number') return cid;
  }
  const filePath = typeof card.file === 'string' ? card.file : '';
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : '.';
}

/**
 * Return the highest risk from a list of risk strings. Empty list -> "low".
 */
function maxRisk(risks: string[]): string {
  if (risks.length === 0) return 'low';
  let best = risks[0] as string;
  let bestRank = RISK_ORDER[best] ?? 0;
  for (let i = 1; i < risks.length; i++) {
    const risk = risks[i] as string;
    const rank = RISK_ORDER[risk] ?? 0;
    if (rank > bestRank) {
      best = risk;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Collect deduplicated finding briefs from collapsed cards in insertion order.
 */
function aggregateSignals(cards: TriageCard[]): string[] {
  const seen = new Set<string>();
  const signals: string[] = [];
  for (const card of cards) {
    const findings = Array.isArray(card.findings) ? (card.findings as Finding[]) : [];
    for (const finding of findings) {
      const brief = typeof finding.brief === 'string' ? finding.brief : '';
      if (brief && !seen.has(brief)) {
        seen.add(brief);
        signals.push(brief);
      }
    }
  }
  return signals;
}

/**
 * FNV-1a 32-bit hash for the directory-fallback cluster key. Mirrors the
 * `hash(str) % 10000` fallback from the Python source but stays deterministic
 * across TS runs — Python's `hash()` is randomized by PYTHONHASHSEED and is
 * not replicable without bespoke SipHash code. Parity fixtures provide
 * `cluster_id` explicitly so this branch never runs during parity checks.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

function clusterIdFor(key: number | string): number {
  return typeof key === 'number' ? key : fnv1a32(key) % 10000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collapse low-risk triage cards to reduce token usage.
 *
 * @param manifest - Triage manifest produced by Round 1 (see TRIAGE_MANIFEST_SCHEMA).
 * @param tokenBudget - Approximate token target (stats-only, reserved for future use).
 * @returns Collapsed manifest conforming to COLLAPSED_MANIFEST_SCHEMA.
 */
export function collapseManifest(manifest: TriageManifest, _tokenBudget = 8000): CollapsedManifest {
  const cards = Array.isArray(manifest.cards) ? manifest.cards : [];
  const questionIndex = Array.isArray(manifest.question_index) ? manifest.question_index : [];

  const preserved: TriageCard[] = [];
  const toCollapse: TriageCard[] = [];
  for (const card of cards) {
    if (shouldPreserve(card)) {
      preserved.push(card);
    } else {
      toCollapse.push(card);
    }
  }

  // Group collapsed cards by cluster / directory. Python `defaultdict(list)`
  // preserves insertion order (3.7+); Map does the same, so the emitted
  // summary order mirrors the order in which keys were first encountered.
  const groups = new Map<number | string, TriageCard[]>();
  for (const card of toCollapse) {
    const key = clusterKey(card);
    const existing = groups.get(key);
    if (existing) {
      existing.push(card);
    } else {
      groups.set(key, [card]);
    }
  }

  const collapsedSummaries: CollapsedSummary[] = [];
  for (const [key, groupCards] of groups) {
    collapsedSummaries.push({
      cluster_id: clusterIdFor(key),
      file_count: groupCards.length,
      files: groupCards.map((c) => (typeof c.file === 'string' ? c.file : '')),
      max_risk: maxRisk(groupCards.map((c) => (typeof c.risk === 'string' ? c.risk : 'low'))),
      aggregate_signals: aggregateSignals(groupCards),
    });
  }

  const total = cards.length;
  const collapsedCount = toCollapse.length;
  const compressionRatio = total > 0 ? collapsedCount / total : 0.0;

  return {
    version: 1,
    stats: {
      total_cards: total,
      preserved: preserved.length,
      collapsed: collapsedCount,
      compression_ratio: compressionRatio,
    },
    preserved_cards: preserved,
    collapsed_summaries: collapsedSummaries,
    question_index: questionIndex,
  };
}

// ---------------------------------------------------------------------------
// Byte-parity JSON serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a collapsed manifest to JSON with Python-equivalent float
 * formatting — integer-valued floats render as `0.0` / `1.0` (Python
 * `repr()`), not JavaScript's `0` / `1`. The only float field in the
 * output is `stats.compression_ratio`; everything else is structural.
 *
 * Use with the same `indent` argument the Python captures were produced
 * with (the capture script passes `indent=2`).
 */
export function serializeCollapsedManifest(manifest: CollapsedManifest, indent = 2): string {
  const raw = JSON.stringify(manifest, null, indent);
  // Patch compression_ratio when it is an integer-valued float (0, 1, etc.).
  // The JSON text contains `"compression_ratio": 0` — rewrite to `0.0`.
  return raw.replace(/"compression_ratio":\s*(-?\d+)(?=[\s,}\n])/g, '"compression_ratio": $1.0');
}

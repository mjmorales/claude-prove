"""SQLite-backed storage for ACB manifests, documents, and review state.

Replaces loose JSON files in ``.prove/intents/`` and ``.prove/reviews/``
with a single ``.prove/acb.db`` file. All data is branch-scoped to
prevent stale cross-branch artifacts from confusing agents.

Usage::

    store = Store(".prove/acb.db")
    store.save_manifest("feat/auth", "abc1234", manifest_dict)
    manifests = store.list_manifests("feat/auth")
    store.save_acb("feat/auth", acb_dict)
    acb = store.load_acb("feat/auth")
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


_SCHEMA = """\
CREATE TABLE IF NOT EXISTS manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acb_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    acb_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manifests_branch ON manifests(branch);
CREATE INDEX IF NOT EXISTS idx_manifests_branch_sha ON manifests(branch, commit_sha);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    """Branch-scoped SQLite store for ACB data."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    # -- Manifests -----------------------------------------------------------

    def save_manifest(self, branch: str, commit_sha: str, data: dict) -> int:
        """Insert a manifest. Returns the new row ID."""
        ts = data.get("timestamp", _now())
        cur = self._conn.execute(
            "INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (branch, commit_sha, ts, json.dumps(data), _now()),
        )
        self._conn.commit()
        return cur.lastrowid  # type: ignore[return-value]

    def has_manifest(self, branch: str) -> bool:
        """Check if any manifest exists for *branch*."""
        cur = self._conn.execute(
            "SELECT 1 FROM manifests WHERE branch = ? LIMIT 1", (branch,)
        )
        return cur.fetchone() is not None

    def list_manifests(self, branch: str) -> list[dict]:
        """Return all manifests for *branch*, sorted by timestamp."""
        cur = self._conn.execute(
            "SELECT data FROM manifests WHERE branch = ? ORDER BY timestamp ASC",
            (branch,),
        )
        return [json.loads(row[0]) for row in cur.fetchall()]

    def clear_manifests(self, branch: str) -> int:
        """Delete all manifests for *branch*. Returns count deleted."""
        cur = self._conn.execute(
            "DELETE FROM manifests WHERE branch = ?", (branch,)
        )
        self._conn.commit()
        return cur.rowcount

    def clear_stale_manifests(self, keep_branch: str) -> int:
        """Delete manifests for all branches except *keep_branch*."""
        cur = self._conn.execute(
            "DELETE FROM manifests WHERE branch != ?", (keep_branch,)
        )
        self._conn.commit()
        return cur.rowcount

    # -- ACB Documents -------------------------------------------------------

    def save_acb(self, branch: str, data: dict) -> None:
        """Upsert an ACB document for *branch*."""
        now = _now()
        self._conn.execute(
            "INSERT INTO acb_documents (branch, data, created_at, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(branch) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (branch, json.dumps(data), now, now),
        )
        self._conn.commit()

    def load_acb(self, branch: str) -> dict | None:
        """Load the ACB document for *branch*, or None."""
        cur = self._conn.execute(
            "SELECT data FROM acb_documents WHERE branch = ?", (branch,)
        )
        row = cur.fetchone()
        return json.loads(row[0]) if row else None

    def latest_acb_branch(self) -> str | None:
        """Return the branch with the most recently updated ACB."""
        cur = self._conn.execute(
            "SELECT branch FROM acb_documents ORDER BY updated_at DESC LIMIT 1"
        )
        row = cur.fetchone()
        return row[0] if row else None

    # -- Review State --------------------------------------------------------

    def save_review(self, branch: str, acb_hash: str, data: dict) -> None:
        """Upsert review state for *branch*."""
        now = _now()
        self._conn.execute(
            "INSERT INTO review_state (branch, acb_hash, data, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(branch) DO UPDATE SET "
            "acb_hash = excluded.acb_hash, data = excluded.data, updated_at = excluded.updated_at",
            (branch, acb_hash, json.dumps(data), now, now),
        )
        self._conn.commit()

    def load_review(self, branch: str) -> dict | None:
        """Load review state for *branch*, or None."""
        cur = self._conn.execute(
            "SELECT data FROM review_state WHERE branch = ?", (branch,)
        )
        row = cur.fetchone()
        return json.loads(row[0]) if row else None

    # -- Cleanup -------------------------------------------------------------

    def clean_branch(self, branch: str) -> dict[str, int]:
        """Remove all data for *branch*. Returns counts per table."""
        counts = {}
        for table in ("manifests", "acb_documents", "review_state"):
            cur = self._conn.execute(
                f"DELETE FROM {table} WHERE branch = ?", (branch,)  # noqa: S608
            )
            counts[table] = cur.rowcount
        self._conn.commit()
        return counts

    def branches(self) -> list[str]:
        """Return all branches with any stored data."""
        result: set[str] = set()
        for table in ("manifests", "acb_documents", "review_state"):
            cur = self._conn.execute(f"SELECT DISTINCT branch FROM {table}")  # noqa: S608
            result.update(row[0] for row in cur.fetchall())
        return sorted(result)


def open_store(project_root: str | Path) -> Store:
    """Open the ACB store at the canonical location under *project_root*."""
    return Store(Path(project_root) / ".prove" / "acb.db")

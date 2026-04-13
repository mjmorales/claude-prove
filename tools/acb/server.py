"""Lightweight HTTP server for the ACB review UI.

Serves the static review app and a small JSON API for reading the
assembled ACB, posting verdicts, and fetching file diffs.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from acb.store import Store

STATIC_DIR = Path(__file__).resolve().parent / "static"


class ReviewHandler(BaseHTTPRequestHandler):
    """Route handler for the review server."""

    # Injected by ``serve()``.
    store: Store | None = None
    branch: str = ""
    project_root: str = ""
    base_ref: str = "main"

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: ARG002
        # Silence per-request access logs.
        pass

    # ── Routing ────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/api/review":
            self._serve_review()
        elif path.startswith("/api/diff"):
            self._serve_diff(parse_qs(parsed.query))
        elif path == "/api/health":
            self._json_response({"ok": True})
        elif path == "/" or path == "/index.html":
            self._serve_static("index.html")
        else:
            # Try serving a static file.
            self._serve_static(path.lstrip("/"))

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/verdict":
            self._handle_verdict()
        elif path == "/api/comment":
            self._handle_comment()
        elif path == "/api/overall":
            self._handle_overall()
        else:
            self._error(404, "Not found")

    # ── GET handlers ──────────────────────────────────────────────────

    def _serve_review(self) -> None:
        assert self.store is not None
        acb = self.store.load_acb(self.branch)
        if acb is None:
            self._error(404, "ACB document not found")
            return
        review = self.store.load_review(self.branch) or _empty_review(acb)
        self._json_response({"acb": acb, "review": review})

    def _serve_diff(self, qs: dict[str, list[str]]) -> None:
        file_path = (qs.get("path") or [""])[0]
        if not file_path:
            self._error(400, "Missing ?path= parameter")
            return
        try:
            result = subprocess.run(
                ["git", "diff", f"{self.base_ref}...HEAD", "--", file_path],
                capture_output=True,
                text=True,
                check=True,
                cwd=self.project_root,
            )
            self._json_response({"path": file_path, "diff": result.stdout})
        except subprocess.CalledProcessError as exc:
            self._error(500, f"git diff failed: {exc.stderr}")

    def _serve_static(self, rel_path: str) -> None:
        full = STATIC_DIR / rel_path
        if not full.is_file():
            self._error(404, "Not found")
            return
        content_type = _guess_type(full.suffix)
        data = full.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ── POST handlers ─────────────────────────────────────────────────

    def _handle_verdict(self) -> None:
        body = self._read_body()
        if body is None:
            return
        group_id = body.get("group_id")
        verdict = body.get("verdict")
        if not group_id or not verdict:
            self._error(400, "Missing group_id or verdict")
            return

        assert self.store is not None
        acb = self.store.load_acb(self.branch)
        if acb is None:
            self._error(404, "ACB not found")
            return

        review = self.store.load_review(self.branch) or _empty_review(acb)
        for v in review["group_verdicts"]:
            if v["group_id"] == group_id:
                v["verdict"] = verdict
                if "comment" in body:
                    v["comment"] = body["comment"]
                break

        review["updated_at"] = datetime.now(timezone.utc).isoformat()
        review["overall_verdict"] = _compute_overall(review)

        from acb.assembler import compute_acb_hash
        self.store.save_review(self.branch, compute_acb_hash(acb), review)
        self._json_response({"ok": True, "overall_verdict": review["overall_verdict"]})

    def _handle_comment(self) -> None:
        body = self._read_body()
        if body is None:
            return
        group_id = body.get("group_id")
        comment = body.get("comment", "")
        if not group_id:
            self._error(400, "Missing group_id")
            return

        assert self.store is not None
        acb = self.store.load_acb(self.branch)
        if acb is None:
            self._error(404, "ACB not found")
            return

        review = self.store.load_review(self.branch) or _empty_review(acb)
        for v in review["group_verdicts"]:
            if v["group_id"] == group_id:
                v["comment"] = comment
                break

        review["updated_at"] = datetime.now(timezone.utc).isoformat()

        from acb.assembler import compute_acb_hash
        self.store.save_review(self.branch, compute_acb_hash(acb), review)
        self._json_response({"ok": True})

    def _handle_overall(self) -> None:
        body = self._read_body()
        if body is None:
            return
        overall = body.get("overall_verdict")
        if not overall:
            self._error(400, "Missing overall_verdict")
            return

        assert self.store is not None
        acb = self.store.load_acb(self.branch)
        if acb is None:
            self._error(404, "ACB not found")
            return

        review = self.store.load_review(self.branch) or _empty_review(acb)
        review["overall_verdict"] = overall
        review["updated_at"] = datetime.now(timezone.utc).isoformat()

        from acb.assembler import compute_acb_hash
        self.store.save_review(self.branch, compute_acb_hash(acb), review)
        self._json_response({"ok": True})

    # ── Utilities ─────────────────────────────────────────────────────

    def _read_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._error(400, "Empty body")
            return None
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._error(400, "Invalid JSON")
            return None

    def _json_response(self, data: dict, status: int = 200) -> None:
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json_response({"error": message}, status=status)


# ── Module helpers ────────────────────────────────────────────────────────


def _empty_review(acb: dict) -> dict:
    """Create a blank review state document from an ACB."""
    content = json.dumps(acb, sort_keys=True, separators=(",", ":"))
    acb_hash = hashlib.sha256(content.encode()).hexdigest()
    return {
        "acb_version": acb.get("acb_version", "0.2"),
        "acb_hash": acb_hash,
        "acb_id": acb.get("id", ""),
        "reviewer": "web-ui",
        "group_verdicts": [
            {"group_id": g["id"], "verdict": "pending", "comment": "", "annotation_responses": []}
            for g in acb.get("intent_groups", [])
        ],
        "question_answers": [],
        "overall_verdict": "pending",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _compute_overall(review: dict) -> str:
    """Derive overall verdict from group verdicts."""
    verdicts = [v["verdict"] for v in review.get("group_verdicts", [])]
    if not verdicts:
        return "pending"
    if any(v == "rejected" for v in verdicts):
        return "changes_requested"
    if all(v == "accepted" for v in verdicts):
        return "approved"
    return "pending"


def _guess_type(suffix: str) -> str:
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
    }.get(suffix, "application/octet-stream")


def serve(
    store: Store,
    branch: str,
    project_root: str,
    base_ref: str = "main",
    port: int = 0,
) -> None:
    """Start the review server.

    Args:
        store: SQLite store instance.
        branch: Branch to serve the review for.
        project_root: Project root for ``git diff`` commands.
        base_ref: Base git ref for diffs (default: ``main``).
        port: Port to bind (0 = auto-assign).
    """
    ReviewHandler.store = store
    ReviewHandler.branch = branch
    ReviewHandler.project_root = project_root
    ReviewHandler.base_ref = base_ref

    server = HTTPServer(("127.0.0.1", port), ReviewHandler)
    actual_port = server.server_address[1]

    url = f"http://127.0.0.1:{actual_port}"
    print(f"ACB Review UI: {url}", file=sys.stderr)
    print(f"Reviewing: {branch}", file=sys.stderr)
    print("Press Ctrl+C to stop.\n", file=sys.stderr)

    # Print the URL to stdout so callers can capture it.
    print(url)
    sys.stdout.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.", file=sys.stderr)
    finally:
        server.server_close()

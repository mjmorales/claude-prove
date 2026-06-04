---
description: Launch the prove review UI as a loopback daemon for inspecting runs, ACB intent groups, and verdicts
argument-hint: "[--port 5174] [--stop] [--restart] [--status] [--no-open]"
core: true
summary: Loopback review UI for inspecting prove runs, ACB intent groups, and verdicts
---

# Review UI

Drive the prove review UI through the in-process daemon. `claude-prove review-ui serve` starts, stops, queries, and restarts a detached loopback server; its pidfile and log live under `~/.claude-prove/review-ui/`.

Default (no arguments): `serve start` → read the resolved port from its stdout → open the browser at that port.

## Precondition

Check this first. On failure, print the message and stop — do nothing else.

**`claude-prove` on PATH**: run `command -v claude-prove >/dev/null`. If it is missing, print:

> `claude-prove` CLI not found on PATH. Install via `curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash`. Dev-mode users: alias or symlink `claude-prove` to your working-tree entry point.

## Arguments

Parse `$ARGUMENTS`:

- `--stop` — `serve stop`, then exit. No start, no browser.
- `--status` — `serve status`, print the JSON, then exit. No start, no browser.
- `--restart` — `serve restart` instead of `serve start`.
- `--port <N>` — pin the listen port, bypassing machine-config resolution and the busy-port scan.
- `--no-open` — start (or restart) but do not open a browser.

Empty `$ARGUMENTS` runs the default start-and-open flow.

## Flow

### Stop

When `--stop` is set:

```bash
claude-prove review-ui serve stop
```

Report the outcome and exit.

### Status

When `--status` is set:

```bash
claude-prove review-ui serve status
```

`status` prints `{"running":<bool>,"pid":<int|null>,"port":<int>}` on stdout. Echo it, summarize whether the daemon is running, and exit.

### Start or restart

Pick the verb from the arguments — `serve restart` when `--restart` is set, otherwise `serve start`. Append `--port <N>` only when the user passed it.

```bash
claude-prove review-ui serve start            # or: serve restart
```

`start` resolves the repo root from the current directory, resolves the port (the machine-global `~/.claude-prove/config.json::review_ui_port`, then an upward scan past any busy port — a bump is warned on stderr), resolves the web bundle in the parent (a missing bundle warns on stderr and boots API-only), spawns the detached loopback child, and polls `/api/health` until it answers. On success it prints `{"running":true,"pid":<int>,"port":<int>}` on stdout. `restart` stops any recorded daemon first, then runs the same start path.

Read the `port` field from that stdout JSON — it is the authoritative port the daemon bound, which may differ from the requested one when the original was busy. Use it for the browser open and the report.

If the command exits non-zero and stderr reports `already running`, do not treat it as a failure — run `claude-prove review-ui serve status`, read the reported port, and open the browser there instead. For any other non-zero exit, surface its stderr (the health-poll timeout or spawn error) and stop. Inspect `~/.claude-prove/review-ui/review-ui.log` for the server's own output.

### Open browser

Unless `--no-open`, open the resolved port. Detect the platform via `uname -s`:

- macOS: `open "http://localhost:${PORT}"`
- Linux: `xdg-open "http://localhost:${PORT}" 2>/dev/null`
- Windows/WSL: `cmd.exe /c start "http://localhost:${PORT}"`

If the open fails, print the URL instead of erroring.

## Report

After a successful start or restart, print a short status block:

```
prove-review
  status:  running
  pid:     $PID
  port:    $PORT
  url:     http://localhost:$PORT

Stop:    /prove:review-ui --stop   (or: claude-prove review-ui serve stop)
Status:  claude-prove review-ui serve status
Logs:    ~/.claude-prove/review-ui/review-ui.log
```

Pull `$PID` and `$PORT` from the start command's stdout JSON. The review UI is one per-machine loopback daemon serving every registered project, so its port is machine-global. To pin a port across runs, set `~/.claude-prove/config.json` → `review_ui_port` (the daemon falls back to 5174 when unset).

## Notes

- The daemon outlives this Claude session. A later `serve start` finds the recorded pid alive and serving and refuses to double-start; reconnect by reading `serve status` and opening the reported port.
- State lives under `~/.claude-prove/review-ui/`: `review-ui.pid` records the server pid, `review-ui.log` carries its combined stdout/stderr. For server output, tail `review-ui.log` — never reach for container or external process logs, since the server runs in this daemon process.
- The server binds `127.0.0.1` only — it runs git against the operator's repo, so the listener must never be reachable off the loopback interface.
- Stop the daemon with `claude-prove review-ui serve stop` (SIGTERM + pidfile reap), never by killing the pid by hand — `stop` reaps the pidfile so the next start is clean.

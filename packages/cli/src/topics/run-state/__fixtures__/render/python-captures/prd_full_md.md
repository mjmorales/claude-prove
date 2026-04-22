# Port run_state to TypeScript

## Context

The run_state tool currently lives in Python. Port to TS to match the topic refactor.

## Goals

- Deprecate tools/run_state/
- Byte-equal JSON output across Python and TS

## Scope

**In scope**
- render.ts with full markdown parity
- Parity fixtures matching existing patterns

**Out of scope**
- Retiring the Python source (Task 7)
- Wiring into the CLI command (Task 5)

## Acceptance Criteria

- renderState/Plan/Prd/Report emit byte-identical markdown to Python
- renderSummary prints a single-line-block text summary
- renderCurrent dispatches JSON vs text per format flag

## Test Strategy

Parity fixtures capture both Python and TS output and assert byte-equality.

## Notes

Keep the timestamp helper aligned with Python's `datetime.utcnow().isoformat(timespec='seconds')`.

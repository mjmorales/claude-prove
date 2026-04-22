# PCD schema parity fixtures

Byte-for-byte parity captures of `tools/pcd/schemas.py::validate_artifact`
for the eight `SCHEMA_REGISTRY` keys. Each `python-captures/<name>.txt` is a
JSON envelope of the form:

```json
{
  "name": "<case>",
  "schema_key": "<one of the 8 keys>",
  "input": <data>,
  "ok": <bool>,
  "errors": [ "<path>: <message>", ... ]
}
```

`schemas.test.ts` iterates every `.txt` file in `python-captures/` and
asserts the TS `validateArtifact` returns the same `ok` and `errors`.

## Regenerating captures

Whenever `tools/pcd/schemas.py` or `packages/cli/src/topics/pcd/schemas.ts`
changes, re-run the capture script from the repo root:

```bash
bash packages/cli/src/topics/pcd/__fixtures__/schemas/capture.sh
```

This writes `cases.json` (the seed matrix) and regenerates every `.txt`
capture against the Python source. `python3` must be on `$PATH`.

## Adding cases

Edit the `cases.json` heredoc inside `capture.sh` and re-run. The seed
matrix covers valid + invalid inputs for all eight keys plus boundary
cases (missing required, enum mismatch, wrong scalar type, nested list
items, nested dict fields, bool-as-int, non-dict input, unknown key).

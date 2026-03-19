import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parseAcbDocument, parseReviewState } from "../parser.js";
import {
  validateAcbDocument,
  validateReviewState,
} from "../validator.js";
import type { AcbDocument, ReviewStateDocument, ValidationResult } from "../types.js";

export function runValidate(args: string[]): number {
  let filePath: string | undefined;
  let jsonOutput = false;
  let acbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--acb") {
      acbPath = args[++i];
    } else if (!arg.startsWith("-")) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error("Error: no file specified");
    console.error("Usage: acb validate <file> [--json] [--acb <path>]");
    return 2;
  }

  const resolvedPath = resolve(filePath);

  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch {
    console.error(`Error: file not found: ${resolvedPath}`);
    return 2;
  }

  const fileName = basename(resolvedPath);
  const isReview = fileName.endsWith(".acb-review.json");
  const isAcb = !isReview && fileName.endsWith(".acb.json");

  if (!isAcb && !isReview) {
    // Try to detect from content
    try {
      const obj = JSON.parse(content);
      if (obj.acb_hash !== undefined) {
        return validateReviewFile(content, resolvedPath, acbPath, jsonOutput);
      } else if (obj.intent_groups !== undefined) {
        return validateAcbFile(content, jsonOutput);
      }
    } catch {
      // Fall through
    }
    console.error(
      "Error: cannot determine file type. Expected .acb.json or .acb-review.json extension",
    );
    return 2;
  }

  if (isReview) {
    return validateReviewFile(content, resolvedPath, acbPath, jsonOutput);
  }
  return validateAcbFile(content, jsonOutput);
}

function validateAcbFile(content: string, jsonOutput: boolean): number {
  const parseResult = parseAcbDocument(content);
  if (!parseResult.ok) {
    if (jsonOutput) {
      console.log(JSON.stringify(parseResult.errors, null, 2));
    } else {
      for (const err of parseResult.errors) {
        console.error(`Parse error at ${err.path}: ${err.message}`);
      }
    }
    return 1;
  }

  const results = validateAcbDocument(parseResult.data);
  return outputResults(results, jsonOutput);
}

function validateReviewFile(
  content: string,
  resolvedPath: string,
  acbPath: string | undefined,
  jsonOutput: boolean,
): number {
  const parseResult = parseReviewState(content);
  if (!parseResult.ok) {
    if (jsonOutput) {
      console.log(JSON.stringify(parseResult.errors, null, 2));
    } else {
      for (const err of parseResult.errors) {
        console.error(`Parse error at ${err.path}: ${err.message}`);
      }
    }
    return 1;
  }
  const review: ReviewStateDocument = parseResult.data;

  // Find the referenced ACB document
  let acb: AcbDocument | undefined;

  if (acbPath) {
    try {
      const acbContent = readFileSync(resolve(acbPath), "utf-8");
      const acbParsed = parseAcbDocument(acbContent);
      if (!acbParsed.ok) {
        console.error(`Error parsing ACB file: ${acbParsed.errors[0].message}`);
        return 2;
      }
      acb = acbParsed.data;
    } catch {
      console.error(`Error: ACB file not found: ${acbPath}`);
      return 2;
    }
  } else {
    // Search same directory for an ACB file matching acb_id
    const dir = dirname(resolvedPath);
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".acb.json")) {
          try {
            const candidate = readFileSync(resolve(dir, f), "utf-8");
            const parsed = parseAcbDocument(candidate);
            if (parsed.ok && parsed.data.id === review.acb_id) {
              acb = parsed.data;
              break;
            }
          } catch {
            // Skip files that don't parse
          }
        }
      }
    } catch {
      // Directory read failed
    }
  }

  if (!acb) {
    console.error(
      `Error: could not find ACB document for acb_id="${review.acb_id}". Use --acb <path> to specify.`,
    );
    return 2;
  }

  const results = validateReviewState(review, acb);
  return outputResults(results, jsonOutput);
}

function outputResults(results: ValidationResult[], jsonOutput: boolean): number {
  const allValid = results.every((r) => r.valid);

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const status = r.valid ? "PASS" : "FAIL";
      console.log(`[${status}] ${r.rule}: ${r.message ?? "OK"}`);
    }
    console.log("");
    console.log(allValid ? "Result: VALID" : "Result: INVALID");
  }

  return allValid ? 0 : 1;
}

import { useEffect, useState } from "react";
import type { AcbDocument, ReviewStateDocument } from "@acb/core";
import type { ExtToWeb } from "../types.js";

export interface AcbState {
  acb: AcbDocument | null;
  review: ReviewStateDocument | null;
  error: string | null;
}

export function useAcb(): AcbState {
  const [acb, setAcb] = useState<AcbDocument | null>(null);
  const [review, setReview] = useState<ReviewStateDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtToWeb;
      switch (msg.type) {
        case "acb:load":
          setAcb(msg.acb);
          setReview(msg.review);
          setError(null);
          break;
        case "acb:error":
          setError(msg.message);
          break;
        case "acb:review-saved":
          // Could display a transient indicator
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return { acb, review, error };
}

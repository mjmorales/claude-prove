import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["run"] });
      qc.invalidateQueries({ queryKey: ["branches"] });
      qc.invalidateQueries({ queryKey: ["diff"] });
      qc.invalidateQueries({ queryKey: ["diff-file"] });
      qc.invalidateQueries({ queryKey: ["manifest"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["pending"] });
      qc.invalidateQueries({ queryKey: ["pending-file"] });
      qc.invalidateQueries({ queryKey: ["steps"] });
      qc.invalidateQueries({ queryKey: ["progress"] });
      qc.invalidateQueries({ queryKey: ["commits"] });
      qc.invalidateQueries({ queryKey: ["decisions"] });
      qc.invalidateQueries({ queryKey: ["doc"] });
      qc.invalidateQueries({ queryKey: ["intents"] });
      qc.invalidateQueries({ queryKey: ["review"] });
    });
    es.onerror = () => {
      // Let EventSource auto-reconnect.
    };
    return () => es.close();
  }, [qc]);
}

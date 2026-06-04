import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useActiveProject } from "../../lib/active-project";
import { useRunsSelection } from "./store";
import { renderDoc } from "./run-docs";
import { Markdown } from "../../components/Markdown";
import { PanelLoading } from "../../components/PanelLoading";
import { Empty } from "../../components/Empty";

/**
 * Reasoning-briefs viewer.
 *
 * ENDPOINT GAP: the server exposes no synthesized-brief or reasoning-log read
 * route. The reasoning log is written as per-entry JSON under
 * `.prove/runs/<branch>/<slug>/log/<agent>/<id>.json`, and the synthesized
 * Review Brief is rendered markdown that is not persisted to a run-dir path the
 * server reads. The run-doc allowlist only serves plan.json/prd.json/state.json.
 * So the closest narrative surface available through the locked read routes is
 * the run's PRD body — the human-authored requirements narrative. This panel
 * renders that and states the gap inline; wiring a real `/api/runs/:slug/brief`
 * (or `/log`) route belongs to a server-side task, not this read-only panel.
 */
export function BriefPanel() {
  const { projectKey } = useActiveProject();
  const slug = useRunsSelection((s) => s.slug);

  const { data, status } = useQuery({
    queryKey: ["doc", projectKey, slug, "prd.json"],
    queryFn: () => api.doc(slug!, "prd.json"),
    enabled: !!slug,
    retry: false,
    staleTime: 10_000,
  });

  if (!slug) return <Empty text="Select a run" />;
  if (status === "pending") return <PanelLoading label="LOADING BRIEF SOURCE" />;

  const prdMarkdown = data?.content ? renderDoc(data.content, "PRD") : "";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 h-8 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="label label-bright">REVIEW BRIEF</span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-dim">PRD NARRATIVE</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
        <div className="mb-4 rounded border border-amber/40 bg-amber/10 px-3 py-2 text-[11.5px] font-mono text-amber">
          No synthesized reasoning brief is exposed by the read API. Showing the run's PRD
          narrative as the closest available source.
        </div>
        {status === "error" || !prdMarkdown ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-10">
            <div className="label text-amber">NO PRD NARRATIVE YET</div>
            <div className="text-[11px] font-mono text-fg-dim max-w-sm">
              prd.json has no body for this run, or it is not yet written to{" "}
              <code className="text-phos bg-bg-panel px-1 border border-bg-line">
                .prove/runs/{slug}/prd.json
              </code>
              .
            </div>
          </div>
        ) : (
          <Markdown source={prdMarkdown} />
        )}
      </div>
    </div>
  );
}

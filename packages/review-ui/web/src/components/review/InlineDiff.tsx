import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { parseUnifiedDiff, type DiffLine } from "../../lib/diff";
import { cn } from "../../lib/cn";

export function InlineDiff({
  slug,
  base,
  head,
  path,
  height,
}: {
  slug: string;
  base: string;
  head: string;
  path: string;
  /** Fixed height in px. Omit for natural height (stacked layouts). */
  height?: number;
}) {
  const fixedHeight = typeof height === "number" ? { height } : undefined;
  const { data, isPending, isError } = useQuery({
    queryKey: ["rv-diff-file", slug, base, head, path],
    queryFn: () => api.diffFile(slug, base, head, path),
    enabled: !!path && !!base && !!head,
    retry: false,
  });

  if (isPending)
    return (
      <div
        className="flex items-center justify-center text-fg-dim text-[11px] font-mono"
        style={fixedHeight ?? { minHeight: 48 }}
      >
        DECODING DELTA…
      </div>
    );
  if (isError)
    return (
      <div
        className="flex items-center justify-center text-anom text-[11px] font-mono"
        style={fixedHeight ?? { minHeight: 48 }}
      >
        DELTA UNREACHABLE
      </div>
    );

  const parsed = data?.patch ? parseUnifiedDiff(data.patch) : null;
  if (!parsed || parsed.isBinary || parsed.hunks.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-fg-dim text-[11px] font-mono"
        style={fixedHeight ?? { minHeight: 48 }}
      >
        {parsed?.isBinary ? "BINARY FILE — NO PREVIEW" : "NO DELTA"}
      </div>
    );
  }

  return (
    <div
      className="font-mono text-[12.5px] leading-[1.55] overflow-auto scrollbar-thin bg-bg-void"
      style={fixedHeight}
    >
      {parsed.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="rv-hunk-header font-semibold">{h.header}</div>
          {h.lines.map((ln, li) => (
            <Line key={li} line={ln} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Line({ line }: { line: DiffLine }) {
  const cls =
    line.kind === "add" ? "rv-line-add" : line.kind === "del" ? "rv-line-del" : "rv-line-ctx";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div
      className={cn("grid grid-cols-[48px_48px_18px_1fr] px-2 whitespace-pre", cls)}
      style={{ tabSize: 4 }}
    >
      <span className="rv-gutter text-right tabular-nums pr-2">{line.oldN ?? ""}</span>
      <span className="rv-gutter text-right tabular-nums pr-2">{line.newN ?? ""}</span>
      <span className="rv-sign">{sign}</span>
      <span>{line.text}</span>
    </div>
  );
}

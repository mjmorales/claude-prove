import { useEffect, useRef, useState } from "react";

export function FixDrawer({
  open,
  groupTitle,
  initialNote,
  prompt,
  onCancel,
  onGenerate,
  generating,
}: {
  open: boolean;
  groupTitle: string;
  initialNote: string;
  prompt: string | null;
  onCancel: () => void;
  onGenerate: (note: string) => void;
  generating: boolean;
}) {
  const [note, setNote] = useState(initialNote);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setNote(initialNote);
      setCopied(false);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open, initialNote]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-bg-void/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div
        className="w-full max-w-3xl rack-in bg-bg-panel border border-bg-line rounded-lg overflow-hidden"
        style={{
          boxShadow:
            "0 0 0 1px rgba(255, 184, 108, 0.25), 0 28px 60px -28px rgba(255, 184, 108, 0.4)",
        }}
      >
        <div className="px-4 h-11 flex items-center justify-between border-b border-bg-line">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex items-center gap-2 text-amber">
              <span aria-hidden className="text-[14px]">↻</span>
              <span className="font-semibold text-[13px]">Rework</span>
            </span>
            <span className="font-mono text-[11.5px] text-fg-dim truncate max-w-[420px]">
              {groupTitle}
            </span>
          </div>
          <button onClick={onCancel} className="btn btn-subtle btn-sm">
            <span>Cancel</span>
            <span className="kbd">esc</span>
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-[1fr_1.3fr] gap-5">
          <div className="space-y-3">
            <label className="block text-[12px] font-medium text-fg-bright">Reviewer note</label>
            <textarea
              ref={ref}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  onGenerate(note.trim());
                }
              }}
              rows={10}
              placeholder="What must change? Be specific — this becomes the rework brief."
              className="w-full bg-bg-void border border-bg-line rounded-md px-3 py-2.5 font-mono text-[12.5px] text-fg-bright placeholder:text-fg-faint focus:outline-none focus:border-amber focus:ring-1 focus:ring-amber"
            />
            <button
              onClick={() => onGenerate(note.trim())}
              disabled={generating}
              className={`btn btn-warning btn-lg w-full ${generating ? "is-disabled" : ""}`}
            >
              <span>{generating ? "Composing…" : "Compose rework brief"}</span>
              {!generating && <span className="kbd kbd-on-solid">⌘↩</span>}
            </button>
            <p className="text-[11px] text-fg-dim leading-relaxed">
              Marks verdict <span className="text-amber font-medium">rework</span> and mints a
              paste-ready brief referencing the group's files and commits.
            </p>
          </div>

          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-medium text-fg-bright">Generated brief</span>
              {prompt && (
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(prompt);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  className="btn btn-ghost btn-sm"
                >
                  <span className={copied ? "text-ok" : undefined}>
                    {copied ? "Copied" : "Copy"}
                  </span>
                  <span className="kbd">c</span>
                </button>
              )}
            </div>
            <div
              className="flex-1 min-h-[260px] max-h-[420px] overflow-auto scrollbar-thin bg-bg-void border border-bg-line rounded-md p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-base"
            >
              {prompt ? (
                prompt
              ) : (
                <div className="h-full flex items-center justify-center text-fg-dim text-center">
                  Compose a reviewer note to generate the brief.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

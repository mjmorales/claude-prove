import { useEffect, useRef, useState } from "react";

export function DiscussDrawer({
  open,
  groupTitle,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  groupTitle: string;
  initial: string;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setNote(initial);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open, initial]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-bg-void/80 backdrop-blur-sm flex items-end md:items-center justify-center p-6">
      <div
        className="w-full max-w-xl rack-in bg-bg-panel border border-bg-line rounded-lg overflow-hidden"
        style={{ boxShadow: "0 0 0 1px rgba(139, 233, 253, 0.25), 0 28px 60px -28px rgba(139, 233, 253, 0.35)" }}
      >
        <div className="px-4 h-11 flex items-center justify-between border-b border-bg-line">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex items-center gap-2 text-data">
              <span aria-hidden className="text-[14px]">?</span>
              <span className="font-semibold text-[13px]">Discuss</span>
            </span>
            <span className="font-mono text-[11.5px] text-fg-dim truncate max-w-[360px]">
              {groupTitle}
            </span>
          </div>
          <button onClick={onCancel} className="btn btn-subtle btn-sm">
            <span>Cancel</span>
            <span className="kbd">esc</span>
          </button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-[12px] font-medium text-fg-bright">
            Note for the author
          </label>
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
                if (note.trim()) onSubmit(note.trim());
              }
            }}
            rows={6}
            placeholder="What needs to be discussed before this lands?"
            className="w-full bg-bg-void border border-bg-line rounded-md px-3 py-2.5 font-mono text-[12.5px] text-fg-bright placeholder:text-fg-faint focus:outline-none focus:border-data focus:ring-1 focus:ring-data"
          />
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-fg-faint">
              <span className="kbd">⌘↩</span> submit <span className="mx-1">·</span>{" "}
              <span className="kbd">esc</span> cancel
            </span>
            <button
              onClick={() => note.trim() && onSubmit(note.trim())}
              disabled={!note.trim()}
              className={`btn btn-info ${!note.trim() ? "is-disabled" : ""}`}
            >
              <span>Mark as discuss</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

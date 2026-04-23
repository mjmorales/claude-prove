import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

type Key = string;

const STORAGE_KEY = "prove-review.sidebar-sections.v1";

function loadOpen(defaults: Record<Key, boolean>): Record<Key, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<Key, boolean>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveOpen(state: Record<Key, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* noop */
  }
}

export type SidebarSection = {
  key: Key;
  title: string;
  /** Optional short count / badge shown beside the title. */
  badge?: ReactNode;
  /** Shown in the header's right side (e.g. filter input). */
  trailing?: ReactNode;
  /** Renders only when the section is open. */
  body: ReactNode;
  defaultOpen?: boolean;
  /** Whether the body should flex-grow. Default false (auto-size). */
  grow?: boolean;
};

export function Sidebar({ sections }: { sections: SidebarSection[] }) {
  const defaults: Record<Key, boolean> = {};
  for (const s of sections) defaults[s.key] = s.defaultOpen ?? true;
  const [open, setOpen] = useState<Record<Key, boolean>>(() => loadOpen(defaults));

  useEffect(() => {
    saveOpen(open);
  }, [open]);

  const toggle = (key: Key) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-panel">
      {sections.map((s, i) => {
        const isOpen = open[s.key] ?? true;
        return (
          <section
            key={s.key}
            className={cn(
              "flex flex-col min-h-0",
              i > 0 && "border-t border-bg-line",
              isOpen && s.grow && "flex-1",
              isOpen && !s.grow && "shrink-0",
              !isOpen && "shrink-0",
            )}
          >
            <button
              onClick={() => toggle(s.key)}
              className="shrink-0 flex items-center gap-2 h-9 px-3 bg-bg-deep hover:bg-bg-raised transition-colors text-left"
            >
              <span
                className="text-fg-faint text-[11px] transition-transform"
                style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
              >
                ▸
              </span>
              <span className="font-semibold text-fg-bright text-[13px]">{s.title}</span>
              {s.badge !== undefined && (
                <span className="mono text-[11.5px] text-fg-faint tabular-nums">{s.badge}</span>
              )}
              {s.trailing && (
                <span className="ml-auto flex items-center" onClick={(e) => e.stopPropagation()}>
                  {s.trailing}
                </span>
              )}
            </button>
            {isOpen && (
              <div className={cn("min-h-0 flex-1 overflow-hidden", s.grow && "flex flex-col")}>
                {s.body}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

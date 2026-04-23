import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export function Frame({
  title,
  subtitle,
  right,
  children,
  className,
  tone = "default",
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "default" | "phos" | "amber" | "anom" | "data";
}) {
  return (
    <section
      className={cn(
        "flex flex-col min-h-0 bg-bg-panel border border-bg-line rounded-md overflow-hidden",
        tone === "phos" && "border-phos/35",
        tone === "amber" && "border-amber/35",
        tone === "anom" && "border-anom/35",
        tone === "data" && "border-data/35",
        className,
      )}
    >
      <header className="shrink-0 flex items-center gap-3 px-3 h-8 bg-bg-deep border-b border-bg-line">
        <div
          className={cn(
            "label",
            tone === "phos" && "label-phos",
            tone === "amber" && "text-amber",
            tone === "anom" && "text-anom",
            tone === "data" && "text-data",
            tone === "default" && "label-bright",
          )}
        >
          {title}
        </div>
        {subtitle && (
          <div className="text-[10.5px] font-mono text-fg-dim truncate">{subtitle}</div>
        )}
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </section>
  );
}

export function FrameSection({
  label,
  count,
  children,
  tone,
}: {
  label: string;
  count?: number | string;
  children: ReactNode;
  tone?: "phos" | "amber" | "anom" | "data";
}) {
  return (
    <div className="border-b border-bg-line">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-deep/60">
        <div
          className={cn(
            "label",
            tone === "phos" && "label-phos",
            tone === "amber" && "text-amber",
            tone === "anom" && "text-anom",
            tone === "data" && "text-data",
          )}
        >
          {label}
        </div>
        {typeof count !== "undefined" && (
          <span className="font-mono text-[10.5px] text-fg-dim">[{count}]</span>
        )}
      </div>
      {children}
    </div>
  );
}

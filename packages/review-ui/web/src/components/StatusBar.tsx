import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";

export function StatusBar() {
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const head = useSelection((s) => s.head);
  const base = useSelection((s) => s.base);
  const filePath = useSelection((s) => s.filePath);
  const sha = useSelection((s) => s.commitSha);
  const pending = useSelection((s) => s.pendingMode);

  return (
    <footer className="shrink-0 h-7 bg-bg-deep border-t border-bg-line flex items-stretch text-[11px] font-mono">
      <Cell icon="⎇" value={slug ?? "—"} mono />
      {branch && <Cell icon="⎇" value={branch} mono color="text-data" />}
      {pending ? (
        <Cell icon="●" value="Pending changes" color="text-amber" />
      ) : sha ? (
        <Cell icon="◈" value={sha.slice(0, 10)} color="text-data" mono />
      ) : base && head ? (
        <Cell icon="↔" value={`${shortRef(base)} → ${shortRef(head)}`} mono />
      ) : null}
      {filePath && <Cell icon="▸" value={filePath} grow mono color="text-fg-bright" />}

      <div className="ml-auto flex items-stretch text-fg-faint">
        <Hint k="⇧R" v="Review" />
        <Hint k="⌘K" v="Commands" />
        <Hint k="?" v="Help" />
      </div>
    </footer>
  );
}

function Cell({
  icon,
  value,
  color,
  mono,
  grow,
}: {
  icon?: string;
  value: string;
  color?: string;
  mono?: boolean;
  grow?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 min-w-0",
        grow && "flex-1",
      )}
    >
      {icon && <span className="text-fg-faint text-[11px]">{icon}</span>}
      <span
        className={cn(
          "truncate",
          mono && "font-mono",
          color ?? "text-fg-base",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Hint({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 border-l border-bg-line">
      <span className="kbd">{k}</span>
      <span className="text-fg-dim">{v}</span>
    </div>
  );
}

function shortRef(r: string): string {
  if (/^[0-9a-f]{7,40}\^?$/.test(r)) return r.slice(0, 10);
  return r.length > 22 ? r.slice(0, 22) + "…" : r;
}

import { useEffect, useMemo, useState } from "react";
import type { FileChange } from "../lib/api";
import { cn } from "../lib/cn";
import { PALETTE } from "./review/verdictTokens";

type TreeNode = {
  name: string;
  path: string;
  dir: boolean;
  /** Only set on leaves. */
  file?: FileChange;
  children: TreeNode[];
  insertions: number;
  deletions: number;
};

/**
 * Group files by directory into a trie. Nodes at the same level are sorted:
 * directories first, then files, both alphabetically.
 */
function buildTree(files: FileChange[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    dir: true,
    children: [],
    insertions: 0,
    deletions: 0,
  };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      let next = cur.children.find((c) => c.name === name && c.dir === !isLeaf);
      if (!next) {
        next = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          dir: !isLeaf,
          children: [],
          insertions: 0,
          deletions: 0,
          file: isLeaf ? f : undefined,
        };
        cur.children.push(next);
      }
      cur.insertions += f.insertions;
      cur.deletions += f.deletions;
      if (isLeaf) {
        next.insertions += f.insertions;
        next.deletions += f.deletions;
      }
      cur = next;
    }
  }
  sort(root);
  return root.children;
}

function sort(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.dir) sort(c);
}

/**
 * Collapse single-child directories into slash-separated compound names:
 *   internal / lex / scanner.go  →  internal/lex
 *                                   └── scanner.go
 * Keeps the leaf, compresses the chain above it.
 */
function collapseChains(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (!n.dir) {
      out.push(n);
      continue;
    }
    let cur = n;
    while (cur.children.length === 1 && cur.children[0].dir) {
      const only = cur.children[0];
      cur = {
        ...cur,
        name: `${cur.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    out.push({ ...cur, children: collapseChains(cur.children) });
  }
  return out;
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: FileChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => collapseChains(buildTree(files)), [files]);
  return (
    <div className="py-1">
      {tree.map((n) => (
        <TreeItem
          key={n.path || n.name}
          node={n}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  // Auto-expand the ancestor chain of the selected path.
  useEffect(() => {
    if (node.dir && selectedPath && selectedPath.startsWith(node.path + "/")) {
      setOpen(true);
    }
  }, [selectedPath, node]);

  const indent = { paddingLeft: `${12 + depth * 14}px` };

  if (node.dir) {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full text-left flex items-center gap-2 py-1 pr-3 text-[12.5px] text-fg-base hover:bg-bg-raised/60 transition-colors"
          style={indent}
        >
          <span
            className="text-[10px] text-fg-faint inline-block transition-transform shrink-0"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▸
          </span>
          <span className="text-phos text-[12px] shrink-0">▸</span>
          <span className="font-mono truncate flex-1">{node.name}</span>
          <span className="text-[11px] text-fg-faint tabular-nums shrink-0">
            {count(node)}
          </span>
        </button>
        {open && (
          <div>
            {node.children.map((c) => (
              <TreeItem
                key={c.path || c.name}
                node={c}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const f = node.file!;
  const active = selectedPath === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={cn(
        "w-full text-left flex items-center gap-2 py-1 pr-3 font-mono text-[12.5px] border-l-2 transition-colors",
        active
          ? "bg-bg-raised border-l-phos text-fg-bright"
          : "border-l-transparent hover:bg-bg-raised/50 text-fg-base",
      )}
      style={indent}
    >
      <StatusGlyph status={f.status} />
      <span className="truncate flex-1">{node.name}</span>
      {f.binary ? (
        <span className="text-[10.5px] text-fg-faint">bin</span>
      ) : (
        <span className="text-[11px] tabular-nums whitespace-nowrap shrink-0">
          <span className="text-ok">+{f.insertions}</span>
          <span className="text-fg-faint mx-0.5">·</span>
          <span className="text-anom">−{f.deletions}</span>
        </span>
      )}
    </button>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const key = status[0] ?? "M";
  const map: Record<string, { glyph: string; color: string }> = {
    A: { glyph: "+", color: PALETTE.status.added },
    M: { glyph: "M", color: PALETTE.status.modified },
    D: { glyph: "−", color: PALETTE.status.deleted },
    R: { glyph: "R", color: PALETTE.status.renamed },
  };
  const m = map[key] ?? { glyph: key, color: PALETTE.accent.neutral };
  return (
    <span
      className="w-4 h-4 text-[11px] font-bold font-mono shrink-0 flex items-center justify-center rounded-sm"
      style={{ color: m.color, background: `${m.color}18` }}
    >
      {m.glyph}
    </span>
  );
}

function count(n: TreeNode): string {
  // Count leaves under this subtree.
  let c = 0;
  const walk = (x: TreeNode) => {
    if (x.dir) for (const ch of x.children) walk(ch);
    else c++;
  };
  walk(n);
  return String(c);
}

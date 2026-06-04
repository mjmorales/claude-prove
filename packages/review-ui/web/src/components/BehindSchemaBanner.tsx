import { useActiveProject } from "../lib/active-project";

/**
 * Write controls across the app must go read-only when the active project's
 * store sits behind the server's expected schema — writing through a stale
 * schema risks corrupting records the server can no longer interpret. This hook
 * is the single seam panels read to gate their write affordances: it returns
 * true exactly when the active project reports `store.behind === true`.
 *
 * Feature panels (verdict bars, scrum mutations, fix/discuss drawers) call this
 * and OR it into their `disabled` state. The banner below renders from the same
 * signal so the disabled controls always have a visible explanation.
 */
export function useWriteAffordancesDisabled(): boolean {
  const { project } = useActiveProject();
  return project?.store.behind === true;
}

/**
 * Prominent read-only banner shown in the shell whenever the active project's
 * store is behind schema. Pairs with `useWriteAffordancesDisabled` so the
 * operator sees why write controls are inert.
 */
export function BehindSchemaBanner() {
  const { project } = useActiveProject();
  if (project?.store.behind !== true) return null;

  const version = project.store.schema_version;
  return (
    <div
      role="alert"
      className="shrink-0 flex items-center gap-3 px-4 h-9 bg-amber/15 border-b border-amber/40 text-[12.5px]"
    >
      <span className="text-amber text-[13px] leading-none">⚠</span>
      <span className="text-amber-bright font-medium">Read-only</span>
      <span className="text-fg-dim">
        {project.name} sits behind the expected store schema
        {version !== null ? ` (v${version})` : ""} — write controls are disabled until it is
        migrated.
      </span>
    </div>
  );
}

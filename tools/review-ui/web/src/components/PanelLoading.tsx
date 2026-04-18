/**
 * Shared loading indicator for panels. Replaces empty-state flashes during
 * React Query fetches so users don't read a momentary "nothing exists" panel
 * as a broken tab.
 */
export function PanelLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-dim">
      <div className="spinner" aria-hidden />
      <div className="flex items-center gap-2 text-[12.5px]">
        <span>{label}</span>
        <span className="dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

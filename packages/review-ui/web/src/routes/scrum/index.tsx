/**
 * Scrum dashboard placeholder. Real UI lands in phase 12; this stub exists so
 * routing can be wired up now without blocking the ACB refactor.
 */
export function ScrumRoute() {
  return (
    <div className="h-full flex items-center justify-center bg-bg-void text-fg-base">
      <div className="max-w-xl px-6 py-8 text-center">
        <h1 className="text-2xl font-semibold text-fg-bright mb-3">Scrum dashboard</h1>
        <p className="text-fg-faint mb-4">
          The scrum dashboard ships in phase 12. This route is reserved so the /scrum URL resolves
          cleanly while the ACB review UI (see /acb) remains the default experience.
        </p>
        <a
          href="https://github.com/mjmorales/claude-prove/blob/main/.prove/decisions/2026-04-21-scrum-architecture.md"
          target="_blank"
          rel="noreferrer"
          className="text-phos hover:underline"
        >
          Read the scrum architecture decision (.prove/decisions/2026-04-21-scrum-architecture.md)
        </a>
      </div>
    </div>
  );
}

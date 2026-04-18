export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40 bg-bg-void/80 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="rack-in bg-bg-panel border border-bg-line rounded-lg max-w-md w-full shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 px-5 flex items-center justify-between border-b border-bg-line">
          <span className="font-semibold text-[13px] text-fg-bright">Keyboard shortcuts</span>
          <button onClick={onClose} className="btn btn-subtle btn-sm" title="Close">
            <span>Close</span>
            <span className="kbd">esc</span>
          </button>
        </div>
        <div className="p-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[12.5px]">
          <Row k="j k" v="Next · previous group" />
          <Row k="g G" v="First · last group" />
          <Row k="a" v="Approve" />
          <Row k="r" v="Reject" />
          <Row k="d" v="Discuss — opens drawer" />
          <Row k="f" v="Rework — opens fix drawer" />
          <Row k="u" v="Undo verdict" />
          <Row k="v" v="Toggle diff preview" />
          <Row k="e" v="Exit review" />
          <Row k="?" v="This map" />
        </div>
        <div className="px-5 pb-5 text-[11.5px] text-fg-dim leading-relaxed">
          Verdicts persist to <code className="mono text-phos">.prove/acb.db</code>. Implicit
          groups (no manifest) show a hazard rail on the card.
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  const keys = k.split(/\s+/);
  return (
    <>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <span key={i} className="kbd">
            {key}
          </span>
        ))}
      </div>
      <div className="text-fg-base">{v}</div>
    </>
  );
}

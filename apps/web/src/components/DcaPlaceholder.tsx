/**
 * Visible-but-empty DCA tab. Communicates that recurring orders are on the
 * roadmap (Phase 5) without forcing users to read a separate roadmap doc.
 * Replace with the real form when DCA ships.
 */
export function DcaPlaceholder() {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-8 text-center text-sm">
      <div className="mb-2 text-slate-300">📅 DCA — Dollar Cost Averaging</div>
      <p className="mx-auto max-w-xs text-xs text-slate-500">
        Recurring orders on a fixed schedule (1h / 1d / 1w). Ships in Phase 5 —
        no action needed from your side yet.
      </p>
    </div>
  );
}

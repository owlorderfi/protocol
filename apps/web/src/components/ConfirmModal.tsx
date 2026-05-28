import { useEffect, useState, type ReactNode } from 'react';

interface BaseProps {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warn' | 'neutral';
  isSubmitting?: boolean;
  submittingLabel?: string;
  error?: string | null;
  /**
   * High-stakes guard: the user has to type this exact word before the
   * confirm button enables. Skipped when omitted.
   */
  typeToConfirm?: string;
  /**
   * Optional caller-managed gate on top of typeToConfirm. Useful when the
   * body has a custom acknowledgment widget (checkbox, slider, etc.) and
   * the parent wants to block confirm until its own state is satisfied.
   */
  extraDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Generic modal used by admin action forms. Centered overlay with
 * backdrop, escape-to-close, and an optional type-to-confirm guard
 * for irreversible / high-blast-radius actions (pause, fee recipient
 * change). Tone changes button color: danger=rose, warn=amber,
 * neutral=cyan.
 *
 * Doesn't manage its own visibility — parent controls `open`. Body
 * content is fully owned by the caller: pass any form/inputs/etc
 * needed for the action.
 */
export function ConfirmModal({
  open,
  onClose,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'neutral',
  isSubmitting = false,
  submittingLabel,
  error,
  typeToConfirm,
  extraDisabled = false,
  onConfirm,
}: BaseProps) {
  const [typed, setTyped] = useState('');

  // Reset the type-to-confirm field every time the modal opens so a
  // re-open with a different action doesn't carry stale text.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  // Escape to close. Don't fire while submitting — user clicking
  // outside accidentally shouldn't abort a pending tx.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isSubmitting, onClose]);

  if (!open) return null;

  const confirmDisabled =
    isSubmitting ||
    extraDisabled ||
    (typeToConfirm !== undefined && typed !== typeToConfirm);

  const toneClass =
    tone === 'danger' ? 'bg-rose-500 hover:bg-rose-400 text-slate-950'
    : tone === 'warn' ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
    : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      // Click backdrop closes — but again only when idle.
      onClick={() => { if (!isSubmitting) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        <div className="mt-3 text-sm text-slate-300 space-y-2">{body}</div>

        {typeToConfirm !== undefined && (
          <label className="mt-4 block">
            <span className="text-xs uppercase tracking-wider text-slate-400">
              Type <span className="font-mono text-slate-200">{typeToConfirm}</span> to confirm
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={isSubmitting}
              autoFocus
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            />
          </label>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-rose-900/50 bg-rose-950/40 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => { void onConfirm(); }}
            disabled={confirmDisabled}
            className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-30 ${toneClass}`}
          >
            {isSubmitting ? (submittingLabel ?? 'Submitting…') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

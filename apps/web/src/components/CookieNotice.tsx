/**
 * Cookie / browser-storage notice banner.
 *
 * EU ePrivacy Directive Art. 5(3) carves out "strictly necessary"
 * storage from the consent-button requirement — and everything
 * OwlOrderFi stores in localStorage falls in that bucket (auth
 * session, UI preferences, legal ack records). So the user-facing
 * UX is a one-shot dismissible notice, not a consent gate with
 * accept/reject buttons.
 *
 * The full enumeration of what we store + the third-party wallet
 * libraries that may load resources on wallet connect lives in the
 * LegalDisclaimer modal's "Browser storage & third parties" section,
 * reachable via the "Details" link below.
 */

import { useEffect, useState } from 'react';

const ACK_LS_KEY = 'polyorder.cookieAck.v1';

interface Props {
  /** Pass the LegalDisclaimer's open-modal handler so "Details" jumps
   *  straight to the long-form explanation without forcing the user to
   *  hunt for it in the footer. */
  onOpenDetails: () => void;
}

export function CookieNotice({ onOpenDetails }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem(ACK_LS_KEY)) setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(ACK_LS_KEY, new Date().toISOString());
    }
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Browser storage notice"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-700 bg-slate-900/95 px-6 py-3 shadow-lg backdrop-blur"
    >
      <div className="mx-auto flex max-w-4xl flex-col items-center justify-between gap-3 text-sm text-slate-300 sm:flex-row">
        <p className="text-center sm:text-left">
          We store essential preferences in your browser's{' '}
          <span className="font-mono text-slate-200">localStorage</span> so
          the app remembers your sign-in and settings. No analytics, no
          tracking, no ads.{' '}
          <button
            type="button"
            onClick={onOpenDetails}
            className="text-cyan-400 underline-offset-2 hover:text-cyan-300 hover:underline"
          >
            Details
          </button>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-lg bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

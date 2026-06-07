/**
 * In-app legal surface — ack moment + always-on footer band.
 *
 * Single source of truth for both Terms and Privacy is the static pages
 * at /terms and /privacy (built from apps/web/landing/). The app does
 * NOT duplicate the long-form text — it links out. This eliminates the
 * old drift between the modal copy and the landing pages.
 *
 * Two surfaces remain inside the SPA:
 *
 *   1. A first-visit ack modal: short notice + links to /terms and
 *      /privacy + a single checkbox confirming the user has read both
 *      and isn't in a restricted jurisdiction. localStorage flag
 *      suppresses subsequent auto-opens.
 *   2. A persistent footer band with the abridged "no-custody / no-
 *      advice / your responsibility" sentence and direct links to the
 *      two pages — opened in new tabs so the user doesn't lose their
 *      session.
 *
 * ACK_LS_KEY is bumped to v2 because v1 acked a modal that contained
 * the full legal text inline. With the move to link-out, a user who
 * acked v1 never saw the new short notice; re-acking once is the
 * minimum-friction way to record that they've seen this version of
 * the consent moment.
 */

import { useEffect, useState } from 'react';
import { CookieNotice } from './CookieNotice';

const ACK_LS_KEY = 'polyorder.legalAck.v2';

export function LegalDisclaimer() {
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem(ACK_LS_KEY)) setShowModal(true);
  }, []);

  const ack = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(ACK_LS_KEY, new Date().toISOString());
    }
    setShowModal(false);
  };

  return (
    <>
      <LegalFooter />
      <CookieNotice />
      {showModal && <LegalModal onAck={ack} onClose={() => setShowModal(false)} />}
    </>
  );
}

function LegalFooter() {
  // Abridged legal band, always visible. Terms / Privacy are the source-
  // of-truth pages at /terms and /privacy; opened in new tabs so the
  // user doesn't lose their SPA state.
  return (
    <footer className="border-t border-slate-800 bg-slate-950/80 px-6 py-4 text-center text-sm text-slate-400">
      <p className="mx-auto max-w-3xl leading-relaxed">
        OwlOrderFi is an open-source software interface. The protocol is
        non-custodial. Users assume full responsibility for interacting
        with the smart contracts. The service is not available in
        jurisdictions where its use is prohibited.
      </p>
      <p className="mx-auto mt-2 max-w-3xl leading-relaxed text-slate-300">
        <strong className="text-slate-200">Not financial advice.</strong>{' '}
        Trading digital assets carries risk including total loss. Do your
        own research (DYOR).
      </p>
      <p className="mt-2">
        <a
          href="/terms"
          target="_blank"
          rel="noopener"
          className="text-cyan-400 underline-offset-2 hover:text-cyan-300 hover:underline"
        >
          Terms &amp; Disclaimer
        </a>
        {' · '}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener"
          className="text-cyan-400 underline-offset-2 hover:text-cyan-300 hover:underline"
        >
          Privacy Policy
        </a>
      </p>
    </footer>
  );
}

function LegalModal({ onAck, onClose }: { onAck: () => void; onClose: () => void }) {
  // Short ack dialog. The actual terms live at /terms and /privacy;
  // links open in new tabs so reading them doesn't dismiss the modal.
  // "Accept & continue" is gated by the checkbox so the user can't
  // punch through with Enter without consciously agreeing.
  const [checked, setChecked] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8 text-left"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-title"
    >
      <div className="w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-800 px-6 py-4">
          <h2 id="legal-title" className="text-lg font-semibold text-slate-100">
            Before you start
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-6 py-5 text-sm text-slate-300">
          <p>
            OwlOrderFi is open-source software for non-custodial limit, DCA,
            TWAP and ladder orders on EVM L2s. By using it you agree to the
            terms below — please read them before continuing.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <a
                href="/terms"
                target="_blank"
                rel="noopener"
                className="text-cyan-300 underline-offset-2 hover:underline"
              >
                Terms &amp; Risk Disclaimer
              </a>{' '}
              — what the protocol is, your responsibilities, jurisdictional
              notice, no warranty.
            </li>
            <li>
              <a
                href="/privacy"
                target="_blank"
                rel="noopener"
                className="text-cyan-300 underline-offset-2 hover:underline"
              >
                Privacy Policy
              </a>{' '}
              — what we collect (wallet address, orders, session), why, and
              your GDPR rights.
            </li>
          </ul>

          <p className="text-slate-400">
            As with any DeFi contract, your worst-case loss is bounded by
            the ERC-20 allowance you've granted — manage allowances from
            your wallet at any time.
          </p>

          <label className="mt-4 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-cyan-500"
            />
            <span>
              I have read the Terms and Privacy Policy. I am not a resident
              of a restricted jurisdiction and accept the risks of
              interacting with experimental smart-contract software.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onAck}
            disabled={!checked}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accept &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}

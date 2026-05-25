/**
 * Legal disclaimer surface — two pieces:
 *
 *   1. A persistent footer band, always visible, with the abridged
 *      "no-custody / no-advice / your responsibility" pitch + a link
 *      that re-opens the full modal.
 *   2. A first-visit modal with the full text. User checks "I
 *      understand" once; a localStorage flag suppresses subsequent
 *      auto-opens. Re-opens on demand via the footer link.
 *
 * Why both layers: the modal is friction (good for ack & audit trail
 * via the localStorage timestamp) but goes away. The footer is the
 * always-on reminder that this is software-as-infra, not a regulated
 * financial service.
 *
 * MiCA / AMLR context: OwlOrderFi is a non-custodial DeFi protocol
 * (smart contracts on EVM chains). The frontend is a convenience
 * surface — it never holds user funds, signs nothing on the user's
 * behalf, can't move assets. EU operators of monetised frontends
 * still sit in a grey area as potential CASPs; this disclaimer makes
 * the no-custody position explicit and warns restricted-jurisdiction
 * users to stay away.
 */

import { useEffect, useState } from 'react';
import { CookieNotice } from './CookieNotice';

const ACK_LS_KEY = 'polyorder.legalAck.v1';

export function LegalDisclaimer() {
  const [showModal, setShowModal] = useState(false);

  // First-visit auto-open. Bumping ACK_LS_KEY (v2, v3, …) on material
  // changes forces every prior user to re-ack — useful when the text
  // changes for legal reasons, not for typos.
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
      <LegalFooter onOpenTerms={() => setShowModal(true)} />
      {/* Cookie/storage notice is co-located here so its "Details" link
          can pop the same modal the legal footer opens — single source
          of truth for the long-form text. */}
      <CookieNotice onOpenDetails={() => setShowModal(true)} />
      {showModal && <LegalModal onAck={ack} onClose={() => setShowModal(false)} />}
    </>
  );
}

function LegalFooter({ onOpenTerms }: { onOpenTerms: () => void }) {
  // Compact legal banner. Four claims, in order:
  //   1. open-source software interface (not a registered service)
  //   2. non-custodial protocol (we never hold funds)
  //   3. users carry the full risk of interacting with the contracts
  //   4. geographic restriction (where prohibited by local law)
  // Long-form clarifications live in the modal behind the link.
  return (
    <footer className="border-t border-slate-800 bg-slate-950/80 px-6 py-4 text-center text-sm text-slate-400">
      <p className="mx-auto max-w-3xl leading-relaxed">
        OwlOrderFi is an open-source software interface. The protocol is
        non-custodial. Users assume full responsibility for interacting
        with the smart contracts. The service is not available in
        jurisdictions where its use is prohibited.{' '}
        <button
          type="button"
          onClick={onOpenTerms}
          className="text-cyan-400 underline-offset-2 hover:text-cyan-300 hover:underline"
        >
          Terms &amp; Disclaimer
        </button>
      </p>
    </footer>
  );
}

function LegalModal({ onAck, onClose }: { onAck: () => void; onClose: () => void }) {
  // "I have read and accept" — gates the primary action so the user
  // can't just punch through with Enter without seeing the checkbox.
  // Close (X) is always available — the user can dismiss without
  // accepting, but the modal will re-open on next visit until they do.
  const [checked, setChecked] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-title"
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-800 px-6 py-4">
          <h2 id="legal-title" className="text-lg font-semibold text-slate-100">
            Terms &amp; Disclaimer
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
          <Section title="What OwlOrderFi is">
            A set of open-source smart contracts on EVM-compatible chains
            (currently Base Sepolia, Arbitrum Sepolia, Optimism Sepolia,
            with Polygon and Base mainnet support in the registry) that
            allow you to place limit, DCA, and TWAP orders against
            Uniswap V3 pools. A keeper bot watches the chain and executes
            your signed orders when their conditions are met.
          </Section>

          <Section title="Non-custodial — we never hold your funds">
            Your tokens stay in your wallet until the moment of execution.
            You sign each order with your own private key. The contracts
            pull tokens via standard ERC-20 allowances; you can revoke
            allowances at any time directly with your wallet, independent
            of this site.
          </Section>

          <Section title="No financial advice">
            Nothing here is investment, tax, or legal advice. Triggers,
            quotes, distance-to-trigger, suggested trigger values, fee
            tier recommendations — all of it is informational. You alone
            decide what to sign. Crypto markets are volatile; orders may
            fill at unfavourable prices or fail entirely.
          </Section>

          <Section title="Risks you accept by using this site">
            <ul className="ml-5 list-disc space-y-1">
              <li>Smart-contract bugs (audits reduce but don't eliminate risk).</li>
              <li>Front-running, slippage, MEV — partially mitigated by minOut + private mempool routing where available.</li>
              <li>Keeper unavailability (orders may not execute promptly during outages).</li>
              <li>Network congestion (gas spikes may cause break-even skips).</li>
              <li>Stablecoin de-pegs.</li>
              <li>Total loss of funds is possible.</li>
            </ul>
          </Section>

          <Section title="Jurisdiction & regulatory notice">
            OwlOrderFi is not registered as a financial services provider
            in any jurisdiction. The protocol is not directed at residents
            of the United States, the United Kingdom, the European Union,
            or any other jurisdiction where the use of a non-custodial
            DeFi protocol would require licensing of the underlying
            software or its operators. EU residents are reminded that
            MiCA (Regulation 2023/1114) classifies certain stablecoins
            and service providers — we do not surface unauthorised
            stablecoins in the UI (notably Tether USDT is not listed for
            this reason). You are responsible for determining whether
            using this protocol is lawful in your jurisdiction.
          </Section>

          <Section title="No warranty">
            The software is provided "as is", without warranty of any
            kind, express or implied. To the maximum extent permitted by
            law, the developers and operators of OwlOrderFi disclaim all
            liability for any loss arising from use of the protocol or
            the frontend.
          </Section>

          <Section title="Taxes">
            You are solely responsible for reporting and paying any taxes
            arising from your use of the protocol in your jurisdiction.
          </Section>

          <Section title="Source &amp; transparency">
            All contracts, the API, the keeper, and this frontend are
            open source (BSL 1.1). On-chain transactions are publicly
            verifiable on the relevant block explorer (links surface on
            each order row once executed).
          </Section>

          <Section title="Browser storage &amp; third parties">
            We do not run analytics, advertising trackers, or fingerprinting
            scripts. We do not set HTTP cookies of our own. We rely on
            your browser's <span className="font-mono">localStorage</span>{' '}
            to remember a small set of essential preferences:
            <ul className="mt-2 ml-5 list-disc space-y-0.5">
              <li><span className="font-mono">polyorder.jwt</span> — your sign-in session (cleared on sign-out)</li>
              <li><span className="font-mono">polyorder.activeTab</span> — which tab you last viewed</li>
              <li><span className="font-mono">polyorder.sortKey</span> / <span className="font-mono">.sortDir</span> — orders-table sort</li>
              <li><span className="font-mono">polyorder.ordersAllChains</span> / <span className="font-mono">.scheduledAllChains</span> — chain-filter toggle</li>
              <li><span className="font-mono">polyorder.legalAck.v1</span> — record that you read this notice</li>
              <li><span className="font-mono">polyorder.cookieAck.v1</span> — record that you dismissed the storage banner</li>
            </ul>
            <p className="mt-2">
              Connecting a wallet activates wallet-connection libraries
              (RainbowKit, WalletConnect/Reown) which may load their own
              resources from their infrastructure (api.web3modal.org,
              pulse.walletconnect.org) — see their privacy policies for
              details. This is strictly necessary to establish the
              wallet session you requested.
            </p>
            <p className="mt-2">
              Under ePrivacy Directive Art. 5(3), the local-storage items
              above qualify as <em>strictly necessary</em> for the
              service you requested, so no separate consent is required.
              We clear nothing automatically on your behalf — sign out or
              clear your browser's site data to wipe everything we
              stored.
            </p>
          </Section>

          <label className="mt-4 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-cyan-500"
            />
            <span>
              I have read and understood the Terms and Disclaimer above.
              I confirm I am not a resident of a restricted jurisdiction
              and accept the risks of interacting with experimental
              smart-contract software.
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-cyan-300/90">
        {title}
      </h3>
      <div className="text-sm text-slate-300">{children}</div>
    </div>
  );
}

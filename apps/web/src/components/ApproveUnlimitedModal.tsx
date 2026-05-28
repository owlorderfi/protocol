import { useEffect, useState } from 'react';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { getRouterForChain } from '../lib/env';
import { ConfirmModal } from './ConfirmModal';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Fires the actual `approve(maxUint256)` call. Component clears the
   * acknowledgment checkbox + closes the modal on its own; caller only
   * has to do the wallet interaction.
   */
  onConfirm: () => void | Promise<void>;
  tokenSymbol: string;
  /** What this approval is for, used in the modal copy: "order" /
   *  "DCA" / "TWAP" / "ladder". */
  orderKindLabel: string;
  chainId: number;
}

/**
 * Shared confirmation modal for switching from the default exact-amount
 * approval to a max-uint256 (unlimited) approval. Used by every order
 * form (LIMIT / DCA / TWAP / Ladder). Copy is intentionally neutral
 * and factual — no "trust the contract" framing, no over-explanation.
 * The transparency line + explorer link convey that we're not asking
 * for trust on faith.
 */
export function ApproveUnlimitedModal({
  open,
  onClose,
  onConfirm,
  tokenSymbol,
  orderKindLabel,
  chainId,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  const chainInfo = CHAINS[chainId as ChainIdType];
  const routerAddress = getRouterForChain(chainId);
  const explorerUrl = chainInfo?.blockExplorer
    ? `${chainInfo.blockExplorer}/address/${routerAddress}`
    : null;

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title={`Approve unlimited ${tokenSymbol}?`}
      tone="warn"
      confirmLabel="Approve unlimited"
      cancelLabel="Cancel"
      extraDisabled={!acknowledged}
      onConfirm={onConfirm}
      body={
        <div className="space-y-2 text-sm">
          <p>
            Unlimited approval lets the router move any amount of {tokenSymbol}{' '}
            from your wallet until you revoke it. Saves one signature per future
            order.
          </p>
          <p>
            Exact approval (the default) caps the authorization at this{' '}
            {orderKindLabel}'s amount.
          </p>
          <p className="text-slate-400">
            Our LimitOrderRouter is open source
            {explorerUrl && (
              <>
                {' '}—{' '}
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 underline-offset-2 hover:underline"
                >
                  view on explorer ↗
                </a>
              </>
            )}
            . Limiting approvals is a universal best practice that applies to
            any contract.
          </p>
          <label className="mt-2 flex items-start gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 p-2.5 text-amber-100">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
            />
            <span>I want to approve unlimited.</span>
          </label>
        </div>
      }
    />
  );
}

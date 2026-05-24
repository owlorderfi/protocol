import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { getAddress } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import {
  SCHEDULED_ORDER_EIP712_TYPES,
  type CreateScheduledOrderInput,
  type ScheduledOrder,
} from '@owlorderfi/shared';
import { api } from '../lib/api';
import { getRouterForChain } from '../lib/env';

/**
 * Shape the DCA / TWAP forms hand to submit(). Two forms feed the same
 * hook — the difference is just the defaults each form picks (DCA →
 * open-ended `endTime=0, maxSlices=0`; TWAP → bounded window).
 */
export interface CreateScheduledOrderFormValues {
  tokenIn: string;
  tokenOut: string;
  amountPerSlice: string;
  intervalSec: number;
  /** Unix-sec; 0 = "start as soon as keeper picks it up". */
  startTime: number;
  /** Unix-sec; 0 = open-ended (DCA mode). */
  endTime: number;
  /** 0 = unbounded (DCA mode); >0 caps the run (TWAP mode). */
  maxSlices: number;
  maxSlippageBps: number;
  /**
   * Maker-signed hard price floor: min tokenOut HUMAN per 1 tokenIn HUMAN,
   * scaled by 1e18 and serialized as bigint string. "0" opts out of the
   * floor — the keeper's aggregator slippage gate becomes the only line
   * of defense. Forms compute this from the current quote with a safety
   * buffer (DCA needs a wider buffer than TWAP since the order runs
   * across longer price horizons).
   */
  minPriceScaled: string;
  feeBps: number;
  /** Days the maker's SIGNATURE stays valid. NOT the order's run window. */
  signatureValidityDays: number;
}

export function useCreateScheduledOrder() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (
    values: CreateScheduledOrderFormValues,
  ): Promise<ScheduledOrder | null> => {
    if (!address) {
      setError('No wallet connected');
      return null;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      // Signature deadline lives separately from the order's endTime —
      // a DCA order can run indefinitely while the maker's signature
      // expires (defense in depth: stale signatures stop being valid
      // even if the keeper's DB gets corrupted somehow).
      const deadline =
        Math.floor(Date.now() / 1000) + values.signatureValidityDays * 86400;
      const nonce =
        (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();

      const maker = getAddress(address);
      const tokenIn = getAddress(values.tokenIn);
      const tokenOut = getAddress(values.tokenOut);

      // Field types here MUST match SCHEDULED_ORDER_EIP712_TYPES exactly —
      // any drift means signatures generated here don't verify on-chain.
      const message = {
        maker,
        tokenIn,
        tokenOut,
        amountPerSlice: BigInt(values.amountPerSlice),
        intervalSec: BigInt(values.intervalSec),
        startTime: BigInt(values.startTime),
        endTime: BigInt(values.endTime),
        maxSlices: values.maxSlices,
        maxSlippageBps: values.maxSlippageBps,
        minPriceScaled: BigInt(values.minPriceScaled),
        feeBps: values.feeBps,
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
      };

      const signature = await signTypedDataAsync({
        domain: {
          name: 'OwlOrderFi',
          version: '1',
          chainId,
          verifyingContract: getRouterForChain(chainId),
        },
        types: SCHEDULED_ORDER_EIP712_TYPES,
        primaryType: 'ScheduledOrder',
        message,
      });

      const orderInput: CreateScheduledOrderInput = {
        chainId,
        maker,
        tokenIn,
        tokenOut,
        amountPerSlice: values.amountPerSlice,
        intervalSec: values.intervalSec,
        startTime: values.startTime,
        endTime: values.endTime,
        maxSlices: values.maxSlices,
        maxSlippageBps: values.maxSlippageBps,
        minPriceScaled: values.minPriceScaled,
        feeBps: values.feeBps,
      };

      const created = await api<ScheduledOrder>('/scheduled-orders', {
        method: 'POST',
        body: { order: orderInput, signature, nonce, deadline },
      });

      queryClient.invalidateQueries({ queryKey: ['scheduled-orders'] });
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create scheduled order');
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const reset = () => setError(null);

  return { submit, isSubmitting, error, reset };
}

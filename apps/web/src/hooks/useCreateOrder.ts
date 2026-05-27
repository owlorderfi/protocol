import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { getAddress } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import {
  ORDER_EIP712_TYPES,
  ORDER_TYPE_TO_UINT8,
  type CreateOrderInput,
  type Order,
  type OrderType,
} from '@owlorderfi/shared';
import { api } from '../lib/api';
import { getRouterForChain } from '../lib/env';

export interface CreateOrderFormValues {
  orderType: OrderType;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  triggerPrice: string;
  deadlineHours: number; // user picks "valid for N hours"
  feeBps: number; // tier-derived in the UI, signed by maker
  /** Optional ladder grouping. When set, the order joins a ladder
   *  (a set of N rungs sharing one ladderId). Each rung is otherwise
   *  a normal limit order — the ladder is purely a UI / persistence
   *  grouping; the contract sees only individual orders. */
  ladderId?: string;
  ladderRungIndex?: number;
}

export function useCreateOrder() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: CreateOrderFormValues): Promise<Order | null> => {
    if (!address) {
      setError('No wallet connected');
      return null;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      const deadline = Math.floor(Date.now() / 1000) + values.deadlineHours * 3600;
      const nonce = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();

      const maker = getAddress(address);
      const tokenIn = getAddress(values.tokenIn);
      const tokenOut = getAddress(values.tokenOut);

      // Build EIP-712 message — uint8 + bigints expected by viem
      const message = {
        maker,
        tokenIn,
        tokenOut,
        amountIn: BigInt(values.amountIn),
        minAmountOut: BigInt(values.minAmountOut),
        orderType: ORDER_TYPE_TO_UINT8[values.orderType],
        triggerPrice: BigInt(values.triggerPrice),
        deadline: BigInt(deadline),
        nonce: BigInt(nonce),
        feeBps: values.feeBps,
      };

      const signature = await signTypedDataAsync({
        domain: {
          name: 'OwlOrderFi',
          version: '1',
          chainId,
          verifyingContract: getRouterForChain(chainId),
        },
        types: ORDER_EIP712_TYPES,
        primaryType: 'Order',
        message,
      });

      const orderInput: CreateOrderInput = {
        chainId,
        maker,
        tokenIn,
        tokenOut,
        amountIn: values.amountIn,
        minAmountOut: values.minAmountOut,
        orderType: values.orderType,
        triggerPrice: values.triggerPrice,
        deadline,
        feeBps: values.feeBps,
      };

      const created = await api<Order>('/orders', {
        method: 'POST',
        body: {
          order: orderInput,
          signature,
          nonce,
          ...(values.ladderId !== undefined && values.ladderRungIndex !== undefined
            ? { ladderId: values.ladderId, ladderRungIndex: values.ladderRungIndex }
            : {}),
        },
      });

      queryClient.invalidateQueries({ queryKey: ['orders'] });
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order');
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const reset = () => setError(null);

  return { submit, isSubmitting, error, reset };
}

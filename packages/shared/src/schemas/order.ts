import { z } from 'zod';
import { AddressSchema, BigIntStringSchema } from './token.js';

/**
 * Order types supported by OwlOrderFi.
 *
 * - LIMIT_BUY:   buy tokenOut with tokenIn when tokenOut price ≤ triggerPrice
 * - LIMIT_SELL:  sell tokenIn for tokenOut when tokenIn price ≥ triggerPrice
 * - STOP_LOSS:   sell tokenIn for tokenOut when tokenIn price ≤ triggerPrice (long position stop)
 * - TAKE_PROFIT: sell tokenIn for tokenOut when tokenIn price ≥ triggerPrice (alias for LIMIT_SELL with clearer intent)
 */
export const OrderType = z.enum(['LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT']);
export type OrderType = z.infer<typeof OrderType>;

export const OrderStatus = z.enum(['OPEN', 'EXECUTING', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']);
export type OrderStatus = z.infer<typeof OrderStatus>;

/**
 * Input schema — what user sends from frontend to create an order.
 * Backend validates, persists, then awaits signature.
 */
export const CreateOrderInputSchema = z.object({
  chainId: z.number().int().positive(),
  maker: AddressSchema,
  tokenIn: AddressSchema,
  tokenOut: AddressSchema,
  amountIn: BigIntStringSchema,
  minAmountOut: BigIntStringSchema,
  orderType: OrderType,
  triggerPrice: BigIntStringSchema, // price scaled by 10^18
  deadline: z.number().int().positive(), // unix timestamp seconds
  // Per-order protocol fee in basis points (1 bp = 0.01%). Signed by maker,
  // capped at 100 bp by the contract. Tier-derived in the UI.
  feeBps: z.number().int().min(0).max(100),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

/**
 * Full order schema — what backend stores and frontend reads.
 * Includes EIP-712 signature, nonce, status, timestamps.
 */
export const OrderSchema = CreateOrderInputSchema.extend({
  id: z.string().uuid(),
  nonce: BigIntStringSchema,
  // EIP-712 signature = 65 bytes = 130 hex chars + '0x' prefix = 132 total
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid EIP-712 signature (expected 0x + 130 hex chars)'),
  status: OrderStatus,
  createdAt: z.coerce.date(),
  filledAt: z.coerce.date().nullable(),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid tx hash')
    .nullable(),
  filledAmountOut: BigIntStringSchema.nullable(),
  // Uniswap V3 fee tier (in 1/10^6 units: 100/500/3000/10000) the keeper used.
  // Null until the order is filled.
  feeTier: z.number().int().positive().nullable(),
  // Protocol fee actually paid (tokenOut wei) — null until the order is filled.
  feeAmount: BigIntStringSchema.nullable(),
  // Keeper-side error message attached on FAILED orders, or context after a
  // stuck-order recovery.
  failureReason: z.string().nullable(),
  // Count of transient keeper execution failures (slippage gate, gas spike,
  // re-quote error). Each releaseLock bumps it; once it hits the keeper's
  // LIMIT_MAX_RETRIES the order is escalated to FAILED. Lets the UI show
  // "retrying (n/cap)" instead of an opaque infinite retry.
  retryCount: z.number().int().nonnegative(),
  // Ladder grouping. When a maker creates a take-profit ladder
  // (N independent limit orders at staggered prices, signed in one
  // UX flow), each rung gets a separate Order row sharing the same
  // ladderId. ladderRungIndex gives display order within the group
  // (0..N-1). null/null = standalone limit order (default).
  // The contract is unaware: each row is a normal LIMIT_BUY/SELL.
  ladderId: z.string().uuid().nullable(),
  ladderRungIndex: z.number().int().nonnegative().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

/**
 * Wrapper for POST /orders — includes the off-chain signature + nonce
 * that user generates client-side via wagmi signTypedData.
 *
 * `ladderId` is optional grouping metadata persisted alongside the order
 * but NOT part of the EIP-712 signature payload (the contract doesn't
 * know about ladders — each rung is just a regular limit order). When
 * provided, ladderRungIndex must also be provided.
 */
export const CreateOrderRequestSchema = z
  .object({
    order: CreateOrderInputSchema,
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid EIP-712 signature (expected 0x + 130 hex chars)'),
    nonce: BigIntStringSchema,
    ladderId: z.string().uuid().optional(),
    ladderRungIndex: z.number().int().nonnegative().optional(),
  })
  .refine(
    (v) => (v.ladderId === undefined) === (v.ladderRungIndex === undefined),
    {
      message: 'ladderId and ladderRungIndex must both be set or both omitted',
      path: ['ladderRungIndex'],
    },
  );
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/**
 * EIP-712 typed data for order signature.
 * Frontend uses this with wagmi's signTypedData; backend verifies with viem.recoverTypedDataAddress.
 */
export const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' }, // enum index
    { name: 'triggerPrice', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
  ],
} as const;

/**
 * Map enum string → uint8 used in contract & signature.
 * Must match Solidity enum order in LimitOrderRouter.sol.
 */
export const ORDER_TYPE_TO_UINT8: Record<OrderType, number> = {
  LIMIT_BUY: 0,
  LIMIT_SELL: 1,
  STOP_LOSS: 2,
  TAKE_PROFIT: 3,
};

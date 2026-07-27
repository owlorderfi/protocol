import { z } from 'zod';
import { AddressSchema, BigIntStringSchema } from './token.js';

/**
 * ScheduledOrder — recurring on-chain execution driven by time, not by
 * price triggers like a limit order. One contract primitive supports two
 * UX framings:
 *
 *   DCA  — `endTime = 0`, `maxSlices = 0` (open-ended, weekly/monthly
 *          dollar-cost-averaging investment)
 *   TWAP — `endTime > 0`, `maxSlices = N`, short `intervalSec` (bounded
 *          window execution that slices a large order to minimize market
 *          impact)
 *
 * Mirrors the Solidity `ScheduledOrder` struct in LimitOrderRouter.sol —
 * field order in SCHEDULED_ORDER_EIP712_TYPES below MUST stay identical
 * to the contract's SCHEDULED_ORDER_TYPEHASH or signatures won't verify.
 */

export const ScheduledOrderStatus = z.enum([
  'ACTIVE',     // keeper is executing slices on schedule
  'COMPLETED',  // maxSlices reached, no more executions
  'EXPIRED',    // endTime crossed without completion
  'CANCELLED',  // maker called cancelOrder
]);
export type ScheduledOrderStatus = z.infer<typeof ScheduledOrderStatus>;

export const ScheduledExecutionStatus = z.enum([
  'PENDING',  // keeper has reserved this slice but tx not yet confirmed
  'FILLED',   // on-chain confirmation received
  'FAILED',   // tx reverted (e.g., slippage gate, RPC error) — slice index
              // reusable on next tick when conditions allow
]);
export type ScheduledExecutionStatus = z.infer<typeof ScheduledExecutionStatus>;

/**
 * Input schema — what the frontend sends to create a scheduled order.
 * Backend validates, generates nonce, computes EIP-712 hash, asks user
 * to sign, then persists.
 */
/// Mirrors the contract's MIN/MAX_TWAP_WINDOW_SEC. Below ~2 minutes an average
/// stops resisting a single-block push; above a day it stops tracking the
/// market the slice executes in.
export const MIN_TWAP_WINDOW_SEC = 120;
export const MAX_TWAP_WINDOW_SEC = 86_400;

/// Explicit opt-out from the on-chain price reference.
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const ScheduledOrderFieldsSchema = z.object({
  chainId: z.number().int().positive(),
  maker: AddressSchema,
  tokenIn: AddressSchema,
  tokenOut: AddressSchema,
  amountPerSlice: BigIntStringSchema,
  intervalSec: z.number().int().min(60), // matches contract MIN_INTERVAL_SEC
  startTime: z.number().int().nonnegative(), // unix-sec; 0 = "as soon as possible"
  endTime: z.number().int().nonnegative(), // 0 = open-ended (DCA mode)
  maxSlices: z.number().int().min(0).max(10_000), // matches contract MAX_SCHEDULED_SLICES
  // Tolerance against the TWAP reference below. Capped at 10% to match the
  // contract's MAX_SLIPPAGE_BPS; a wider value is rejected on-chain rather
  // than silently ignored, which is how this field behaved before the
  // reference existed.
  maxSlippageBps: z.number().int().min(0).max(1_000),
  // Uniswap V3 pool the contract averages over to bound keeper discretion,
  // signed by the maker so the keeper cannot pick a flattering pool. The zero
  // address is an explicit opt-out for thin tokens whose only pool cannot
  // serve a window at all — see twapWindowSec.
  twapPool: AddressSchema,
  // Averaging window in seconds. 0 only when twapPool is the zero address.
  // Bounds mirror the contract's MIN/MAX_TWAP_WINDOW_SEC. Signed rather than
  // fixed because a pool with no swap inside the window cannot produce a real
  // average — the oracle extrapolates at the current tick and returns exactly
  // spot — so quiet pairs need a longer one.
  twapWindowSec: z.number().int().min(0).max(86_400),
  // Hard price floor signed by the maker — min tokenOut HUMAN per 1 tokenIn
  // HUMAN, scaled to 1e18. Contract reads decimals on-chain and converts
  // to raw minOut. "0" = maker opts out of the floor (defense-in-depth
  // disabled, only the keeper's aggregator slippage gate protects the swap).
  // The frontend computes a conservative default from the current quote
  // (e.g. quote price * (1 - maxSlippageBps - safetyBuffer)).
  minPriceScaled: BigIntStringSchema,
  feeBps: z.number().int().min(0).max(100), // same cap as Order
});

/**
 * Create-request schema: the fields plus the cross-field rules the contract
 * enforces. Kept separate from `ScheduledOrderFieldsSchema` because `.refine()`
 * produces a ZodEffects, which cannot be `.extend()`ed by the full schema below.
 */
export const CreateScheduledOrderInputSchema = ScheduledOrderFieldsSchema
  .refine(
    (o) =>
      o.twapPool === ZERO_ADDRESS ||
      (o.twapWindowSec >= MIN_TWAP_WINDOW_SEC && o.twapWindowSec <= MAX_TWAP_WINDOW_SEC),
    {
      path: ['twapWindowSec'],
      message: `twapWindowSec must be between ${MIN_TWAP_WINDOW_SEC} and ${MAX_TWAP_WINDOW_SEC} when a reference pool is set`,
    },
  )
  .refine((o) => o.twapPool !== ZERO_ADDRESS || o.twapWindowSec === 0, {
    path: ['twapWindowSec'],
    message: 'twapWindowSec must be 0 when opting out of the TWAP reference',
  });
export type CreateScheduledOrderInput = z.infer<typeof CreateScheduledOrderInputSchema>;

/**
 * Full schema — what backend stores + returns. Adds id, nonce, signature,
 * runtime status, timestamps.
 */
export const ScheduledOrderSchema = ScheduledOrderFieldsSchema.extend({
  id: z.string().uuid(),
  nonce: BigIntStringSchema,
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid EIP-712 signature (expected 0x + 130 hex chars)'),
  deadline: z.number().int().positive(), // signature deadline, not order deadline
  status: ScheduledOrderStatus,
  // Runtime counters mirrored from chain state for UI display. Source of
  // truth is on-chain `scheduledState[hash]`; these are eventually-
  // consistent cache populated by the keeper after each execution.
  slicesExecuted: z.number().int().nonnegative(),
  lastExecutedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  cancelledAt: z.coerce.date().nullable(),
  // Per-slice execution rows attached when the API returns this order
  // (always populated; empty array for orders that haven't been
  // executed yet). Used by the UI to compute average paid price etc.
  executions: z.array(z.lazy(() => ScheduledExecutionSchema)).default([]),
});
export type ScheduledOrder = z.infer<typeof ScheduledOrderSchema>;

/**
 * Per-slice execution record — one row per attempted slice. Keeper writes
 * PENDING when reserving the slot, updates to FILLED/FAILED on receipt.
 */
export const ScheduledExecutionSchema = z.object({
  id: z.string().uuid(),
  scheduledOrderId: z.string().uuid(),
  sliceIndex: z.number().int().nonnegative(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable(),
  status: ScheduledExecutionStatus,
  amountIn: BigIntStringSchema.nullable(),
  amountOut: BigIntStringSchema.nullable(),
  feeAmount: BigIntStringSchema.nullable(),
  failureReason: z.string().nullable(),
  // Only meaningful when status='FAILED'. Permanent failures (invalid
  // signature, deadline expired, order cancelled, insufficient maker
  // balance/allowance) block retry forever — UI surfaces as red
  // "action required". Transient (default) auto-retries on backoff.
  permanent: z.boolean().default(false),
  executedAt: z.coerce.date(),
});
export type ScheduledExecution = z.infer<typeof ScheduledExecutionSchema>;

/**
 * Wrapper for POST /scheduled-orders — includes the off-chain signature
 * + nonce + deadline produced client-side via wagmi.signTypedData.
 */
export const CreateScheduledOrderRequestSchema = z
  .object({
    order: CreateScheduledOrderInputSchema,
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid EIP-712 signature (expected 0x + 130 hex chars)'),
    nonce: BigIntStringSchema,
    deadline: z.number().int().positive(),
  })
  // A.14 — mirrors the on-chain SameTokenInOut revert on the scheduled path.
  .refine(
    (v) => v.order.tokenIn.toLowerCase() !== v.order.tokenOut.toLowerCase(),
    {
      message: 'tokenIn and tokenOut must differ',
      path: ['order', 'tokenOut'],
    },
  );
export type CreateScheduledOrderRequest = z.infer<typeof CreateScheduledOrderRequestSchema>;

/**
 * EIP-712 typed data for ScheduledOrder signature.
 *
 * Field order MUST match the Solidity SCHEDULED_ORDER_TYPEHASH exactly:
 *   ScheduledOrder(
 *     address maker, address tokenIn, address tokenOut,
 *     uint256 amountPerSlice, uint64 intervalSec, uint64 startTime,
 *     uint64 endTime, uint16 maxSlices, uint16 maxSlippageBps,
 *     address twapPool, uint32 twapWindowSec,
 *     uint256 minPriceScaled, uint16 feeBps, uint256 nonce, uint64 deadline
 *   )
 *
 * Any reorder here ⇒ different typehash ⇒ signatures generated by the UI
 * won't verify against the contract. Keep in lockstep.
 */
export const SCHEDULED_ORDER_EIP712_TYPES = {
  ScheduledOrder: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountPerSlice', type: 'uint256' },
    { name: 'intervalSec', type: 'uint64' },
    { name: 'startTime', type: 'uint64' },
    { name: 'endTime', type: 'uint64' },
    { name: 'maxSlices', type: 'uint16' },
    { name: 'maxSlippageBps', type: 'uint16' },
    { name: 'twapPool', type: 'address' },
    { name: 'twapWindowSec', type: 'uint32' },
    { name: 'minPriceScaled', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

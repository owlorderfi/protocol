import { z } from 'zod';
import { AddressSchema, BigIntStringSchema } from './token.js';

/**
 * Order types supported by Polyorder.
 *
 * - LIMIT_BUY:   buy tokenOut with tokenIn when tokenOut price ≤ triggerPrice
 * - LIMIT_SELL:  sell tokenIn for tokenOut when tokenIn price ≥ triggerPrice
 * - STOP_LOSS:   sell tokenIn for tokenOut when tokenIn price ≤ triggerPrice (long position stop)
 * - TAKE_PROFIT: sell tokenIn for tokenOut when tokenIn price ≥ triggerPrice (alias for LIMIT_SELL with clearer intent)
 */
export const OrderType = z.enum(['LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT']);
export type OrderType = z.infer<typeof OrderType>;

export const OrderStatus = z.enum(['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']);
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
});
export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

/**
 * Full order schema — what backend stores and frontend reads.
 * Includes EIP-712 signature, nonce, status, timestamps.
 */
export const OrderSchema = CreateOrderInputSchema.extend({
  id: z.string().uuid(),
  nonce: BigIntStringSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid signature hex'),
  status: OrderStatus,
  createdAt: z.coerce.date(),
  filledAt: z.coerce.date().nullable(),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid tx hash')
    .nullable(),
  filledAmountOut: BigIntStringSchema.nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

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

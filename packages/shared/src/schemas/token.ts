import { z } from 'zod';

/**
 * Validates a 0x-prefixed 40-character hex Ethereum address.
 * Note: this is structural validation only. For checksum validation use viem.isAddress().
 */
export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

/**
 * Validates a stringified bigint (for amounts/wei values).
 * We use strings to avoid JS number precision issues with bigint over JSON.
 */
export const BigIntStringSchema = z
  .string()
  .regex(/^[0-9]+$/, 'Must be a non-negative integer string');

/**
 * Token metadata (subset of standard token list format).
 */
export const TokenSchema = z.object({
  chainId: z.number().int().positive(),
  address: AddressSchema,
  symbol: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  decimals: z.number().int().min(0).max(36),
  logoURI: z.string().url().optional(),
});

export type Token = z.infer<typeof TokenSchema>;

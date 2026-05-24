import { z } from 'zod';
import { AddressSchema } from './token.js';

/**
 * Auth flow (SIWE-style, simplified):
 *
 *   1. Client: POST /auth/nonce  { walletAddress }
 *      → server creates AuthNonce row, returns { nonce, message, expiresAt }
 *
 *   2. Client: user signs `message` via wallet (personal_sign / EIP-191)
 *
 *   3. Client: POST /auth/login  { walletAddress, nonce, signature }
 *      → server verifies signature, marks nonce consumed, creates Session,
 *        returns { accessToken, expiresAt, user: { walletAddress } }
 *
 *   4. Subsequent requests: `Authorization: Bearer <accessToken>`
 *      → Web3JwtAuthGuard validates JWT and ensures Session not revoked
 */

// ─── Nonce request/response ──────────────────────────────────────

export const NonceRequestSchema = z.object({
  walletAddress: AddressSchema,
});
export type NonceRequest = z.infer<typeof NonceRequestSchema>;

export const NonceResponseSchema = z.object({
  nonce: z.string().min(32).max(64),
  message: z.string(), // exact text to sign in wallet
  expiresAt: z.coerce.date(),
});
export type NonceResponse = z.infer<typeof NonceResponseSchema>;

// ─── Login request/response ──────────────────────────────────────

export const LoginRequestSchema = z.object({
  walletAddress: AddressSchema,
  nonce: z.string().min(32).max(64),
  // EIP-191 personal_sign signature: 65 bytes = 130 hex chars + 0x = 132 total
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid signature hex'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.coerce.date(),
  user: z.object({
    walletAddress: AddressSchema,
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ─── JWT payload structure ───────────────────────────────────────

/**
 * Payload encoded in JWT. `sub` = wallet, `sid` = session ID (for revoke).
 * Standard JWT fields (iat, exp) added by signing layer.
 */
export const JwtPayloadSchema = z.object({
  sub: AddressSchema, // wallet address
  sid: z.string().uuid(), // session id (server-side)
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

// ─── Message template (what user signs) ──────────────────────────

/**
 * Generate the message a user must sign. Format is intentionally simple and
 * human-readable so wallets display it cleanly.
 *
 * Frontend MUST use this exact format when calling signMessage.
 * Backend MUST use this exact format when verifying.
 */
export function buildLoginMessage(params: {
  domain: string; // e.g., 'owlorderfi.com'
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.walletAddress,
    '',
    'Sign in to OwlOrderFi to create or manage your orders.',
    '',
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
  ].join('\n');
}

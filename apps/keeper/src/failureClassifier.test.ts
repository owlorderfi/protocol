import { describe, it, expect } from 'vitest';
import { classifyFailure } from './failureClassifier';
import { GasTooHighError } from './chain';

// Covers the inputs the keeper actually sees in journal logs, NOT every
// theoretically possible viem message. The "ERC20: transfer amount
// exceeds balance" case is the regression that motivated this file —
// the old in-place scheduledExecutor classifier only matched the word
// "insufficient" and missed the "exceeds balance" / "exceeds allowance"
// idioms, so a Limit order whose maker had moved funds elsewhere
// burned 15 transient retries before the cap escalated it.

describe('classifyFailure', () => {
  describe('permanent', () => {
    it.each([
      'ERC20: transfer amount exceeds balance',
      'execution reverted: ERC20: transfer amount exceeds balance',
      'ERC20: transfer amount exceeds allowance',
      'ERC20: insufficient allowance',
      'ERC20InsufficientBalance(...)',
      'InvalidSignature()',
      'reverted with custom error InvalidSignature',
      'SignerMismatch()',
      'OrderExpired()',
      'ScheduledExpired()',
      'NonceAlreadyUsed()',
      'ScheduledExhausted()',
      'NO_PRICE_FLOOR',
      'no_price_floor',
    ])('marks "%s" as permanent', (msg) => {
      expect(classifyFailure(new Error(msg)).permanent).toBe(true);
    });
  });

  describe('transient', () => {
    it.each([
      'BREAK_EVEN_SKIP',
      'InsufficientOutput()',
      'execution reverted: InsufficientOutput',
      'connect ETIMEDOUT 1.2.3.4:443',
      'Internal JSON-RPC error',
      'reverted with the following signature: 0xdeadbeef',
      'reverted without a reason string',
    ])('marks "%s" as transient', (msg) => {
      expect(classifyFailure(new Error(msg)).permanent).toBe(false);
    });

    it('treats GasTooHighError instances as transient', () => {
      const err = new GasTooHighError(2_000_000_000_000n, 1_000_000_000_000n);
      expect(classifyFailure(err).permanent).toBe(false);
    });
  });

  describe('regression guards', () => {
    // Viem prefixes undecoded reverts with "reverted with the following
    // signature: 0x...". The earlier classifier matched the bare word
    // "signature" and misclassified every undecoded revert as permanent
    // (real incident 2026-05-27: slice 9 of e33731f8 on Arb-sepolia —
    // actually InsufficientOutput, killed permanently because diagnostic
    // text contained "signature").
    it('does NOT mark "reverted with the following signature" as permanent', () => {
      const msg =
        'The contract function "executeOrder" reverted with the following signature: 0x12345678';
      expect(classifyFailure(new Error(msg)).permanent).toBe(false);
    });

    // The token contract on Base USDC uses "exceeds balance" rather than
    // "insufficient balance"; the regression we're fixing.
    it('marks "exceeds balance" permanent even without the word "insufficient"', () => {
      expect(
        classifyFailure(new Error('ERC20: transfer amount exceeds balance')).permanent,
      ).toBe(true);
    });

    // Non-Error values (strings thrown directly) shouldn't crash the
    // classifier — defensive against odd RPC paths that string-throw.
    it('accepts non-Error throw values', () => {
      expect(classifyFailure('plain string failure').permanent).toBe(false);
      expect(classifyFailure(42).permanent).toBe(false);
      expect(classifyFailure(null).permanent).toBe(false);
      expect(classifyFailure(undefined).permanent).toBe(false);
    });
  });
});

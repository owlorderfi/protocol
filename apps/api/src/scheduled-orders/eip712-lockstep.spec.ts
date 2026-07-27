import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEDULED_ORDER_EIP712_TYPES, ORDER_EIP712_TYPES } from '@owlorderfi/shared';

/**
 * The signed struct is declared in four places: the Solidity struct, the
 * Solidity typehash string, the shared EIP-712 types array the wallet signs
 * against, and the keeper's ABI tuple. They must agree exactly.
 *
 * A mismatch does not fail loudly. Signatures simply stop verifying —
 * `SignerMismatch` on every execution — and because the maker's wallet renders
 * whatever it is handed, the break is invisible until an order is already
 * signed and stuck. This is the check that would have caught it before deploy,
 * so it lives in CI rather than in a runbook step someone remembers to run.
 */

const ROOT = resolve(__dirname, '../../../..');

function readSource(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

/** Rebuild the canonical EIP-712 type string from a viem-style types array. */
function encodeType(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

describe('EIP-712 lockstep between shared, contract and keeper', () => {
  const solidity = readSource('contracts/src/LimitOrderRouter.sol');

  it('ScheduledOrder typehash matches the contract literal', () => {
    const onChain = /SCHEDULED_ORDER_TYPEHASH = keccak256\(\s*"([^"]+)"/.exec(solidity)?.[1];
    expect(onChain, 'SCHEDULED_ORDER_TYPEHASH not found in the contract').toBeTruthy();
    expect(encodeType('ScheduledOrder', SCHEDULED_ORDER_EIP712_TYPES.ScheduledOrder)).toBe(onChain);
  });

  it('Order typehash matches the contract literal', () => {
    const onChain = /ORDER_TYPEHASH = keccak256\(\s*"([^"]+)"/.exec(solidity)?.[1];
    expect(onChain, 'ORDER_TYPEHASH not found in the contract').toBeTruthy();
    expect(encodeType('Order', ORDER_EIP712_TYPES.Order)).toBe(onChain);
  });

  it("keeper's executeScheduledOrder tuple matches the signed struct", () => {
    const keeper = readSource('apps/keeper/src/scheduledExecutor.ts');
    const tuple = /name: 'order',\s*type: 'tuple',\s*components: \[([\s\S]*?)\n\s*\],/.exec(keeper)?.[1];
    expect(tuple, 'executeScheduledOrder tuple not found in the keeper').toBeTruthy();

    const components = [...tuple!.matchAll(/\{\s*name:\s*'(\w+)',\s*type:\s*'(\w+)'\s*\}/g)].map(
      (m) => ({ name: m[1]!, type: m[2]! }),
    );
    expect(encodeType('ScheduledOrder', components)).toBe(
      encodeType('ScheduledOrder', SCHEDULED_ORDER_EIP712_TYPES.ScheduledOrder),
    );
  });
});

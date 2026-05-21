import { getAddress } from 'viem';
import { getConfig } from './config';

export interface SwapCalldata {
  aggregator: `0x${string}`;
  calldata: `0x${string}`;
  estimatedOutput: bigint;
}

/**
 * Fetch swap calldata from 1inch Swap API v6.
 * The `from` address is the LimitOrderRouter — it's the msg.sender that calls the aggregator.
 *
 * Contract flow: router.transferFrom(maker) → router.approve(aggregator) → aggregator.call(calldata)
 * → aggregator sends tokenOut back to router → router sends to maker (minus fee).
 */
export async function getSwapCalldata(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  routerAddress: string;
  minAmountOut: string;
}): Promise<SwapCalldata> {
  const config = getConfig();

  if (!config.ONEINCH_API_KEY) {
    throw new Error(
      'ONEINCH_API_KEY is required to fetch swap calldata. ' +
        'Set DRY_RUN=true to test without a real API key.',
    );
  }

  const qs = new URLSearchParams({
    src: getAddress(params.tokenIn),
    dst: getAddress(params.tokenOut),
    amount: params.amountIn,
    from: getAddress(params.routerAddress),
    // 1% safety slippage — contract enforces minAmountOut from signed order
    slippage: '1',
    disableEstimate: 'true',
    allowPartialFill: 'false',
  });

  const url = `https://api.1inch.dev/swap/v6.0/${config.CHAIN_ID}/swap?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.ONEINCH_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`1inch swap API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    dstAmount: string;
    tx: { to: string; data: string };
  };

  return {
    aggregator: getAddress(data.tx.to) as `0x${string}`,
    calldata: data.tx.data as `0x${string}`,
    estimatedOutput: BigInt(data.dstAmount),
  };
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TwapOracle, IUniswapV3PoolOracle} from "../src/libraries/TwapOracle.sol";

/**
 * Validates TwapOracle against real Base mainnet pools.
 *
 * Two things are being checked, and the second is the reason this file exists:
 *
 *   1. The hand-ported `getSqrtRatioAtTick` constants produce a quote that
 *      agrees with the pool's own spot price. Forty magic constants copied by
 *      hand deserve a check against reality rather than a unit test built from
 *      the same assumptions.
 *
 *   2. A cardinality-1 pool is REJECTED. Those pools answer `observe()` without
 *      reverting and hand back a TWAP exactly equal to spot, so a naive
 *      integration accepts them and believes it has manipulation resistance it
 *      does not have. This asserts we fail closed on a real one.
 *
 * Forks at latest (no archive endpoint needed) and skips when the RPC is
 * unreachable, so an offline run does not read as a failure.
 */
/// `consult` is an internal library function, so it inlines into its caller.
/// `vm.expectRevert` arms the next EXTERNAL call, so the revert assertions need
/// a real call frame to land in.
contract TwapOracleHarness {
    function consult(
        address factory,
        address pool,
        uint32 window,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) external view returns (uint256) {
        return TwapOracle.consult(factory, pool, window, baseAmount, baseToken, quoteToken);
    }
}

contract TwapOracleForkTest is Test {
    TwapOracleHarness harness;

    string constant BASE_RPC = "https://base-rpc.publicnode.com";

    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;

    // Deep pool: cardinality 5000, ~43h of history (measured 2026-07-27).
    address constant USDC_WETH_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    // Dead 0.01% tier: cardinality 1, zero liquidity, last write years ago.
    // `observe()` succeeds here and returns spot.
    address constant USDC_CBETH_100 = 0xf0913aF89C3CF89256196fE5Ea3E5370Dc90c026;

    function _fork() internal returns (bool) {
        try vm.createSelectFork(BASE_RPC) {
            harness = new TwapOracleHarness();
            return true;
        } catch {
            return false;
        }
    }

    function test_Fork_QuoteAgreesWithSpot() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }

        uint128 oneUsdc = 1e6;
        uint256 twapOut = TwapOracle.consult(FACTORY, USDC_WETH_500, 600, oneUsdc, USDC, WETH);
        assertGt(twapOut, 0, "TWAP quote must be non-zero");

        // Spot from slot0, same conversion path but at the live tick.
        (, int24 spotTick, , , , , ) = IUniswapV3PoolOracle(USDC_WETH_500).slot0();
        uint256 spotOut = TwapOracle.getQuoteAtTick(spotTick, oneUsdc, USDC, WETH);

        // A 10-minute average tracks spot closely; allow 5% for genuine drift.
        uint256 hi = spotOut > twapOut ? spotOut : twapOut;
        uint256 lo = spotOut > twapOut ? twapOut : spotOut;
        assertLt((hi - lo) * 100 / hi, 5, "TWAP and spot must agree within 5%");

        // Sanity on magnitude: 1 USDC is worth far less than 1 WETH and far
        // more than a wei. Catches a silently inverted token ordering, which
        // would still pass a pure self-consistency check.
        assertLt(twapOut, 1e18, "1 USDC cannot be worth a whole WETH");
        assertGt(twapOut, 1e10, "1 USDC cannot be worth dust");
    }

    function test_Fork_RejectsPoolThatCannotSpanTheWindow() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }

        // Proof of the trap: the raw oracle call succeeds on this pool...
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 600;
        secondsAgos[1] = 0;
        (int56[] memory cums, ) = IUniswapV3PoolOracle(USDC_CBETH_100).observe(secondsAgos);
        int24 meanTick = int24((cums[1] - cums[0]) / int56(uint56(600)));
        (, int24 spotTick, , , , , ) = IUniswapV3PoolOracle(USDC_CBETH_100).slot0();
        assertEq(meanTick, spotTick, "dead pool returns a TWAP identical to spot");

        // ...and consult() refuses it anyway.
        vm.expectRevert(
            abi.encodeWithSelector(TwapOracle.TwapWindowUnavailable.selector, USDC_CBETH_100, uint32(600))
        );
        harness.consult(FACTORY, USDC_CBETH_100, 600, 1e6, USDC, CBETH);
    }

    function test_Fork_RejectsPoolForTheWrongPair() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        vm.expectRevert(
            abi.encodeWithSelector(TwapOracle.TwapPoolMismatch.selector, USDC_WETH_500, USDC, CBETH)
        );
        harness.consult(FACTORY, USDC_WETH_500, 600, 1e6, USDC, CBETH);
    }
}

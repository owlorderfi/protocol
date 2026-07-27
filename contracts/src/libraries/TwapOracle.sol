// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// Minimal slice of the Uniswap V3 pool surface this library needs.
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3PoolOracle {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function observations(uint256 index)
        external
        view
        returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function fee() external view returns (uint24);

    function token0() external view returns (address);

    function token1() external view returns (address);
}

/**
 * @title TwapOracle
 * @notice Reads a manipulation-resistant reference price from a Uniswap V3
 *         pool, so the router can check what a keeper actually executed
 *         against something the keeper does not control.
 *
 * @dev THE TRAP THIS LIBRARY EXISTS TO AVOID: `observe()` not reverting is not
 *      evidence of a usable TWAP. When no observation was written inside the
 *      requested window, `getSurroundingObservations` takes its first branch
 *      and extrapolates forward from the last write using the CURRENT tick.
 *      Both ends of the average are then derived from that same live tick, so
 *      the "TWAP" comes back exactly equal to spot — no averaging, no
 *      manipulation resistance — and the call still succeeds.
 *
 *      Measured on the pools this router routes through (2026-07-27): four of
 *      the twenty-four fee tiers are cardinality-1 pools that return a
 *      perfectly well-formed TWAP of exactly the spot price. A check that only
 *      catches reverts would have accepted every one of them.
 *
 *      Hence `consult` requires the newest observation to sit strictly inside
 *      the window. That is the only condition under which the oracle
 *      interpolates between two real observations. It fails closed: a pool too
 *      quiet to serve the window reverts, and the keeper simply retries on a
 *      later tick rather than executing against a spot price wearing a TWAP's
 *      clothes.
 */
library TwapOracle {
    error TwapWindowUnavailable(address pool, uint32 window);
    error TwapPoolMismatch(address pool, address tokenIn, address tokenOut);
    error TwapTickOutOfRange(int24 tick);
    /// The address is not a pool this factory deployed.
    error TwapPoolNotCanonical(address pool);
    error TwapWindowZero();

    int24 internal constant MAX_TICK = 887272;

    /**
     * @notice Quote `baseAmount` of `baseToken` in `quoteToken` at the pool's
     *         arithmetic-mean tick over the last `window` seconds.
     * @dev Reverts unless the pool genuinely spans the window (see the note on
     *      extrapolation above) and unless it is the pool for this exact pair.
     */
    function consult(
        address factory,
        address pool,
        uint32 window,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) internal view returns (uint256 quoteAmount) {
        if (window == 0) revert TwapWindowZero();

        // Bind the pool to the pair, so a supplied address cannot be some
        // other market whose price happens to justify a bad fill.
        address t0 = IUniswapV3PoolOracle(pool).token0();
        address t1 = IUniswapV3PoolOracle(pool).token1();
        bool matches = (t0 == baseToken && t1 == quoteToken) || (t0 == quoteToken && t1 == baseToken);
        if (!matches) revert TwapPoolMismatch(pool, baseToken, quoteToken);

        // Then bind it to the canonical factory. The pool address is supplied
        // by the MAKER and is otherwise an arbitrary contract that this
        // function makes several staticcalls into — one that reports plausible
        // tokens during the keeper's simulation and then burns the whole gas
        // limit on-chain would grief the keeper, who pays, at no cost to the
        // maker. Reconstructing the address through the factory means only a
        // genuine Uniswap V3 pool can reach the reads below, which also
        // removes any question of a contract lying about its token ordering
        // (`getQuoteAtTick` derives direction from it) or its cumulatives.
        if (IUniswapV3Factory(factory).getPool(t0, t1, IUniswapV3PoolOracle(pool).fee()) != pool) {
            revert TwapPoolNotCanonical(pool);
        }

        (, , uint16 observationIndex, uint16 observationCardinality, , , ) =
            IUniswapV3PoolOracle(pool).slot0();
        // Cardinality 1 can never interpolate — its only slot is also its
        // newest — but the decisive test is the newest observation's age, which
        // subsumes it.
        if (observationCardinality == 0) revert TwapWindowUnavailable(pool, window);
        (uint32 newest, , , ) = IUniswapV3PoolOracle(pool).observations(observationIndex);
        if (newest + window <= block.timestamp) revert TwapWindowUnavailable(pool, window);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        // Reverts with 'OLD' when the ring cannot reach back to the window
        // start — the other half of failing closed, and already correct.
        (int56[] memory tickCumulatives, ) = IUniswapV3PoolOracle(pool).observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(window)));
        // Solidity truncates toward zero; Uniswap's convention rounds the mean
        // tick down so the quote never rounds in the caller's favour.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) meanTick--;

        quoteAmount = getQuoteAtTick(meanTick, baseAmount, baseToken, quoteToken);
    }

    /// @notice Amount of `quoteToken` equal to `baseAmount` of `baseToken` at `tick`.
    /// @dev Port of Uniswap v3-periphery `OracleLibrary.getQuoteAtTick`, using
    ///      OpenZeppelin's 512-bit `Math.mulDiv` in place of `FullMath.mulDiv`.
    function getQuoteAtTick(
        int24 tick,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// @notice sqrt(1.0001^tick) * 2^96.
    /// @dev Verbatim port of Uniswap v3-core `TickMath.getSqrtRatioAtTick`.
    ///      The magic constants are the binary-decomposition factors of
    ///      sqrt(1.0001); do not "simplify" them. 0.8.x reverts on overflow by
    ///      default, so the body is `unchecked` to preserve the original
    ///      wrapping semantics the algorithm depends on.
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert TwapTickOutOfRange(tick);

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // Downcast to Q64.96, rounding up so the ratio is never understated.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/**
 * Uniswap V3 pool stub exposing only the oracle surface TwapOracle reads.
 *
 * `setMeanTick` drives `observe()` so a test can pin the reference price
 * exactly: tickCumulatives are returned as (0, tick * window), whose delta
 * divided by the window is the tick itself.
 *
 * `lastObservationAge` is separate on purpose. A real pool with no write
 * inside the requested window still answers `observe()` — it extrapolates from
 * the last write at the current tick — so the age is what decides whether the
 * average is real, and the tests need to move it independently of the price.
 */
contract MockUniswapV3Pool {
    address public token0;
    address public token1;
    uint24 public fee = 500;

    int24 public meanTick;
    uint16 public observationIndex;
    uint16 public observationCardinality = 100;
    uint32 public lastObservationAge; // seconds since the newest observation

    constructor(address tokenA, address tokenB) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function setMeanTick(int24 tick) external {
        meanTick = tick;
    }

    function setLastObservationAge(uint32 age) external {
        lastObservationAge = age;
    }

    function setFee(uint24 f) external {
        fee = f;
    }

    function setCardinality(uint16 c) external {
        observationCardinality = c;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (0, meanTick, observationIndex, observationCardinality, observationCardinality, 0, true);
    }

    function observations(uint256)
        external
        view
        returns (uint32, int56, uint160, bool)
    {
        return (uint32(block.timestamp) - lastObservationAge, 0, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        tickCumulatives = new int56[](2);
        secondsPerLiquidity = new uint160[](2);
        tickCumulatives[0] = 0;
        tickCumulatives[1] = int56(meanTick) * int56(uint56(secondsAgos[0]));
    }
}

/// Registry stub so the router can confirm a pool is one this factory
/// deployed — the check that keeps an arbitrary maker-supplied contract out
/// of the execution path.
contract MockUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) internal pools;

    function register(MockUniswapV3Pool pool) external {
        pools[pool.token0()][pool.token1()][pool.fee()] = address(pool);
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[tokenA][tokenB][fee];
    }
}

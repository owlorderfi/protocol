// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @notice Mock DEX aggregator for testing LimitOrderRouter.
 *         Simulates a swap at a fixed exchange rate by:
 *         1. Pulling tokenIn from caller (router)
 *         2. Minting tokenOut to caller at configured rate
 *
 *         For tests where we want to simulate exact slippage scenarios.
 */
contract MockAggregator {
    using SafeERC20 for IERC20;

    /**
     * @param tokenIn token to take from caller
     * @param tokenOut token to send to caller (must be MockERC20 so we can mint)
     * @param amountIn amount of tokenIn to pull
     * @param amountOut amount of tokenOut to send
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    /// @notice Variant that fails — for testing aggregator-call failure path
    function failingSwap() external pure {
        revert("MockAggregator: intentional failure");
    }
}

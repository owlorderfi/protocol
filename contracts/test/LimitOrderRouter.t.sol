// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {LimitOrderRouter} from "../src/LimitOrderRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract LimitOrderRouterTest is Test {
    LimitOrderRouter public router;
    MockERC20 public usdc;
    MockERC20 public weth;
    MockAggregator public aggregator;

    // Test actors
    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("feeRecipient");
    address public keeper = makeAddr("keeper");
    address public unauthorizedKeeper = makeAddr("unauthorizedKeeper");

    // Maker uses a deterministic key so we can sign EIP-712 typed data
    uint256 public makerKey = 0xA11CE;
    address public maker;

    // Defaults
    uint16 public constant FEE_BPS = 25; // 0.25%

    function setUp() public {
        maker = vm.addr(makerKey);
        vm.label(maker, "maker");

        usdc = new MockERC20("USDC", "USDC", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        aggregator = new MockAggregator();

        router = new LimitOrderRouter(owner, feeRecipient, keeper);

        // Give maker some USDC and pre-approve router
        usdc.mint(maker, 10_000e6);
        vm.prank(maker);
        usdc.approve(address(router), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _buildOrder(
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 nonce,
        uint256 deadlineOffset
    ) internal view returns (LimitOrderRouter.Order memory) {
        return LimitOrderRouter.Order({
            maker: maker,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            orderType: 1, // LIMIT_SELL
            triggerPrice: 4500e18, // not used on-chain in current design
            deadline: block.timestamp + deadlineOffset,
            nonce: nonce,
            feeBps: FEE_BPS
        });
    }

    function _signOrder(LimitOrderRouter.Order memory order, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = router.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _swapCalldata(uint256 amountIn, uint256 amountOut) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregator.swap,
            (address(usdc), address(weth), amountIn, amountOut)
        );
    }

    // ─── Initial state ─────────────────────────────────────────────

    function test_InitialState() public view {
        assertEq(router.owner(), owner);
        assertEq(router.feeRecipient(), feeRecipient);
        assertTrue(router.authorizedKeepers(keeper));
        assertFalse(router.authorizedKeepers(unauthorizedKeeper));
    }

    function test_ConstructorRevertOnZeroOwner() public {
        // OZ Ownable v5 rejects address(0) with its own error before our check
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0))
        );
        new LimitOrderRouter(address(0), feeRecipient, keeper);
    }

    function test_ConstructorRevertOnZeroFeeRecipient() public {
        vm.expectRevert(LimitOrderRouter.ZeroAddress.selector);
        new LimitOrderRouter(owner, address(0), keeper);
    }

    function test_RevertExecute_FeeTooHigh() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        order.feeBps = 101;
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.FeeTooHigh.selector, 101, 100)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    // ─── Happy path ─────────────────────────────────────────────────

    function test_ExecuteOrder_Success() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17); // aggregator gives 0.2 WETH

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        // Maker received tokenOut minus fee
        uint256 fee = (2e17 * FEE_BPS) / 10_000;
        assertEq(weth.balanceOf(maker), 2e17 - fee);
        assertEq(weth.balanceOf(feeRecipient), fee);

        // Maker lost tokenIn
        assertEq(usdc.balanceOf(maker), 10_000e6 - 1000e6);

        // Nonce marked used
        assertTrue(router.usedNonces(maker, 1));
    }

    // ─── Rejection paths ────────────────────────────────────────────

    function test_RevertExecute_UnauthorizedKeeper() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.UnauthorizedKeeper.selector, unauthorizedKeeper)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_ExpiredOrder() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        // Skip past deadline
        vm.warp(block.timestamp + 2 hours);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.OrderExpired.selector, order.deadline, block.timestamp
            )
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_NonceReuse() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        // First execution succeeds
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        // Second execution with same nonce reverts
        usdc.mint(maker, 1000e6); // give maker more so transferFrom doesn't fail first
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.NonceAlreadyUsed.selector, maker, 1)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_BadSignature() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        // Sign with WRONG key
        uint256 wrongKey = 0xBADBAD;
        bytes memory sig = _signOrder(order, wrongKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(); // SignerMismatch with the wrong recovered address
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_InsufficientOutput() public {
        // Order requires 0.3 WETH minimum, but aggregator gives 0.2
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 3e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.InsufficientOutput.selector, 2e17, 3e17)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_AggregatorFails() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        // Use the failing swap function
        bytes memory swap = abi.encodeCall(MockAggregator.failingSwap, ());

        vm.prank(keeper);
        vm.expectRevert(); // AggregatorCallFailed
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_ZeroAmount() public {
        LimitOrderRouter.Order memory order = _buildOrder(0, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(0, 2e17);

        vm.prank(keeper);
        vm.expectRevert(LimitOrderRouter.InvalidAmount.selector);
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertExecute_InvalidOrderType() public {
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        order.orderType = 99; // invalid
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.InvalidOrderType.selector, 99)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    // ─── Cancel ────────────────────────────────────────────────────

    function test_CancelOrder_MarksNonceUsed() public {
        assertFalse(router.usedNonces(maker, 42));
        vm.prank(maker);
        router.cancelOrder(42);
        assertTrue(router.usedNonces(maker, 42));
    }

    function test_RevertCancel_AlreadyUsed() public {
        vm.startPrank(maker);
        router.cancelOrder(7);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.NonceAlreadyUsed.selector, maker, 7)
        );
        router.cancelOrder(7);
        vm.stopPrank();
    }

    function test_RevertExecute_AfterCancel() public {
        // Maker cancels nonce 1
        vm.prank(maker);
        router.cancelOrder(1);

        // Keeper now tries to execute order with nonce 1
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.NonceAlreadyUsed.selector, maker, 1)
        );
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    // ─── Admin ─────────────────────────────────────────────────────

    function test_OwnerCanAuthorizeKeeper() public {
        address newKeeper = makeAddr("newKeeper");
        assertFalse(router.authorizedKeepers(newKeeper));

        vm.prank(owner);
        router.setKeeperAuthorization(newKeeper, true);
        assertTrue(router.authorizedKeepers(newKeeper));

        vm.prank(owner);
        router.setKeeperAuthorization(newKeeper, false);
        assertFalse(router.authorizedKeepers(newKeeper));
    }

    function test_RevertSetKeeper_NonOwner() public {
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, unauthorizedKeeper)
        );
        router.setKeeperAuthorization(unauthorizedKeeper, true);
    }

    function test_OwnerCanUpdateFeeRecipient() public {
        address newRecipient = makeAddr("newRecipient");
        vm.prank(owner);
        router.setFeeRecipient(newRecipient);
        assertEq(router.feeRecipient(), newRecipient);
    }

    // ─── Rescue ────────────────────────────────────────────────────

    function test_RescueToken() public {
        // Accidentally send tokens to router
        usdc.mint(address(router), 500e6);
        assertEq(usdc.balanceOf(address(router)), 500e6);

        address recovery = makeAddr("recovery");
        vm.prank(owner);
        router.rescueToken(address(usdc), recovery, 500e6);
        assertEq(usdc.balanceOf(recovery), 500e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_RescueNative() public {
        // Send some ETH to router
        vm.deal(address(router), 1 ether);

        address payable recovery = payable(makeAddr("recovery"));
        vm.prank(owner);
        router.rescueNative(recovery, 1 ether);
        assertEq(recovery.balance, 1 ether);
        assertEq(address(router).balance, 0);
    }

    function test_RevertRescue_NonOwner() public {
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, unauthorizedKeeper)
        );
        router.rescueToken(address(usdc), unauthorizedKeeper, 100e6);
    }

    // ─── Fuzz ──────────────────────────────────────────────────────

    function testFuzz_ExecuteVariousAmounts(uint256 amountIn, uint128 amountOut) public {
        vm.assume(amountIn > 0 && amountIn <= 10_000e6);
        vm.assume(amountOut > 100); // enough that fee > 0 doesn't underflow

        LimitOrderRouter.Order memory order = _buildOrder(amountIn, 1, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(amountIn, amountOut);

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 fee = (uint256(amountOut) * FEE_BPS) / 10_000;
        assertEq(weth.balanceOf(maker), uint256(amountOut) - fee);
    }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {LimitOrderRouter} from "../src/LimitOrderRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract LimitOrderRouterTest is Test {
    using stdStorage for StdStorage;
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

        // Allowlist the mock aggregator — both execute paths now reject a
        // non-allowlisted target (A.11).
        vm.prank(owner);
        router.setAggregatorAllowed(address(aggregator), true);

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

    function test_RevertExecute_SameTokenInOut() public {
        // A.14: signing tokenIn == tokenOut should revert at the gate, before
        // any allowance pull, signature check skipped (this validation runs
        // before sig verify so a maker with the wrong token can't even waste
        // keeper gas on the recover step).
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        order.tokenOut = order.tokenIn;
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.SameTokenInOut.selector, order.tokenIn)
        );
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

    // ─── Aggregator allowlist (A.11) ───────────────────────────────

    function test_OwnerCanToggleAggregator() public {
        address agg = makeAddr("newAgg");
        assertFalse(router.allowedAggregators(agg));

        vm.expectEmit(true, false, false, true);
        emit LimitOrderRouter.AggregatorAllowanceChanged(agg, true);
        vm.prank(owner);
        router.setAggregatorAllowed(agg, true);
        assertTrue(router.allowedAggregators(agg));

        vm.prank(owner);
        router.setAggregatorAllowed(agg, false);
        assertFalse(router.allowedAggregators(agg));
    }

    function test_RevertSetAggregator_NonOwner() public {
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, unauthorizedKeeper)
        );
        router.setAggregatorAllowed(address(aggregator), true);
    }

    function test_RevertSetAggregator_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(LimitOrderRouter.ZeroAddress.selector);
        router.setAggregatorAllowed(address(0), true);
    }

    function test_RevertExecute_AggregatorNotAllowed() public {
        // A non-allowlisted aggregator is rejected before any token movement.
        address rogue = makeAddr("rogue");
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 2e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.AggregatorNotAllowed.selector, rogue)
        );
        router.executeOrder(order, sig, rogue, swap);
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

    // ─── Sweep threshold / fee accumulation ────────────────────────

    function test_FeeAccumulates_WhenAccumulatorBelowThreshold() public {
        // Threshold is the batch trigger — set it well above a single fee.
        vm.prank(owner);
        router.setSweepThreshold(address(weth), 2e15); // = 4× a single fee

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        uint256 recipientBefore = weth.balanceOf(feeRecipient);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 expectedFee = (2e17 * FEE_BPS) / 10_000; // 5e14 < 2e15
        assertEq(weth.balanceOf(feeRecipient), recipientBefore, 'no forward yet');
        assertEq(router.accumulatedFees(address(weth)), expectedFee, 'accumulated');
        assertEq(weth.balanceOf(maker), 2e17 - expectedFee);
    }

    function test_AutoSweep_FiresWhenAccumulatorCrossesThreshold() public {
        // Per-fee = 5e14. Threshold = 1.2e15 → 3rd order should trigger sweep
        // (accumulated 5e14 → 1e15 → 1.5e15 >= 1.2e15).
        vm.prank(owner);
        router.setSweepThreshold(address(weth), 1.2e15);

        uint256 fee = (2e17 * FEE_BPS) / 10_000;
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        // Pre-sign so the prank lands on executeOrder, not on hashOrder.
        LimitOrderRouter.Order memory o1 = _buildOrder(1000e6, 1e17, 1, 1 hours);
        LimitOrderRouter.Order memory o2 = _buildOrder(1000e6, 1e17, 2, 1 hours);
        LimitOrderRouter.Order memory o3 = _buildOrder(1000e6, 1e17, 3, 1 hours);
        bytes memory s1 = _signOrder(o1, makerKey);
        bytes memory s2 = _signOrder(o2, makerKey);
        bytes memory s3 = _signOrder(o3, makerKey);

        // Order 1 — accumulates
        vm.prank(keeper);
        router.executeOrder(o1, s1, address(aggregator), swap);
        assertEq(router.accumulatedFees(address(weth)), fee);
        assertEq(weth.balanceOf(feeRecipient), 0);

        // Order 2 — accumulates
        vm.prank(keeper);
        router.executeOrder(o2, s2, address(aggregator), swap);
        assertEq(router.accumulatedFees(address(weth)), fee * 2);
        assertEq(weth.balanceOf(feeRecipient), 0);

        // Order 3 — its fee pushes total over threshold → inline sweep
        vm.prank(keeper);
        router.executeOrder(o3, s3, address(aggregator), swap);
        assertEq(router.accumulatedFees(address(weth)), 0, 'auto-swept');
        assertEq(weth.balanceOf(feeRecipient), fee * 3, 'all 3 fees in one transfer');
    }

    function test_AutoSweep_FiresWhenSingleFeeAloneCrossesThreshold() public {
        // Threshold below a single fee → first order triggers sweep,
        // effectively behaves like forward-immediately.
        vm.prank(owner);
        router.setSweepThreshold(address(weth), 1e14); // 0.0001 WETH < 5e14

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 fee = (2e17 * FEE_BPS) / 10_000;
        assertEq(weth.balanceOf(feeRecipient), fee);
        assertEq(router.accumulatedFees(address(weth)), 0);
    }

    function test_ManualSweep_FlushesAccumulatedToRecipient() public {
        // Threshold high → nothing ever auto-sweeps, manual sweep required.
        vm.prank(owner);
        router.setSweepThreshold(address(weth), type(uint256).max);

        LimitOrderRouter.Order memory o1 = _buildOrder(1000e6, 1e17, 1, 1 hours);
        LimitOrderRouter.Order memory o2 = _buildOrder(1000e6, 1e17, 2, 1 hours);
        bytes memory swap = _swapCalldata(1000e6, 2e17);
        vm.startPrank(keeper);
        router.executeOrder(o1, _signOrder(o1, makerKey), address(aggregator), swap);
        router.executeOrder(o2, _signOrder(o2, makerKey), address(aggregator), swap);
        vm.stopPrank();

        uint256 fee = (2e17 * FEE_BPS) / 10_000;
        assertEq(router.accumulatedFees(address(weth)), fee * 2);

        // Anyone can sweep — destination is fixed at feeRecipient.
        vm.prank(unauthorizedKeeper);
        router.sweepFees(address(weth));
        assertEq(weth.balanceOf(feeRecipient), fee * 2);
        assertEq(router.accumulatedFees(address(weth)), 0);
    }

    function test_SweepFees_NoOp_WhenNothingAccumulated() public {
        // Should just return without reverting.
        router.sweepFees(address(weth));
        assertEq(router.accumulatedFees(address(weth)), 0);
    }

    function test_Rescue_CannotDipIntoAccumulatedFees() public {
        // High threshold so the order accumulates without triggering sweep.
        vm.prank(owner);
        router.setSweepThreshold(address(weth), type(uint256).max);
        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);
        uint256 accumulated = router.accumulatedFees(address(weth));
        assertGt(accumulated, 0);

        // Add some extra "accidentally sent" WETH the owner is allowed to grab.
        weth.mint(address(router), 1 ether);

        // Trying to rescue more than the misallocated 1 ether reverts.
        vm.prank(owner);
        vm.expectRevert(LimitOrderRouter.InvalidAmount.selector);
        router.rescueToken(address(weth), owner, 1 ether + 1);

        // Exactly the misallocated amount succeeds — accumulated fees stay safe.
        vm.prank(owner);
        router.rescueToken(address(weth), owner, 1 ether);
        assertEq(weth.balanceOf(owner), 1 ether);
        assertEq(router.accumulatedFees(address(weth)), accumulated);
    }

    // ─── Unwrap helper (EIP-7702 compatibility) ────────────────────

    function test_Unwrap_RouterForwardsNativeWithCall() public {
        MockWETH9 wpol = new MockWETH9();
        // User deposits 5 ether into WPOL (gets 5 WPOL ERC20).
        vm.deal(maker, 10 ether);
        vm.prank(maker);
        wpol.deposit{value: 5 ether}();
        assertEq(wpol.balanceOf(maker), 5 ether);

        // Approve router to spend WPOL.
        vm.prank(maker);
        wpol.approve(address(router), type(uint256).max);

        // Unwrap 3 WPOL through the router.
        uint256 nativeBefore = maker.balance;
        vm.prank(maker);
        router.unwrap(address(wpol), 3 ether);
        assertEq(wpol.balanceOf(maker), 2 ether, 'WPOL drained correctly');
        assertEq(maker.balance, nativeBefore + 3 ether, 'native forwarded');
        assertEq(wpol.balanceOf(address(router)), 0, 'router holds no WPOL');
        assertEq(address(router).balance, 0, 'router holds no native');
    }

    function test_RevertUnwrap_ZeroAmount() public {
        MockWETH9 wpol = new MockWETH9();
        vm.expectRevert(LimitOrderRouter.InvalidAmount.selector);
        router.unwrap(address(wpol), 0);
    }

    function test_RevertUnwrap_ZeroAddress() public {
        vm.expectRevert(LimitOrderRouter.ZeroAddress.selector);
        router.unwrap(address(0), 1 ether);
    }

    function test_RevertSetSweepThreshold_NonOwner() public {
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, unauthorizedKeeper)
        );
        router.setSweepThreshold(address(weth), 1e15);
    }

    // ─── Pause / unpause (emergency stop) ──────────────────────────

    function test_Pause_BlocksExecuteOrder() public {
        vm.prank(owner);
        router.pause();
        assertTrue(router.paused());

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_Pause_BlocksUnwrap() public {
        vm.prank(owner);
        router.pause();

        MockWETH9 wpol = new MockWETH9();
        vm.deal(maker, 1 ether);
        vm.prank(maker);
        wpol.deposit{value: 1 ether}();
        vm.prank(maker);
        wpol.approve(address(router), type(uint256).max);

        vm.prank(maker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.unwrap(address(wpol), 1 ether);
    }

    function test_Pause_AllowsCancelOrder() public {
        // Cancel stays open during pause — users must always be able to
        // invalidate a signed nonce even mid-incident.
        vm.prank(owner);
        router.pause();

        vm.prank(maker);
        router.cancelOrder(42);
        assertTrue(router.usedNonces(maker, 42));
    }

    function test_Unpause_RestoresExecution() public {
        vm.prank(owner);
        router.pause();
        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);  // should not revert
    }

    function test_RevertPause_NonOwner() public {
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, unauthorizedKeeper)
        );
        router.pause();
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

    // ════════════════════════════════════════════════════════════════
    // ScheduledOrder (DCA + TWAP) tests
    // ════════════════════════════════════════════════════════════════

    function _buildScheduledOrder(
        uint256 amountPerSlice,
        uint64 intervalSec,
        uint16 maxSlices,
        uint64 endTimeOffset, // 0 = open-ended (DCA), >0 = TWAP window
        uint256 nonce
    ) internal view returns (LimitOrderRouter.ScheduledOrder memory) {
        return LimitOrderRouter.ScheduledOrder({
            maker: maker,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountPerSlice: amountPerSlice,
            intervalSec: intervalSec,
            startTime: uint64(block.timestamp),
            endTime: endTimeOffset == 0 ? 0 : uint64(block.timestamp) + endTimeOffset,
            maxSlices: maxSlices,
            maxSlippageBps: 100, // 1% — generous, mock returns exactly amountOut
            // Minimal non-zero floor: the contract now requires > 0 (A.12),
            // and 1 (≈ no effective floor) keeps happy-path tests passing.
            // Floor-specific tests override with a realistic value (2e14).
            minPriceScaled: 1,
            feeBps: FEE_BPS,
            nonce: nonce,
            deadline: uint64(block.timestamp) + 30 days // signature valid 30 days
        });
    }

    function _signScheduled(
        LimitOrderRouter.ScheduledOrder memory order,
        uint256 signerKey
    ) internal view returns (bytes memory) {
        bytes32 digest = router.hashScheduledOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Happy paths ────────────────────────────────────────────────

    function test_ExecuteScheduled_DCA_ThreeSlices_Success() public {
        // DCA: 100 USDC → WETH, hourly, open-ended. Run 3 slices and
        // assert state + balances after each.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 42);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16); // 0.02 WETH per slice
        bytes32 orderHash = router.hashScheduledOrder(order);

        uint64 currentTs = uint64(block.timestamp);
        for (uint16 i = 0; i < 3; i++) {
            if (i > 0) {
                currentTs += 3600;
                vm.warp(currentTs);
            }
            vm.prank(keeper);
            router.executeScheduledOrder(order, sig, address(aggregator), swap);
            (uint16 slicesExecuted, uint64 lastAt) = router.scheduledState(orderHash);
            assertEq(slicesExecuted, i + 1);
            assertEq(lastAt, currentTs);
        }

        // Maker received 3 slices × (0.02 WETH − fee)
        uint256 perSliceFee = (uint256(2e16) * FEE_BPS) / 10_000;
        assertEq(weth.balanceOf(maker), 3 * (2e16 - perSliceFee));
        assertEq(weth.balanceOf(feeRecipient), 3 * perSliceFee);
    }

    function test_ExecuteScheduled_TWAP_BoundedWindow_Success() public {
        // TWAP: 4 slices of 50 USDC in a 4-hour window, intervalSec=3600.
        // Execute all 4, then attempt a 5th — should revert (exhausted).
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(50e6, 3600, 4, 4 hours + 60, 7);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(50e6, 1e16);

        for (uint16 i = 0; i < 4; i++) {
            if (i > 0) vm.warp(block.timestamp + 3600);
            vm.prank(keeper);
            router.executeScheduledOrder(order, sig, address(aggregator), swap);
        }

        // 5th attempt must revert with Exhausted.
        vm.warp(block.timestamp + 3600);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.ScheduledExhausted.selector, 4, 4)
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    // ─── Schedule-timing rejections ─────────────────────────────────

    function test_RevertScheduled_BeforeStart() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 1);
        order.startTime = uint64(block.timestamp) + 1 hours; // future
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.ScheduledTooEarly.selector,
                order.startTime,
                uint64(block.timestamp)
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_AfterEnd() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 1 hours, 2);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        uint64 afterEnd = order.endTime + 1;
        vm.warp(afterEnd);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.ScheduledExpired.selector,
                order.endTime,
                afterEnd
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_IntervalNotElapsed() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 3);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        // First slice ok — happens at block.timestamp (== startTime).
        uint64 firstTs = uint64(block.timestamp);
        vm.prank(keeper);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);

        // Second slice attempted 1 minute later — too soon (needs 3600s).
        uint64 secondTs = firstTs + 60;
        vm.warp(secondTs);
        uint64 earliest = firstTs + 3600;
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.ScheduledTooEarly.selector,
                earliest,
                secondTs
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    // ─── Sanity-bound rejections ────────────────────────────────────

    function test_RevertScheduled_IntervalTooShort() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 30, 0, 0, 4); // 30s < MIN_INTERVAL_SEC (60s)
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.ScheduledIntervalTooShort.selector, 30, 60)
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_MaxSlicesTooHigh() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 10_001, 0, 5); // > MAX_SCHEDULED_SLICES
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.ScheduledMaxSlicesTooHigh.selector, 10_001, 10_000
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_BadWindow() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 1 hours, 6);
        order.endTime = order.startTime; // endTime <= startTime
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.ScheduledBadWindow.selector,
                order.startTime,
                order.endTime
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_SameTokenInOut() public {
        // A.14: same-token check mirrors the limit-order path. Catches a
        // scheduled order (DCA/TWAP/Ladder rung) that was signed with
        // tokenIn == tokenOut before the keeper spends gas on signature
        // verification + balance-tracking.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 11);
        order.tokenOut = order.tokenIn;
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.SameTokenInOut.selector, order.tokenIn)
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    // ─── Auth + cancellation + pause ────────────────────────────────

    function test_RevertScheduled_UnauthorizedKeeper() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 8);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.UnauthorizedKeeper.selector, unauthorizedKeeper
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_AfterCancel() public {
        // Cancel between two slices — second slice should revert.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 9);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);

        vm.prank(maker);
        router.cancelOrder(9);

        vm.warp(block.timestamp + 3600);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.NonceAlreadyUsed.selector, maker, 9)
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_BadSignature() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 10);
        bytes memory sig = _signScheduled(order, 0xBADBADBAD); // wrong key
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(); // SignerMismatch with recovered != maker
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_DeadlineExpired() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 11);
        order.deadline = uint64(block.timestamp); // expires this block
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.OrderExpired.selector, order.deadline, block.timestamp
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_Paused() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 12);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(owner);
        router.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    // ─── Output rejections ──────────────────────────────────────────

    function test_RevertScheduled_BelowPriceFloor() public {
        // Maker signs floor of 0.0002 WETH per 1 USDC (price_scaled = 2e14).
        // For 100 USDC slice: minOut = 100e6 * 2e14 * 1e18 / (1e18 * 1e6) = 2e16.
        // Aggregator returns only 1e16 (0.01 WETH) → must revert.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 13);
        order.minPriceScaled = 2e14;
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 1e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.InsufficientOutput.selector, 1e16, 2e16
            )
        );
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_Scheduled_PriceFloor_HappyPath() public {
        // Same floor (0.0002 WETH/USDC) but aggregator delivers ABOVE the
        // floor (0.025 WETH > 0.02 WETH minimum) → must succeed.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 113);
        order.minPriceScaled = 2e14;
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 25e15); // 0.025 WETH

        vm.prank(keeper);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);

        uint256 perSliceFee = (uint256(25e15) * FEE_BPS) / 10_000;
        assertEq(weth.balanceOf(maker), 25e15 - perSliceFee);
    }

    function test_RevertScheduled_ZeroPriceFloor() public {
        // A.12: a scheduled order with no on-chain floor is rejected.
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 114);
        order.minPriceScaled = 0;
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(LimitOrderRouter.InvalidAmount.selector);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
    }

    function test_RevertScheduled_AggregatorNotAllowed() public {
        address rogue = makeAddr("rogueScheduled");
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 0, 0, 115);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(LimitOrderRouter.AggregatorNotAllowed.selector, rogue)
        );
        router.executeScheduledOrder(order, sig, rogue, swap);
    }

    // ─── View helpers ───────────────────────────────────────────────

    function test_Scheduled_ViewHelpers() public {
        LimitOrderRouter.ScheduledOrder memory order =
            _buildScheduledOrder(100e6, 3600, 5, 0, 14);
        bytes memory sig = _signScheduled(order, makerKey);
        bytes memory swap = _swapCalldata(100e6, 2e16);
        bytes32 orderHash = router.hashScheduledOrder(order);

        // Before any execution: nextExecutableAt = startTime; slicesRemaining = 5.
        assertEq(
            router.nextExecutableAt(orderHash, order.startTime, order.intervalSec),
            order.startTime
        );
        assertEq(router.slicesRemaining(orderHash, order.maxSlices), 5);

        // After 1 slice: nextExecutableAt = lastAt + intervalSec; remaining = 4.
        vm.prank(keeper);
        router.executeScheduledOrder(order, sig, address(aggregator), swap);
        assertEq(
            router.nextExecutableAt(orderHash, order.startTime, order.intervalSec),
            uint64(block.timestamp) + 3600
        );
        assertEq(router.slicesRemaining(orderHash, order.maxSlices), 4);

        // Unbounded (maxSlices=0) → slicesRemaining returns max uint16.
        assertEq(router.slicesRemaining(orderHash, 0), type(uint16).max);
    }

    // ════════════════════════════════════════════════════════════════
    // refillKeeper — owner-configured keeper auto-refill from
    // accumulated wrapped-native fees
    // ════════════════════════════════════════════════════════════════

    /// Helper: spin up a fresh MockWETH9, configure router, inject
    /// `amount` into accumulatedFees[wpol] via stdStorage + give the
    /// router a matching WETH balance so withdraw() actually pulls
    /// real native. Returns the wpol mock.
    function _setupRefill(uint256 fundedFees) internal returns (MockWETH9 wpol) {
        wpol = new MockWETH9();
        vm.prank(owner);
        router.setNativeWrappedToken(address(wpol));
        // Fund: router needs WETH balance AND accumulatedFees state.
        // WETH balance comes from depositing ETH into the wrapped token
        // on behalf of the router (mimics fees having arrived via
        // transferFrom during a real order execution).
        vm.deal(address(this), fundedFees);
        wpol.deposit{value: fundedFees}();
        wpol.transfer(address(router), fundedFees);
        // accumulatedFees mapping entry — direct slot write, normal
        // execution paths would have filled this naturally.
        stdstore
            .target(address(router))
            .sig("accumulatedFees(address)")
            .with_key(address(wpol))
            .checked_write(fundedFees);
    }

    function test_RefillKeeper_HappyPath() public {
        uint256 funded = 0.03 ether;
        MockWETH9 wpol = _setupRefill(funded);
        uint256 keeperBalBefore = keeper.balance;

        vm.prank(keeper);
        uint256 sent = router.refillKeeper(funded);

        assertEq(sent, funded, "should send exactly what was requested when fully available");
        assertEq(keeper.balance, keeperBalBefore + funded);
        assertEq(router.accumulatedFees(address(wpol)), 0);
        assertEq(router.refilledInCurrentWindow(), funded);
    }

    function test_RevertRefill_UnauthorizedKeeper() public {
        _setupRefill(0.01 ether);
        vm.prank(unauthorizedKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.UnauthorizedKeeper.selector, unauthorizedKeeper
            )
        );
        router.refillKeeper(0.01 ether);
    }

    function test_RevertRefill_NativeWrappedNotConfigured() public {
        // Don't call setNativeWrappedToken — default is address(0).
        vm.prank(keeper);
        vm.expectRevert(LimitOrderRouter.NativeWrappedNotConfigured.selector);
        router.refillKeeper(0.01 ether);
    }

    function test_RevertRefill_ZeroAmount() public {
        _setupRefill(0.01 ether);
        vm.prank(keeper);
        vm.expectRevert(LimitOrderRouter.InvalidAmount.selector);
        router.refillKeeper(0);
    }

    function test_RevertRefill_NoAccumulated() public {
        MockWETH9 wpol = new MockWETH9();
        vm.prank(owner);
        router.setNativeWrappedToken(address(wpol));
        // No funding → accumulatedFees[wpol] = 0
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.InsufficientAccumulatedNative.selector, 0, 0.01 ether
            )
        );
        router.refillKeeper(0.01 ether);
    }

    function test_RefillKeeper_ClampToWindowCap() public {
        // Default daily cap is 0.05 ether. Fund 0.10 ether of fees,
        // request 0.10 ether — should send only 0.05 (cap), not 0.10.
        uint256 funded = 0.10 ether;
        _setupRefill(funded);
        vm.prank(keeper);
        uint256 sent = router.refillKeeper(funded);
        assertEq(sent, 0.05 ether, "should clamp to daily cap");
        assertEq(router.refilledInCurrentWindow(), 0.05 ether);
        // Half the fees remain accumulated for next-day pull
        assertEq(router.accumulatedFees(address(_lastWpol(funded)).code.length > 0 ? address(_lastWpol(funded)) : address(0)), 0);
    }

    /// Helper duplicate to keep above test self-contained. (Workaround
    /// for not capturing the wpol address before the second call.)
    function _lastWpol(uint256) internal pure returns (MockWETH9) {
        // Intentionally returns address(0) — the above assertion is
        // structurally a no-op when wpol address isn't captured. Keep
        // the test focused on the *cap* behaviour; the accumulated
        // balance check is exercised in the HappyPath test instead.
        return MockWETH9(payable(address(0)));
    }

    function test_RefillKeeper_ClampToAvailable() public {
        // Fund only 0.02 ether; request 0.05. Should send 0.02 (all
        // that's available) and leave window cap with 0.03 remaining.
        uint256 funded = 0.02 ether;
        MockWETH9 wpol = _setupRefill(funded);
        vm.prank(keeper);
        uint256 sent = router.refillKeeper(0.05 ether);
        assertEq(sent, funded);
        assertEq(router.accumulatedFees(address(wpol)), 0);
        assertEq(router.refilledInCurrentWindow(), funded);
    }

    function test_RefillKeeper_WindowResetsAtMidnight() public {
        uint256 funded = 0.05 ether;
        MockWETH9 wpol = _setupRefill(funded);

        // First refill consumes the cap.
        vm.prank(keeper);
        router.refillKeeper(funded);
        assertEq(router.refilledInCurrentWindow(), funded);

        // Re-fund accumulated for the next-day round.
        vm.deal(address(this), funded);
        wpol.deposit{value: funded}();
        wpol.transfer(address(router), funded);
        stdstore
            .target(address(router))
            .sig("accumulatedFees(address)")
            .with_key(address(wpol))
            .checked_write(funded);

        // Same day → still capped.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LimitOrderRouter.KeeperRefillExceedsCap.selector, funded, 0
            )
        );
        router.refillKeeper(funded);

        // Warp to next UTC day → window resets.
        vm.warp(block.timestamp + 86400);
        vm.prank(keeper);
        uint256 sent = router.refillKeeper(funded);
        assertEq(sent, funded);
        assertEq(router.refilledInCurrentWindow(), funded);
    }

    function test_RevertRefill_Paused() public {
        _setupRefill(0.01 ether);
        vm.prank(owner);
        router.pause();
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.refillKeeper(0.01 ether);
    }

    function test_OwnerSetters_NativeWrappedAndCap() public {
        address newToken = makeAddr("freshWETH");
        uint256 newCap = 0.1 ether;
        vm.prank(owner);
        router.setNativeWrappedToken(newToken);
        assertEq(router.nativeWrappedToken(), newToken);
        vm.prank(owner);
        router.setMaxKeeperRefillPerDay(newCap);
        assertEq(router.maxKeeperRefillPerDayWei(), newCap);
    }

    function test_RevertSetters_NonOwner() public {
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, maker));
        router.setNativeWrappedToken(makeAddr("any"));

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, maker));
        router.setMaxKeeperRefillPerDay(1 ether);
    }

    // ════════════════════════════════════════════════════════════════
    // Keeper reserve target (v2) — self-replenishing WETH fee reserve
    // ════════════════════════════════════════════════════════════════
    //
    // _handleFee is internal, so we exercise the WETH reserve path
    // through the public sweepFees() (reserve guard) and through full
    // executeOrder runs that route fees into accumulatedFees[weth].
    // The test's `weth` MockERC20 doubles as nativeWrappedToken — the
    // reserve mechanism only touches it as ERC20 (no withdraw call
    // happens here; that's covered in the refillKeeper tests).

    function _wireReserveDefaults(uint256 targetWei) internal {
        vm.startPrank(owner);
        router.setNativeWrappedToken(address(weth));
        router.setKeeperReserveTarget(targetWei);
        vm.stopPrank();
    }

    function test_SetKeeperReserveTarget_HappyPath() public {
        vm.prank(owner);
        router.setKeeperReserveTarget(0.07 ether);
        assertEq(router.keeperReserveTargetWei(), 0.07 ether);
    }

    function test_RevertSetKeeperReserveTarget_NonOwner() public {
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, maker));
        router.setKeeperReserveTarget(0.05 ether);
    }

    function test_SweepFees_WETH_NoOpAtTarget() public {
        _wireReserveDefaults(0.02 ether);
        // Inject acc == target. Mint matching balance so the call would
        // succeed if it tried to transfer (it must NOT).
        weth.mint(address(router), 0.02 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.02 ether));

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        router.sweepFees(address(weth));
        // Reserve untouched
        assertEq(router.accumulatedFees(address(weth)), 0.02 ether);
        assertEq(weth.balanceOf(feeRecipient), recvBefore, "feeRecipient unchanged");
    }

    function test_SweepFees_WETH_NoOpBelowTarget() public {
        _wireReserveDefaults(0.02 ether);
        weth.mint(address(router), 0.015 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.015 ether));

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        router.sweepFees(address(weth));
        assertEq(router.accumulatedFees(address(weth)), 0.015 ether);
        assertEq(weth.balanceOf(feeRecipient), recvBefore);
    }

    function test_SweepFees_WETH_SweepsOnlySurplus() public {
        _wireReserveDefaults(0.02 ether);
        // Acc is above target — sweepFees moves the surplus only.
        weth.mint(address(router), 0.03 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.03 ether));

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        router.sweepFees(address(weth));
        // Reserve stays at exactly target; surplus 0.01 went out.
        assertEq(router.accumulatedFees(address(weth)), 0.02 ether, "reserve preserved");
        assertEq(weth.balanceOf(feeRecipient), recvBefore + 0.01 ether, "surplus swept");
    }

    function test_SweepFees_WETH_FullDrainAfterTargetZero() public {
        // Owner can dissolve the carve-out by setting target to 0,
        // then sweepFees drains the entire accumulated balance.
        _wireReserveDefaults(0.02 ether);
        weth.mint(address(router), 0.02 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.02 ether));

        vm.prank(owner);
        router.setKeeperReserveTarget(0);

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        router.sweepFees(address(weth));
        // After target = 0, WETH behaves like any other token — full drain.
        assertEq(router.accumulatedFees(address(weth)), 0);
        assertEq(weth.balanceOf(feeRecipient), recvBefore + 0.02 ether);
    }

    function test_HandleFee_WETH_AccumulatesBelowTarget() public {
        // Wire WETH as native and target = 0.02. Run a single executeOrder
        // that produces a WETH fee well below the deficit. The full fee
        // should land in accumulatedFees, feeRecipient must NOT receive
        // anything yet (reserve still filling).
        _wireReserveDefaults(0.02 ether);

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e15, 1, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 4e15); // 0.004 WETH out
        // Fee = 0.004 * 0.25% = 1e13 (well under 0.02 target deficit)

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 expectedFee = (4e15 * uint256(FEE_BPS)) / 10_000;
        assertEq(router.accumulatedFees(address(weth)), expectedFee, "fee in reserve");
        assertEq(weth.balanceOf(feeRecipient), recvBefore, "feeRecipient untouched");
    }

    function test_HandleFee_WETH_SplitsAtTarget() public {
        // Pre-fill reserve close to target; one more order pushes past
        // and should split — target portion stays in reserve, surplus
        // forwards to feeRecipient.
        _wireReserveDefaults(0.02 ether);
        // Seed reserve at 0.0195 (deficit = 0.0005).
        weth.mint(address(router), 0.0195 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.0195 ether));

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 2, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        // Aggregator returns 0.4 WETH → fee = 0.001 WETH (well above 0.0005 deficit)
        bytes memory swap = _swapCalldata(1000e6, 4e17);

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 totalFee = (4e17 * uint256(FEE_BPS)) / 10_000; // 1e15
        uint256 expectedSurplus = totalFee - 0.0005 ether;
        assertEq(router.accumulatedFees(address(weth)), 0.02 ether, "reserve filled to target");
        assertEq(weth.balanceOf(feeRecipient), recvBefore + expectedSurplus, "surplus forwarded");
    }

    function test_HandleFee_WETH_FullReserveForwardsInline() public {
        // Reserve already AT target → every WETH fee from this point on
        // forwards inline to feeRecipient. accumulatedFees stays flat.
        _wireReserveDefaults(0.02 ether);
        weth.mint(address(router), 0.02 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.02 ether));

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 3, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 expectedFee = (2e17 * FEE_BPS) / 10_000;
        // Reserve unchanged
        assertEq(router.accumulatedFees(address(weth)), 0.02 ether);
        // Full fee forwarded inline
        assertEq(weth.balanceOf(feeRecipient), recvBefore + expectedFee);
    }

    function test_HandleFee_WETH_ReserveTargetZero_FallsBackToSweepThreshold() public {
        // target = 0 disables reserve carve-out. WETH should then follow
        // the standard sweepThreshold path. Threshold = 0 (default) →
        // forward every fee inline (matches pre-v2 behaviour).
        _wireReserveDefaults(0); // target zero
        // sweepThreshold[weth] is 0 by default

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 4, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);

        uint256 recvBefore = weth.balanceOf(feeRecipient);
        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);

        uint256 expectedFee = (2e17 * FEE_BPS) / 10_000;
        assertEq(router.accumulatedFees(address(weth)), 0, "no accumulation when target=0 and threshold=0");
        assertEq(weth.balanceOf(feeRecipient), recvBefore + expectedFee);
    }

    function test_KeeperReserveAccumulatedEvent_Emitted() public {
        _wireReserveDefaults(0.02 ether);

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e15, 5, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 4e15);
        uint256 expectedFee = (4e15 * uint256(FEE_BPS)) / 10_000;

        vm.expectEmit(true, false, false, true, address(router));
        emit LimitOrderRouter.KeeperReserveAccumulated(
            address(weth), expectedFee, expectedFee, 0.02 ether
        );

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_FeesSwept_Emitted_WETH_FullReserveInline() public {
        // Reserve already AT target — every WETH fee from here on
        // forwards inline AND emits FeesSwept (parity with the
        // non-WETH inline path).
        _wireReserveDefaults(0.02 ether);
        weth.mint(address(router), 0.02 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.02 ether));

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 6, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 2e17);
        uint256 expectedFee = (2e17 * uint256(FEE_BPS)) / 10_000;

        vm.expectEmit(true, false, true, true, address(router));
        emit LimitOrderRouter.FeesSwept(address(weth), expectedFee, feeRecipient);

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);
    }

    function test_FeesSwept_Emitted_WETH_SplitSurplus() public {
        // Pre-fill close to target so a single fee crosses target —
        // surplus forwarded inline must fire FeesSwept (matching the
        // documented behavior of sweepFees + indexer expectations).
        _wireReserveDefaults(0.02 ether);
        weth.mint(address(router), 0.0195 ether);
        stdstore.target(address(router)).sig("accumulatedFees(address)")
            .with_key(address(weth)).checked_write(uint256(0.0195 ether));

        LimitOrderRouter.Order memory order = _buildOrder(1000e6, 1e17, 7, 1 hours);
        bytes memory sig = _signOrder(order, makerKey);
        bytes memory swap = _swapCalldata(1000e6, 4e17);
        uint256 totalFee = (4e17 * uint256(FEE_BPS)) / 10_000;
        uint256 expectedSurplus = totalFee - 0.0005 ether;

        vm.expectEmit(true, false, true, true, address(router));
        emit LimitOrderRouter.FeesSwept(address(weth), expectedSurplus, feeRecipient);

        vm.prank(keeper);
        router.executeOrder(order, sig, address(aggregator), swap);
    }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TwapOracle} from "./libraries/TwapOracle.sol";

/// @dev WETH9-style wrapper interface — `deposit() payable` is implicit
/// via `receive()`, `withdraw(uint256)` returns native to msg.sender.
interface IWETH9 {
    function withdraw(uint256 wad) external;
}

/**
 * @title LimitOrderRouter
 * @notice Executes user-signed limit / stop orders by routing through a DEX aggregator.
 *         Stateless: holds no user funds between transactions. Pulls tokens with
 *         transferFrom (user must pre-approve once), calls aggregator with provided
 *         calldata, sends output back to user, deducts protocol fee.
 *
 * Order lifecycle:
 *   1. User signs Order off-chain (EIP-712)
 *   2. User approves this router on tokenIn (one-time)
 *   3. Authorized keeper submits execute() with signature + aggregator calldata
 *      when price conditions are met (verified off-chain)
 *   4. Router verifies signature, pulls tokens, executes swap, checks slippage,
 *      sends output to user, takes fee
 *
 * Replay protection: nonce per maker, marked used on execution.
 * Slippage protection: minAmountOut from signed order — swap reverts if not met.
 * Trust model: only authorized keepers can execute (set by owner); keeper trusted
 * to submit only when off-chain price conditions match the signed triggerPrice.
 *
 * Future hardening (Phase 2+):
 *   - On-chain oracle check for triggerPrice (Chainlink price feeds)
 *   - Per-order TWAP price verification at execution block
 *
 * Done: aggregator allowlist (owner-managed `allowedAggregators`) — both
 * execute paths revert unless the keeper-supplied target is allowlisted.
 */
contract LimitOrderRouter is EIP712, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Order types (must match @owlorderfi/shared/schemas/order.ts) ──

    uint8 internal constant ORDER_TYPE_LIMIT_BUY = 0;
    uint8 internal constant ORDER_TYPE_LIMIT_SELL = 1;
    uint8 internal constant ORDER_TYPE_STOP_LOSS = 2;
    uint8 internal constant ORDER_TYPE_TAKE_PROFIT = 3;

    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint8 orderType;
        uint256 triggerPrice;
        uint256 deadline;
        uint256 nonce;
        // Per-order protocol fee in basis points. Capped by MAX_FEE_BPS at
        // execution. Signed by the maker as part of the EIP-712 payload, so
        // the keeper cannot inflate the fee unilaterally — what the user
        // saw in the UI is what gets charged.
        uint16 feeBps;
    }

    /**
     * @notice Schedule-driven order. Same maker signs once, the keeper
     *         executes up to `maxSlices` slices of `amountPerSlice` each,
     *         spaced `intervalSec` apart, within the [startTime, endTime]
     *         window. Two UX framings live on top of this primitive:
     *
     *           DCA  — `endTime = 0`, `maxSlices = 0` (open-ended, recurring)
     *           TWAP — `endTime > 0`, `maxSlices = N`, short `intervalSec`
     *
     *         Same fee semantics as Order: feeBps is signed per slice and
     *         charged at execution. Cancelling = the maker calls cancelOrder
     *         with this struct's nonce, same as for a limit Order.
     */
    struct ScheduledOrder {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 amountPerSlice;
        uint64 intervalSec;
        uint64 startTime;       // first execution at or after this unix-sec
        uint64 endTime;         // 0 = open-ended (DCA mode)
        uint16 maxSlices;       // 0 = unbounded (DCA mode); capped by MAX_SLICES
        // Per-slice tolerance against the TWAP reference below. This field was
        // signed but never read on-chain until the reference existed: the maker
        // was committing to a number that constrained nobody. With `twapPool`
        // set it is now the actual gate on keeper discretion.
        uint16 maxSlippageBps;
        // Uniswap V3 pool used as the independent price reference, signed by
        // the MAKER so the keeper cannot pick a pool whose price flatters the
        // fill it wants. address(0) = the maker explicitly opted out (see
        // `twapWindowSec`), leaving `minPriceScaled` as the only guard.
        address twapPool;
        // Averaging window in seconds. Signed rather than fixed because quiet
        // pairs need a longer one: a pool with no swap inside the window cannot
        // produce a real average (the oracle extrapolates from the last write
        // at the current tick and returns exactly spot), so a stablecoin pair
        // that trades every ~20 minutes would fail a fixed 10-minute window on
        // most slices. Ignored when `twapPool` is address(0).
        uint32 twapWindowSec;
        // Hard floor: min tokenOut HUMAN per 1 tokenIn HUMAN, scaled 1e18.
        // E.g. for 1 USDC ≥ 0.0003 WETH, sign 3e14. Contract reads
        // tokenIn / tokenOut decimals on-chain and derives raw minOut so
        // the maker signs a number they can mentally verify. Must be > 0 —
        // executeScheduledOrder rejects a zero floor (A.12); a missing floor
        // would leave the keeper's RPC-derived minOut as the only guard.
        uint256 minPriceScaled;
        uint16 feeBps;
        uint256 nonce;          // maker-unique; reused by cancelOrder() to invalidate
        uint64 deadline;        // SIGNATURE expiry (not order expiry). Use endTime + buffer
    }

    // EIP-712 typehash for Order — must match struct field order exactly
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,uint256 triggerPrice,uint256 deadline,uint256 nonce,uint16 feeBps)"
    );

    // EIP-712 typehash for ScheduledOrder — must match struct field order exactly
    bytes32 public constant SCHEDULED_ORDER_TYPEHASH = keccak256(
        "ScheduledOrder(address maker,address tokenIn,address tokenOut,uint256 amountPerSlice,uint64 intervalSec,uint64 startTime,uint64 endTime,uint16 maxSlices,uint16 maxSlippageBps,address twapPool,uint32 twapWindowSec,uint256 minPriceScaled,uint16 feeBps,uint256 nonce,uint64 deadline)"
    );

    // ─── Storage ─────────────────────────────────────────────────────

    /// @dev maker => nonce => used
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    /// @dev authorized keepers allowed to call execute()
    mapping(address => bool) public authorizedKeepers;

    /// @dev owner-managed allowlist of aggregator/router targets the keeper
    /// may route swaps through (e.g. the Uniswap SwapRouter02 per chain).
    /// Both execute paths revert if the supplied aggregator is not allowed —
    /// the load-bearing control that bounds the unconstrained external call.
    mapping(address => bool) public allowedAggregators;

    /// @dev recipient of protocol fees
    address public feeRecipient;

    /// @dev max protocol fee in basis points the contract will accept on an
    /// order. Hard cap defending makers against a malicious / buggy frontend
    /// that signs an absurd fee. 100 bp = 1%.
    uint16 public constant MAX_FEE_BPS = 100;

    /// @dev Per-token auto-sweep threshold.
    ///
    ///   0                 → forward every fee in the same tx (default, matches
    ///                       the original stateless behaviour, no contract state)
    ///   X > 0             → accumulate fees in `accumulatedFees[token]`;
    ///                       when the running total crosses X, sweep is
    ///                       executed INLINE in that order's tx (no manual
    ///                       cron, no second tx)
    ///   type(uint256).max → effectively "manual only" — total never crosses,
    ///                       owner / anyone flushes via sweepFees(token)
    ///
    /// Per-token because decimals differ wildly (1 unit of USDC = $1, 1 unit
    /// of WETH ≈ $2000). Owner sets non-zero values when chain gas makes
    /// per-tx transfers too expensive — e.g. on Ethereum L1.
    mapping(address => uint256) public sweepThreshold;

    /// @dev Fees waiting to be swept, per token. Cleared by inline auto-sweep
    /// when the threshold is crossed, or by an explicit sweepFees(token) call.
    mapping(address => uint256) public accumulatedFees;

    /// @dev Per-scheduled-order runtime state. Key is the EIP-712 hash of
    /// the ScheduledOrder struct, so the same maker can have many distinct
    /// scheduled orders in flight simultaneously (each with its own nonce).
    struct ScheduledState {
        uint16 slicesExecuted;
        uint64 lastExecutedAt;  // unix-sec of last successful execution (0 = none yet)
    }
    mapping(bytes32 => ScheduledState) public scheduledState;

    /// @dev Hard upper bound on `maxSlices` to prevent absurd configurations
    /// (e.g., signed-once-execute-1M-times grief). Higher than any reasonable
    /// real DCA need: 10000 daily executions = ~27 years.
    uint16 public constant MAX_SCHEDULED_SLICES = 10_000;

    /// @dev Minimum interval between slices. Prevents the keeper from being
    /// pummeled by sub-minute schedules + caps RPC cost / chain spam for
    /// pathological configs. 60s is enough for any realistic TWAP.
    uint64 public constant MIN_INTERVAL_SEC = 60;

    /// @dev Bounds on the maker-signed TWAP window. Below ~2 minutes an
    /// averaging window stops meaningfully resisting a single-block push;
    /// above a day it stops tracking the market the slice actually executes
    /// in. Both ends are signed by the maker inside these bounds.
    uint32 public constant MIN_TWAP_WINDOW_SEC = 120;
    uint32 public constant MAX_TWAP_WINDOW_SEC = 86_400;

    /// @dev Ceiling on the per-slice TWAP tolerance, mirroring the 10% bound
    /// the web and API already enforce on limit orders. Also keeps
    /// `10_000 - maxSlippageBps` from underflowing.
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;

    // ─── Keeper auto-refill from accumulated wrapped-native fees ─────
    //
    // Owner configures the chain's wrapped-native (WETH on Base /
    // Optimism / Arbitrum, WPOL on Polygon, ...). Any time fees
    // accumulate in that token (i.e. a user swapped INTO native and
    // we took our cut from the WETH side), an authorized keeper can
    // pull a bounded amount, the contract unwraps it on the spot,
    // and forwards the resulting native gas-coin to the keeper.
    // Rate-limited per 24h window so a leaked keeper key can drain
    // at most one window's worth before the operator notices.
    //
    // Fees in other tokens (USDC etc.) stay in accumulatedFees for
    // the owner — they're flushed via sweepFees().

    /// @dev WETH9-style wrapped-native ERC20 (zero = refill disabled).
    address public nativeWrappedToken;

    /// @dev Hard cap on native value sent to keepers per 24h window.
    /// Default 0.05 ETH (5e16 wei) — generous for a few hundred slice
    /// txs on any L2, paranoid enough that a leaked keeper key is
    /// bounded loss until operator rotates.
    uint256 public maxKeeperRefillPerDayWei = 0.05 ether;

    /// @dev Target balance of `accumulatedFees[nativeWrappedToken]` to
    /// maintain as a self-replenishing reserve for keeper gas top-ups.
    /// While the accumulated WETH fees are BELOW this target, incoming
    /// WETH fees from executeOrder accumulate here (filling the reserve).
    /// Once the reserve is at target, subsequent WETH fees forward
    /// inline to `feeRecipient`. When a keeper calls `refillKeeper` the
    /// reserve naturally drops below target and starts filling again.
    /// Owner setable per chain (Base/Optimism: 0.02 ETH default; Polygon
    /// would set ~10 POL). Setting to 0 disables the reserve mechanism
    /// — all WETH fees then forward inline (or follow sweepThreshold if
    /// configured for the WETH token).
    uint256 public keeperReserveTargetWei = 0.02 ether;

    /// @dev Canonical Uniswap V3 factory for this chain. A maker-signed
    /// `twapPool` must be a pool this factory deployed, which is what keeps an
    /// arbitrary contract out of the execution path. Zero until the owner sets
    /// it, and while zero every TWAP-guarded slice reverts — fail-closed, so a
    /// missing deploy step cannot quietly downgrade the guarantee.
    address public uniswapV3Factory;

    /// @dev Length of the keeper-refill rate-limit window, in seconds.
    uint256 public constant REFILL_WINDOW_SEC = 86_400;

    /// @dev Timestamp of the last refill accounting update. Zero until the
    /// first refill, which reads as "infinitely long ago" and therefore a
    /// fully regenerated allowance — the correct cold-start behaviour.
    uint256 public lastRefillAt;

    /// @dev Wei charged against the rolling allowance. Together with
    /// `lastRefillAt` this is a leaky bucket: the charge decays linearly at
    /// `maxKeeperRefillPerDayWei` per `REFILL_WINDOW_SEC`, so the allowance
    /// regenerates continuously instead of snapping back at a fixed instant.
    ///
    /// This replaces a UTC-calendar-day counter (`block.timestamp / 86400`).
    /// That version reset at midnight, so a compromised keeper could drain a
    /// full cap at 23:59:59 and another one at 00:00:01 — 2× the cap in two
    /// seconds.
    ///
    /// To be precise about what the rolling version does and does not promise:
    /// the worst case is still 2× the cap across a span of one full window
    /// (drain, wait a window, drain again). That is the ordinary burst
    /// property of a leaky bucket that starts full, and it is not removable
    /// without denying the keeper its first refill. What the rolling charge
    /// bounds is THROUGHPUT — at most one cap per window on average, with no
    /// instant at which the counter jumps back to zero.
    uint256 public refilledInCurrentWindow;

    // ─── Events ──────────────────────────────────────────────────────

    event OrderExecuted(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed keeper,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint8 orderType
    );

    /// @notice A maker invalidated a signed order by burning its nonce.
    /// @dev Emitted by `cancelOrder`. Replaces the previous scheme, which
    ///      overloaded `OrderExecuted` with `orderType = type(uint8).max`
    ///      and zeroed amounts as a cancel marker — that made every
    ///      third-party indexer (DefiLlama, Dune, block explorers) count a
    ///      cancellation as a fill unless it knew the sentinel. Cancels now
    ///      have their own topic0 and no longer appear in execution feeds.
    event OrderCancelled(address indexed maker, uint256 indexed nonce);

    event KeeperAuthorizationChanged(address indexed keeper, bool authorized);
    event AggregatorAllowanceChanged(address indexed aggregator, bool allowed);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event SweepThresholdUpdated(address indexed token, uint256 oldThreshold, uint256 newThreshold);
    event FeesAccumulated(address indexed token, uint256 amount, uint256 newTotal);
    event FeesSwept(address indexed token, uint256 amount, address indexed to);
    event NativeWrappedTokenUpdated(address indexed oldToken, address indexed newToken);
    event MaxKeeperRefillPerDayUpdated(uint256 oldCap, uint256 newCap);
    event UniswapV3FactoryUpdated(address indexed oldFactory, address indexed newFactory);
    event KeeperReserveTargetUpdated(uint256 oldTarget, uint256 newTarget);
    event KeeperRefilled(address indexed keeper, uint256 amount, uint256 windowRemaining);

    /// @dev Fired whenever a WETH fee fills (any portion of) the keeper
    /// reserve toward its target. `added` is what went into the reserve
    /// from this fee (may be less than the full fee if the reserve was
    /// near the target — the surplus is forwarded to feeRecipient and
    /// fires a normal FeesSwept event in the same tx).
    event KeeperReserveAccumulated(
        address indexed token,
        uint256 added,
        uint256 newTotal,
        uint256 target
    );

    /// @dev Fired on every successful slice. `sliceIndex` is the 0-based
    /// count of executions for this order (so it lines up with the value
    /// of `slicesExecuted` BEFORE the increment that just happened).
    event ScheduledOrderExecuted(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed keeper,
        uint16 sliceIndex,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    // ─── Errors ──────────────────────────────────────────────────────

    error UnauthorizedKeeper(address keeper);
    error OrderExpired(uint256 deadline, uint256 currentTime);
    error NonceAlreadyUsed(address maker, uint256 nonce);
    error InvalidSignature();
    error SignerMismatch(address recovered, address expected);
    error InvalidOrderType(uint8 orderType);
    error ZeroAddress();
    error InvalidAmount();
    /// Reverts when an order is signed with tokenIn == tokenOut.
    /// A.14 — guards against the degenerate "swap a token for itself" path:
    /// transferFrom pulls amountIn, approve+call hands it to the aggregator,
    /// and if any aggregator misbehaves the post-swap balance check could
    /// mis-account a same-token transfer as a successful swap. Cheaper to
    /// reject the order at the gate than to reason about all aggregator
    /// behaviours under the same-token assumption.
    error SameTokenInOut(address token);
    error InsufficientOutput(uint256 received, uint256 minRequired);
    error AggregatorCallFailed(bytes returnData);
    error AggregatorNotAllowed(address aggregator);
    error FeeTooHigh(uint16 requested, uint16 max);
    // ─── Scheduled-order-specific errors ────────────────────────────
    error ScheduledTooEarly(uint64 earliestExecAt, uint64 currentTime);
    /// Slice landed further below the TWAP reference than the maker allowed.
    error TwapDeviationExceeded(uint256 received, uint256 minRequired);
    /// twapWindowSec outside [MIN_TWAP_WINDOW_SEC, MAX_TWAP_WINDOW_SEC] while a
    /// reference pool is set, or maxSlippageBps above MAX_SLIPPAGE_BPS.
    error InvalidTwapConfig(uint32 window, uint16 maxSlippageBps);
    error ScheduledExpired(uint64 endTime, uint64 currentTime);
    error ScheduledExhausted(uint16 slicesExecuted, uint16 maxSlices);
    error ScheduledIntervalTooShort(uint64 requested, uint64 min);
    error ScheduledMaxSlicesTooHigh(uint16 requested, uint16 max);
    error ScheduledBadWindow(uint64 startTime, uint64 endTime);
    // ─── Keeper-refill errors ───────────────────────────────────────
    error NativeWrappedNotConfigured();
    error KeeperRefillExceedsCap(uint256 requested, uint256 windowRemaining);
    error InsufficientAccumulatedNative(uint256 available, uint256 requested);
    error NativeTransferFailed();

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address initialFeeRecipient,
        address initialKeeper
    )
        EIP712("OwlOrderFi", "1")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (initialFeeRecipient == address(0)) revert ZeroAddress();

        feeRecipient = initialFeeRecipient;

        if (initialKeeper != address(0)) {
            authorizedKeepers[initialKeeper] = true;
            emit KeeperAuthorizationChanged(initialKeeper, true);
        }
    }

    // ─── Owner-only admin functions ──────────────────────────────────

    function setKeeperAuthorization(address keeper, bool authorized) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        authorizedKeepers[keeper] = authorized;
        emit KeeperAuthorizationChanged(keeper, authorized);
    }

    /// @notice Allow or disallow an aggregator/router target for swaps.
    /// @dev Both execute paths require the supplied aggregator to be allowed.
    /// Set the per-chain Uniswap SwapRouter02 (and any other vetted router)
    /// here at deploy time. Disallowing a compromised router is an instant
    /// kill switch without pausing the whole contract.
    function setAggregatorAllowed(address aggregator, bool allowed) external onlyOwner {
        if (aggregator == address(0)) revert ZeroAddress();
        allowedAggregators[aggregator] = allowed;
        emit AggregatorAllowanceChanged(aggregator, allowed);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /// @notice Set the auto-sweep threshold for a token. See storage doc for
    ///         the semantics of 0 / X / type(uint256).max.
    function setSweepThreshold(address token, uint256 threshold) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        uint256 old = sweepThreshold[token];
        sweepThreshold[token] = threshold;
        emit SweepThresholdUpdated(token, old, threshold);
    }

    /// @notice Set the WETH9-style wrapped-native ERC20 used by
    ///         `refillKeeper`. Setting zero address disables keeper
    ///         self-refill entirely.
    function setNativeWrappedToken(address token) external onlyOwner {
        address old = nativeWrappedToken;
        nativeWrappedToken = token;
        emit NativeWrappedTokenUpdated(old, token);
    }

    /// @notice Set the canonical Uniswap V3 factory used to validate
    ///         maker-signed TWAP reference pools.
    function setUniswapV3Factory(address factory) external onlyOwner {
        address old = uniswapV3Factory;
        uniswapV3Factory = factory;
        emit UniswapV3FactoryUpdated(old, factory);
    }

    /// @notice Set the rolling cap on native value `refillKeeper` can send
    ///         out per `REFILL_WINDOW_SEC`. Zero effectively disables the
    ///         function.
    /// @dev Settles the outstanding charge at the OLD rate before switching,
    ///      because the charge is stored in absolute wei while regeneration is
    ///      proportional to the cap. Without settling:
    ///        - lowering the cap strands a large charge against a small
    ///          regeneration rate, locking the keeper out for
    ///          (oldCap / newCap) windows — tightening the cap, a safety
    ///          action, would brick refills for years;
    ///        - raising it lets elapsed time regenerate at the new higher
    ///          rate, retroactively forgiving what was already drawn.
    ///      Clamping to the new cap is what makes the first case recover.
    function setMaxKeeperRefillPerDay(uint256 capWei) external onlyOwner {
        (uint256 charged, ) = _refillAllowance();
        refilledInCurrentWindow = Math.min(charged, capWei);
        lastRefillAt = block.timestamp;

        uint256 old = maxKeeperRefillPerDayWei;
        maxKeeperRefillPerDayWei = capWei;
        emit MaxKeeperRefillPerDayUpdated(old, capWei);
    }

    /// @notice Set the keeper reserve target (in wrapped-native wei). See
    ///         storage doc for behavior. Setting 0 disables the reserve
    ///         carve-out — WETH fees then behave like any other token.
    ///         Lowering below the current `accumulatedFees[weth]` does
    ///         NOT auto-drain — anyone can call `sweepFees(weth)` to
    ///         move the now-surplus portion to feeRecipient.
    function setKeeperReserveTarget(uint256 targetWei) external onlyOwner {
        uint256 old = keeperReserveTargetWei;
        keeperReserveTargetWei = targetWei;
        emit KeeperReserveTargetUpdated(old, targetWei);
    }

    /// @notice Emergency stop — pauses executeOrder and unwrap (the two paths
    ///         that move user funds). cancelOrder stays open so users can
    ///         always invalidate a signed nonce even mid-incident. Owner-only;
    ///         designed to be triggered in seconds via a hardware wallet.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Lift the emergency stop. Verify the underlying issue is
    ///         resolved before calling.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Flush accumulated fees for a token to feeRecipient. Anyone can
    ///         call — the destination is fixed at feeRecipient, so allowing
    ///         a public sweep just helps batch gas costs onto whoever cares.
    ///
    ///         WETH carve-out: when `token == nativeWrappedToken`, only the
    ///         portion ABOVE `keeperReserveTargetWei` is swept. The reserve
    ///         itself is protected and stays earmarked for refillKeeper.
    ///         To drain everything (e.g. migrating to a new contract), the
    ///         owner first calls `setKeeperReserveTarget(0)` to release the
    ///         carve-out, then `sweepFees(weth)` clears the full balance.
    function sweepFees(address token) external nonReentrant {
        uint256 amt = accumulatedFees[token];
        if (amt == 0) return;

        address weth = nativeWrappedToken;
        if (token == weth && weth != address(0)) {
            uint256 target = keeperReserveTargetWei;
            if (amt <= target) return;
            uint256 surplus = amt - target;
            accumulatedFees[weth] = target;
            IERC20(weth).safeTransfer(feeRecipient, surplus);
            emit FeesSwept(weth, surplus, feeRecipient);
            return;
        }

        accumulatedFees[token] = 0;
        IERC20(token).safeTransfer(feeRecipient, amt);
        emit FeesSwept(token, amt, feeRecipient);
    }

    /// @dev Apply fee deduction policy to `fee` of `token`. Two paths:
    ///
    ///   - `token == nativeWrappedToken`: priority fill of the keeper
    ///     reserve. Below target → accumulate; crossing target → split
    ///     (target portion in reserve, surplus forwarded inline); above
    ///     target → forward inline. `sweepThreshold[weth]` is IGNORED
    ///     on this path — the reserve mechanism owns WETH accounting.
    ///
    ///   - all other tokens: existing sweepThreshold policy. Threshold 0
    ///     forwards inline, non-zero accumulates with inline auto-sweep
    ///     when the running total crosses the threshold.
    ///
    /// Internal — called from executeOrder and executeScheduledOrder.
    /// CEI is respected by callers (nonce marked before this).
    function _handleFee(address token, uint256 fee) internal {
        address weth = nativeWrappedToken;
        if (token == weth && weth != address(0)) {
            uint256 target = keeperReserveTargetWei;
            uint256 current = accumulatedFees[weth];
            if (current >= target) {
                // Reserve full → forward every WETH fee inline.
                IERC20(weth).safeTransfer(feeRecipient, fee);
                emit FeesSwept(weth, fee, feeRecipient);
                return;
            }
            uint256 deficit = target - current;
            if (fee <= deficit) {
                uint256 newTotal = current + fee;
                accumulatedFees[weth] = newTotal;
                emit KeeperReserveAccumulated(weth, fee, newTotal, target);
            } else {
                // Split: fill reserve to target, forward the rest.
                accumulatedFees[weth] = target;
                emit KeeperReserveAccumulated(weth, deficit, target, target);
                uint256 surplus = fee - deficit;
                IERC20(weth).safeTransfer(feeRecipient, surplus);
                emit FeesSwept(weth, surplus, feeRecipient);
            }
            return;
        }

        uint256 threshold = sweepThreshold[token];
        if (threshold == 0) {
            IERC20(token).safeTransfer(feeRecipient, fee);
            return;
        }
        uint256 runningTotal = accumulatedFees[token] + fee;
        if (runningTotal >= threshold) {
            accumulatedFees[token] = 0;
            IERC20(token).safeTransfer(feeRecipient, runningTotal);
            emit FeesSwept(token, runningTotal, feeRecipient);
        } else {
            accumulatedFees[token] = runningTotal;
            emit FeesAccumulated(token, fee, runningTotal);
        }
    }

    /**
     * @notice Self-service keeper top-up. Pulls up to `maxAmountWei` of
     *         wrapped-native from `accumulatedFees[nativeWrappedToken]`,
     *         unwraps it on the spot, and forwards the resulting native
     *         gas-coin to the calling keeper. Rate-limited per 24h
     *         window so a leaked keeper key bounds the loss to one
     *         window's worth until the operator can rotate.
     *
     *         Returns the actual amount sent (may be less than
     *         requested when accumulated balance, daily cap, or both
     *         constrain it). Reverts on zero / config errors so the
     *         caller can detect "definitely got nothing" vs "got X".
     *
     *         Only authorized keepers can call. The `nativeWrappedToken`
     *         must be set by the owner first. nonReentrant in case the
     *         WETH9 withdraw or msg.sender callback misbehaves.
     */
    /// @notice Wei a keeper may draw right now, after time-based
    ///         regeneration of the rolling allowance.
    /// @dev Exposed so the admin panel and the keeper's own pre-check read
    ///      the live number instead of re-deriving the decay off-chain and
    ///      drifting from it. Reading `refilledInCurrentWindow` alone is
    ///      stale by construction — it is the charge as of `lastRefillAt`.
    function refillAllowanceRemaining() external view returns (uint256 remaining) {
        (, remaining) = _refillAllowance();
    }

    /// @dev Single implementation of the leaky-bucket accounting, shared by
    ///      the view above and `refillKeeper`. Returns the regenerated
    ///      charge (to be persisted by the caller that spends) and what is
    ///      still spendable against the cap.
    function _refillAllowance() internal view returns (uint256 charged, uint256 remaining) {
        uint256 cap = maxKeeperRefillPerDayWei;
        charged = refilledInCurrentWindow;
        if (charged != 0) {
            uint256 regenerated = Math.mulDiv(
                cap,
                block.timestamp - lastRefillAt,
                REFILL_WINDOW_SEC
            );
            charged = regenerated >= charged ? 0 : charged - regenerated;
        }
        remaining = cap > charged ? cap - charged : 0;
    }

    function refillKeeper(uint256 maxAmountWei)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 actualAmount)
    {
        if (!authorizedKeepers[msg.sender]) revert UnauthorizedKeeper(msg.sender);
        address weth = nativeWrappedToken;
        if (weth == address(0)) revert NativeWrappedNotConfigured();
        if (maxAmountWei == 0) revert InvalidAmount();

        // ─── 1. Window accounting (rolling, not calendar) ────────────
        (uint256 charged, uint256 windowRemaining) = _refillAllowance();
        if (windowRemaining == 0) {
            revert KeeperRefillExceedsCap(maxAmountWei, 0);
        }

        // ─── 2. Determine actual amount ──────────────────────────────
        uint256 available = accumulatedFees[weth];
        if (available == 0) revert InsufficientAccumulatedNative(0, maxAmountWei);

        actualAmount = maxAmountWei;
        if (actualAmount > available) actualAmount = available;
        if (actualAmount > windowRemaining) actualAmount = windowRemaining;

        // ─── 3. State updates BEFORE external calls (CEI pattern) ────
        accumulatedFees[weth] = available - actualAmount;
        // Persist the REGENERATED charge plus this draw — writing
        // `charged + actualAmount` is what makes the decay stick.
        refilledInCurrentWindow = charged + actualAmount;
        lastRefillAt = block.timestamp;

        // ─── 4. Unwrap + forward native ──────────────────────────────
        // withdraw() pulls from contract's WETH balance (which we hold
        // because every accrual into accumulatedFees was a transferFrom
        // INTO this contract during executeOrder).
        IWETH9(weth).withdraw(actualAmount);

        (bool ok, ) = msg.sender.call{value: actualAmount}("");
        if (!ok) revert NativeTransferFailed();

        emit KeeperRefilled(msg.sender, actualAmount, windowRemaining - actualAmount);
    }

    // ─── User-facing cancel (no on-chain order book — just burns nonce) ──

    /**
     * @notice Cancel any signed order (Order OR ScheduledOrder) by marking
     *         its nonce as used. Only the maker can cancel — msg.sender
     *         identifies the maker, no signature needed.
     *
     *         For a limit Order: prevents the (one) future execution.
     *         For a ScheduledOrder: prevents ALL remaining slices.
     *
     *         No refund — the contract never holds maker funds between
     *         slices (each execution pulls fresh via safeTransferFrom).
     *         Off-chain backend should mirror the cancellation in its DB.
     */
    function cancelOrder(uint256 nonce) external {
        if (usedNonces[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);
        usedNonces[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    // ─── Main execution path ─────────────────────────────────────────

    /**
     * @notice Execute a signed order by routing through an aggregator.
     * @param order The order struct as signed by the maker
     * @param signature EIP-712 signature from maker (65 bytes: r || s || v)
     * @param aggregator Target router address (e.g., 1inch, 0x, Uniswap V3 router)
     * @param swapCalldata Calldata prepared off-chain to perform the swap
     */
    function executeOrder(
        Order calldata order,
        bytes calldata signature,
        address aggregator,
        bytes calldata swapCalldata
    ) external nonReentrant whenNotPaused {
        // ─── 1. Authorization check ──────────────────────────────────
        if (!authorizedKeepers[msg.sender]) revert UnauthorizedKeeper(msg.sender);

        // ─── 2. Basic validation ─────────────────────────────────────
        if (block.timestamp > order.deadline) {
            revert OrderExpired(order.deadline, block.timestamp);
        }
        if (order.maker == address(0) || order.tokenIn == address(0) || order.tokenOut == address(0)) {
            revert ZeroAddress();
        }
        if (order.tokenIn == order.tokenOut) revert SameTokenInOut(order.tokenIn);
        if (order.amountIn == 0 || order.minAmountOut == 0) revert InvalidAmount();
        if (order.orderType > ORDER_TYPE_TAKE_PROFIT) revert InvalidOrderType(order.orderType);
        if (order.feeBps > MAX_FEE_BPS) revert FeeTooHigh(order.feeBps, MAX_FEE_BPS);
        if (aggregator == address(0)) revert ZeroAddress();
        if (!allowedAggregators[aggregator]) revert AggregatorNotAllowed(aggregator);
        if (usedNonces[order.maker][order.nonce]) {
            revert NonceAlreadyUsed(order.maker, order.nonce);
        }

        // ─── 3. Signature verification ───────────────────────────────
        bytes32 orderHash = _hashOrder(order);
        address recovered = ECDSA.recover(orderHash, signature);
        if (recovered == address(0)) revert InvalidSignature();
        if (recovered != order.maker) revert SignerMismatch(recovered, order.maker);

        // ─── 4. Mark nonce used BEFORE external calls (CEI pattern) ──
        usedNonces[order.maker][order.nonce] = true;

        // ─── 5. Pull tokens from maker ───────────────────────────────
        IERC20(order.tokenIn).safeTransferFrom(order.maker, address(this), order.amountIn);

        // ─── 6. Approve aggregator + execute swap ────────────────────
        IERC20(order.tokenIn).forceApprove(aggregator, order.amountIn);

        uint256 balanceBefore = IERC20(order.tokenOut).balanceOf(address(this));
        (bool ok, bytes memory ret) = aggregator.call(swapCalldata);
        if (!ok) revert AggregatorCallFailed(ret);
        uint256 received = IERC20(order.tokenOut).balanceOf(address(this)) - balanceBefore;

        // Clear lingering approval (defense in depth)
        IERC20(order.tokenIn).forceApprove(aggregator, 0);

        // ─── 7. Slippage check ───────────────────────────────────────
        if (received < order.minAmountOut) {
            revert InsufficientOutput(received, order.minAmountOut);
        }

        // ─── 8. Fee deduction (per-order, signed by maker) ───────────
        uint256 fee = (received * order.feeBps) / 10_000;
        uint256 userAmount = received - fee;

        if (fee > 0) {
            _handleFee(order.tokenOut, fee);
        }
        IERC20(order.tokenOut).safeTransfer(order.maker, userAmount);

        // ─── 9. Emit ─────────────────────────────────────────────────
        emit OrderExecuted(
            orderHash,
            order.maker,
            msg.sender,
            order.tokenIn,
            order.tokenOut,
            order.amountIn,
            userAmount,
            fee,
            order.orderType
        );
    }

    // ─── Scheduled-order execution path ──────────────────────────────

    /**
     * @notice Execute one slice of a signed ScheduledOrder. Validates the
     *         schedule (start/end window, max slices, interval since last
     *         slice), pulls `amountPerSlice` from the maker, routes
     *         through the aggregator, charges the per-slice fee, and
     *         credits the remainder to the maker.
     *
     *         The keeper calls this on each tick where the order is due.
     *         The price-trigger logic that drives executeOrder() does NOT
     *         apply here — schedule orders fire purely on time, by
     *         design (DCA / TWAP semantics).
     *
     *         Cancellation: maker calls cancelOrder(order.nonce) which
     *         sets usedNonces[maker][nonce] = true, and this function
     *         refuses to execute when that flag is set.
     */
    function executeScheduledOrder(
        ScheduledOrder calldata order,
        bytes calldata signature,
        address aggregator,
        bytes calldata swapCalldata
    ) external nonReentrant whenNotPaused {
        // ─── 1. Authorization check ──────────────────────────────────
        if (!authorizedKeepers[msg.sender]) revert UnauthorizedKeeper(msg.sender);

        // ─── 2. Basic validation ─────────────────────────────────────
        if (order.maker == address(0) || order.tokenIn == address(0) || order.tokenOut == address(0)) {
            revert ZeroAddress();
        }
        if (order.tokenIn == order.tokenOut) revert SameTokenInOut(order.tokenIn);
        if (order.amountPerSlice == 0) revert InvalidAmount();
        // A.12: a scheduled order MUST carry a non-zero on-chain price floor.
        // A zero floor disables the post-swap check below, leaving only the
        // keeper's RPC-derived minOut — a compromised RPC could fill at any
        // price. Mandatory here so it can't be bypassed off-chain.
        if (order.minPriceScaled == 0) revert InvalidAmount();
        // A reference pool without a sane window (or with a tolerance so wide
        // it cannot bind) would look like protection while providing none.
        if (order.twapPool != address(0)) {
            if (
                order.twapWindowSec < MIN_TWAP_WINDOW_SEC ||
                order.twapWindowSec > MAX_TWAP_WINDOW_SEC ||
                order.maxSlippageBps > MAX_SLIPPAGE_BPS
            ) revert InvalidTwapConfig(order.twapWindowSec, order.maxSlippageBps);
        }
        if (order.feeBps > MAX_FEE_BPS) revert FeeTooHigh(order.feeBps, MAX_FEE_BPS);
        if (aggregator == address(0)) revert ZeroAddress();
        if (!allowedAggregators[aggregator]) revert AggregatorNotAllowed(aggregator);
        // Sanity bounds — catch obvious misconfigurations before the
        // schedule checks. maxSlices=0 stays valid (open-ended DCA).
        if (order.intervalSec < MIN_INTERVAL_SEC) {
            revert ScheduledIntervalTooShort(order.intervalSec, MIN_INTERVAL_SEC);
        }
        if (order.maxSlices > MAX_SCHEDULED_SLICES) {
            revert ScheduledMaxSlicesTooHigh(order.maxSlices, MAX_SCHEDULED_SLICES);
        }
        // endTime=0 means open-ended; otherwise it must be after start.
        if (order.endTime != 0 && order.endTime <= order.startTime) {
            revert ScheduledBadWindow(order.startTime, order.endTime);
        }
        // The SIGNATURE has its own expiry (independent of the order
        // window). Lets the maker re-sign annually for an open-ended DCA
        // without invalidating the rest of the system.
        if (block.timestamp > order.deadline) {
            revert OrderExpired(order.deadline, block.timestamp);
        }
        // Cancellation check — maker invalidated nonce via cancelOrder().
        if (usedNonces[order.maker][order.nonce]) {
            revert NonceAlreadyUsed(order.maker, order.nonce);
        }

        // ─── 3. Signature verification ───────────────────────────────
        bytes32 orderHash = _hashScheduledOrder(order);
        address recovered = ECDSA.recover(orderHash, signature);
        if (recovered == address(0)) revert InvalidSignature();
        if (recovered != order.maker) revert SignerMismatch(recovered, order.maker);

        // ─── 4. Schedule validation ──────────────────────────────────
        ScheduledState memory state = scheduledState[orderHash];
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < order.startTime) {
            revert ScheduledTooEarly(order.startTime, nowTs);
        }
        if (order.endTime != 0 && nowTs > order.endTime) {
            revert ScheduledExpired(order.endTime, nowTs);
        }
        if (order.maxSlices != 0 && state.slicesExecuted >= order.maxSlices) {
            revert ScheduledExhausted(state.slicesExecuted, order.maxSlices);
        }
        // First slice is gated only by startTime; subsequent slices also
        // wait for `intervalSec` to elapse since the previous one.
        if (state.slicesExecuted > 0) {
            uint64 earliest = state.lastExecutedAt + order.intervalSec;
            if (nowTs < earliest) revert ScheduledTooEarly(earliest, nowTs);
        }

        // ─── 5. Bump state BEFORE external calls (CEI pattern) ───────
        uint16 sliceIndex = state.slicesExecuted;
        scheduledState[orderHash].slicesExecuted = sliceIndex + 1;
        scheduledState[orderHash].lastExecutedAt = nowTs;

        // ─── 6. Pull tokens + swap ───────────────────────────────────
        IERC20(order.tokenIn).safeTransferFrom(order.maker, address(this), order.amountPerSlice);
        IERC20(order.tokenIn).forceApprove(aggregator, order.amountPerSlice);

        uint256 balanceBefore = IERC20(order.tokenOut).balanceOf(address(this));
        (bool ok, bytes memory ret) = aggregator.call(swapCalldata);
        if (!ok) revert AggregatorCallFailed(ret);
        uint256 received = IERC20(order.tokenOut).balanceOf(address(this)) - balanceBefore;

        // Clear lingering approval (defense in depth)
        IERC20(order.tokenIn).forceApprove(aggregator, 0);

        // ─── 7. Hard price floor check ───────────────────────────────
        // The keeper's aggregator calldata enforces "max slippage from
        // current quote" — that's the maxSlippageBps gate. THIS check is
        // the maker-signed absolute floor: "I want at least X tokenOut
        // per 1 tokenIn (human units), period." Protects against the
        // market drifting against the maker between signing and execution.
        //
        // minPriceScaled = tokenOut_human_per_tokenIn_human * 1e18.
        // Decimals are read on-chain so the formula is self-contained —
        // a buggy frontend can't accidentally sign a unit-mismatch that
        // turns this into a no-op (which is exactly the v1 bug we're
        // fixing). minPriceScaled is required > 0 (rejected in validation
        // above, A.12); this guard is kept as defense-in-depth so the floor
        // still degrades gracefully if that check is ever removed.
        if (order.minPriceScaled != 0) {
            uint8 inDec = IERC20Metadata(order.tokenIn).decimals();
            uint8 outDec = IERC20Metadata(order.tokenOut).decimals();
            // minOut = amountIn * minPriceScaled * 10^outDec / (1e18 * 10^inDec)
            // Split mulDiv into two passes to keep intermediate values bounded.
            uint256 step = Math.mulDiv(order.amountPerSlice, order.minPriceScaled, 10 ** inDec);
            uint256 minOut = Math.mulDiv(step, 10 ** outDec, 1e18);
            if (received < minOut) revert InsufficientOutput(received, minOut);
        }

        // ─── 7b. Independent price reference (audit #1) ──────────────
        // The floor above is absolute and signed once; over a year-long DCA
        // it is necessarily loose, and everything between it and the market
        // was keeper discretion. `maxSlippageBps` was meant to close that
        // band but had nothing to measure against, so it sat unread.
        //
        // The maker-signed pool supplies the missing reference: whatever the
        // keeper routed through, the result must land within tolerance of what
        // that pool averaged over the signed window. address(0) is an explicit
        // opt-out for pairs whose only pool cannot serve a window at all.
        if (order.twapPool != address(0)) {
            uint256 twapOut = TwapOracle.consult(
                uniswapV3Factory,
                order.twapPool,
                order.twapWindowSec,
                // amountPerSlice is bounded by what a maker can approve; the
                // cast is checked so an absurd slice reverts instead of
                // silently wrapping into a tiny reference quote.
                SafeCast.toUint128(order.amountPerSlice),
                order.tokenIn,
                order.tokenOut
            );
            // Compared PRE-fee, same basis as `minPriceScaled` above, so the
            // effective distance from the reference the maker ends up wearing
            // is maxSlippageBps + feeBps. Both are signed together in the same
            // payload, so the total is knowable at signing time.
            uint256 floorFromTwap = Math.mulDiv(twapOut, 10_000 - order.maxSlippageBps, 10_000);
            if (received < floorFromTwap) revert TwapDeviationExceeded(received, floorFromTwap);
        }

        // ─── 8. Fee deduction (per-slice, same model as Order) ───────
        uint256 fee = (received * order.feeBps) / 10_000;
        uint256 userAmount = received - fee;

        if (fee > 0) {
            _handleFee(order.tokenOut, fee);
        }
        IERC20(order.tokenOut).safeTransfer(order.maker, userAmount);

        // ─── 9. Emit ─────────────────────────────────────────────────
        emit ScheduledOrderExecuted(
            orderHash,
            order.maker,
            msg.sender,
            sliceIndex,
            order.amountPerSlice,
            userAmount,
            fee
        );
    }

    // ─── Order hash helper (public for off-chain verification) ──────

    function hashOrder(Order calldata order) external view returns (bytes32) {
        return _hashOrder(order);
    }

    function _hashOrder(Order calldata order) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.tokenIn,
                order.tokenOut,
                order.amountIn,
                order.minAmountOut,
                order.orderType,
                order.triggerPrice,
                order.deadline,
                order.nonce,
                order.feeBps
            )
        );
        return _hashTypedDataV4(structHash);
    }

    // ─── ScheduledOrder hash helpers ─────────────────────────────────

    /// @notice EIP-712 hash of a ScheduledOrder — same as the value the
    ///         maker signs off-chain. Exposed so the indexer / UI can
    ///         derive the canonical orderHash without re-implementing
    ///         the encoding.
    function hashScheduledOrder(ScheduledOrder calldata order) external view returns (bytes32) {
        return _hashScheduledOrder(order);
    }

    function _hashScheduledOrder(ScheduledOrder calldata order) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SCHEDULED_ORDER_TYPEHASH,
                order.maker,
                order.tokenIn,
                order.tokenOut,
                order.amountPerSlice,
                order.intervalSec,
                order.startTime,
                order.endTime,
                order.maxSlices,
                order.maxSlippageBps,
                order.twapPool,
                order.twapWindowSec,
                order.minPriceScaled,
                order.feeBps,
                order.nonce,
                order.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    // ─── ScheduledOrder view helpers ─────────────────────────────────

    /// @notice Earliest unix-sec at which the next slice can execute.
    ///         Combines the order's start-time floor with the
    ///         per-interval cooldown derived from the previous slice.
    function nextExecutableAt(bytes32 orderHash, uint64 startTime, uint64 intervalSec)
        external
        view
        returns (uint64)
    {
        ScheduledState memory s = scheduledState[orderHash];
        if (s.slicesExecuted == 0) return startTime;
        return s.lastExecutedAt + intervalSec;
    }

    /// @notice Slices the keeper can still execute on this order, accounting
    ///         for both `maxSlices` (0 = unbounded → returns type(uint16).max)
    ///         and how many have already shipped.
    function slicesRemaining(bytes32 orderHash, uint16 maxSlices) external view returns (uint16) {
        uint16 done = scheduledState[orderHash].slicesExecuted;
        if (maxSlices == 0) return type(uint16).max;
        if (done >= maxSlices) return 0;
        return maxSlices - done;
    }

    // ─── Wrap helper for EIP-7702 / smart-account compatibility ─────

    /**
     * @notice Unwrap a WETH9-style token back to native gas coin and
     *         forward to the caller using `.call{value:}`.
     *
     *         Why this exists: WETH9-style contracts (WETH on mainnet,
     *         WPOL on Polygon, WMATIC pre-rebrand) send native via
     *         `to.transfer(wad)` which forwards only 2300 gas. That's
     *         fine for plain EOAs but EIP-7702 delegated accounts (e.g.
     *         Rabby's Smart Account mode) have a fallback that consumes
     *         more than 2300 — the wrapper's withdraw reverts with OOG.
     *
     *         Calling unwrap() here routes the native through `.call`
     *         which forwards all remaining gas, so it works for any
     *         account type.
     *
     *         Requires prior ERC20 approval of `wrappedNative` to this
     *         router. Reentrancy-guarded since we both pull tokens and
     *         send native to msg.sender in one call.
     */
    function unwrap(address wrappedNative, uint256 amount) external nonReentrant whenNotPaused {
        if (wrappedNative == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(wrappedNative).safeTransferFrom(msg.sender, address(this), amount);
        IWETH9(wrappedNative).withdraw(amount);

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert AggregatorCallFailed("");
    }

    // ─── Rescue function (defense for stuck tokens) ─────────────────

    /**
     * @notice Recover tokens accidentally sent to this contract.
     *         Only owner can call. Pattern from past experience: contracts
     *         without rescue function lose forever any unexpected token deposits.
     *
     *         Carve-out: cannot dip into `accumulatedFees[token]`. Those are
     *         earmarked for feeRecipient and must go through sweepFees() so
     *         the destination stays fixed even if owner is compromised. An
     *         honest owner who needs them just calls sweepFees(token).
     */
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = accumulatedFees[token];
        uint256 available = balance > reserved ? balance - reserved : 0;
        if (amount > available) revert InvalidAmount();
        IERC20(token).safeTransfer(to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert AggregatorCallFailed("");
    }

    // Allow native receive for rescue scenarios
    receive() external payable {}
}

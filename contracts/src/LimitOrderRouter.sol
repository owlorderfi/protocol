// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
 *   - Whitelist of allowed aggregator routers (currently any address)
 *   - Per-order TWAP price verification at execution block
 */
contract LimitOrderRouter is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Order types (must match @polyorder/shared/schemas/order.ts) ──

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

    // EIP-712 typehash for Order — must match struct field order exactly
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,uint256 triggerPrice,uint256 deadline,uint256 nonce,uint16 feeBps)"
    );

    // ─── Storage ─────────────────────────────────────────────────────

    /// @dev maker => nonce => used
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    /// @dev authorized keepers allowed to call execute()
    mapping(address => bool) public authorizedKeepers;

    /// @dev recipient of protocol fees
    address public feeRecipient;

    /// @dev max protocol fee in basis points the contract will accept on an
    /// order. Hard cap defending makers against a malicious / buggy frontend
    /// that signs an absurd fee. 100 bp = 1%.
    uint16 public constant MAX_FEE_BPS = 100;

    /// @dev Per-token dust threshold. Fees STRICTLY BELOW this stay in the
    /// contract under `accumulatedFees[token]` and must be claimed via
    /// `sweepFees(token)`. Default is 0 for every token, which means immediate
    /// forwarding (matches the original stateless behaviour). Owner sets
    /// non-zero per-token thresholds when chain gas makes per-tx transfers
    /// too expensive — e.g. on Ethereum L1 where an ERC20 transfer can cost
    /// more than the fee itself for small orders. Per-token because decimals
    /// differ wildly (1 unit of USDC = $1, 1 unit of WETH ≈ $2000).
    mapping(address => uint256) public dustThreshold;

    /// @dev Fees waiting to be swept, per token. Anyone can call sweepFees
    /// to flush them to feeRecipient.
    mapping(address => uint256) public accumulatedFees;

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

    event KeeperAuthorizationChanged(address indexed keeper, bool authorized);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event DustThresholdUpdated(address indexed token, uint256 oldThreshold, uint256 newThreshold);
    event FeesAccumulated(address indexed token, uint256 amount, uint256 newTotal);
    event FeesSwept(address indexed token, uint256 amount, address indexed to);

    // ─── Errors ──────────────────────────────────────────────────────

    error UnauthorizedKeeper(address keeper);
    error OrderExpired(uint256 deadline, uint256 currentTime);
    error NonceAlreadyUsed(address maker, uint256 nonce);
    error InvalidSignature();
    error SignerMismatch(address recovered, address expected);
    error InvalidOrderType(uint8 orderType);
    error ZeroAddress();
    error InvalidAmount();
    error InsufficientOutput(uint256 received, uint256 minRequired);
    error AggregatorCallFailed(bytes returnData);
    error FeeTooHigh(uint16 requested, uint16 max);

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address initialFeeRecipient,
        address initialKeeper
    )
        EIP712("Polyorder", "1")
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

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /// @notice Set the dust threshold for a token. Fees strictly below it
    ///         accumulate inside the contract instead of being forwarded
    ///         every tx. Pass 0 to restore immediate-forward behaviour.
    function setDustThreshold(address token, uint256 threshold) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        uint256 old = dustThreshold[token];
        dustThreshold[token] = threshold;
        emit DustThresholdUpdated(token, old, threshold);
    }

    /// @notice Flush accumulated fees for a token to feeRecipient. Anyone can
    ///         call — the destination is fixed at feeRecipient, so allowing
    ///         a public sweep just helps batch gas costs onto whoever cares.
    function sweepFees(address token) external nonReentrant {
        uint256 amt = accumulatedFees[token];
        if (amt == 0) return;
        accumulatedFees[token] = 0;
        IERC20(token).safeTransfer(feeRecipient, amt);
        emit FeesSwept(token, amt, feeRecipient);
    }

    // ─── User-facing cancel (no on-chain order book — just burns nonce) ──

    /**
     * @notice Cancel a signed order by marking its nonce as used.
     *         Only the maker can cancel. Off-chain backend should reflect this.
     */
    function cancelOrder(uint256 nonce) external {
        if (usedNonces[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);
        usedNonces[msg.sender][nonce] = true;
        // Emit a synthetic event so off-chain indexers can detect cancellations
        emit OrderExecuted(
            bytes32(0), msg.sender, msg.sender,
            address(0), address(0), 0, 0, 0, type(uint8).max
        );
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
    ) external nonReentrant {
        // ─── 1. Authorization check ──────────────────────────────────
        if (!authorizedKeepers[msg.sender]) revert UnauthorizedKeeper(msg.sender);

        // ─── 2. Basic validation ─────────────────────────────────────
        if (block.timestamp > order.deadline) {
            revert OrderExpired(order.deadline, block.timestamp);
        }
        if (order.maker == address(0) || order.tokenIn == address(0) || order.tokenOut == address(0)) {
            revert ZeroAddress();
        }
        if (order.amountIn == 0 || order.minAmountOut == 0) revert InvalidAmount();
        if (order.orderType > ORDER_TYPE_TAKE_PROFIT) revert InvalidOrderType(order.orderType);
        if (order.feeBps > MAX_FEE_BPS) revert FeeTooHigh(order.feeBps, MAX_FEE_BPS);
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
            uint256 threshold = dustThreshold[order.tokenOut];
            if (threshold == 0 || fee >= threshold) {
                // Above (or no) threshold → forward in-line as before.
                IERC20(order.tokenOut).safeTransfer(feeRecipient, fee);
            } else {
                // Dust → accumulate. Sweep later via sweepFees(token).
                uint256 newTotal = accumulatedFees[order.tokenOut] + fee;
                accumulatedFees[order.tokenOut] = newTotal;
                emit FeesAccumulated(order.tokenOut, fee, newTotal);
            }
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

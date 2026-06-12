import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, verifyTypedData, getAddress, formatUnits, type Address } from 'viem';
import {
  ORDER_EIP712_TYPES,
  ORDER_TYPE_TO_UINT8,
  type CreateOrderInput,
  type Order as OrderDto,
  type OrderType,
  CHAINS,
  isSupportedChainId,
  isBlockedToken,
  computeExpectedAmountOut,
  minAmountOutFloor,
  MAX_SLIPPAGE_BPS,
  unixToDate,
} from '@owlorderfi/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { OrderType as PrismaOrderType, OrderStatus as PrismaOrderStatus } from '@prisma/client';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the router address for a given chain. Per-chain env vars
   * (CHAIN_<id>_ROUTER) are checked first; falls back to the legacy
   * single-chain LIMIT_ORDER_ROUTER_ADDRESS for backwards compat with
   * older deployments. Throws if neither is set — better to fail fast
   * than verify against a stale address from a different chain.
   *
   * Adding a new chain = drop a new CHAIN_<id>_ROUTER line in .env.
   * No code change here.
   */
  private getRouterForChain(chainId: number): Address {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_ROUTER`);
    if (perChain && /^0x[a-fA-F0-9]{40}$/.test(perChain)) {
      return perChain as Address;
    }
    const legacy = this.config.get<string>('LIMIT_ORDER_ROUTER_ADDRESS');
    if (legacy && /^0x[a-fA-F0-9]{40}$/.test(legacy)) {
      return legacy as Address;
    }
    throw new Error(
      `No router address configured for chainId ${chainId}. ` +
        `Set CHAIN_${chainId}_ROUTER (or legacy LIMIT_ORDER_ROUTER_ADDRESS) in apps/api/.env.`,
    );
  }

  /**
   * Create a new order. Verifies EIP-712 signature against expected schema.
   * Signer must match order.maker AND the authenticated user.
   */
  async create(input: {
    dto: CreateOrderInput;
    signature: string;
    nonce: string;
    /** Optional ladder grouping — see schemas/order.ts. Both fields must
     *  be set or both omitted; the schema's refine() enforces that. */
    ladderId?: string;
    ladderRungIndex?: number;
    authenticatedWallet: string;
  }) {
    const { dto, signature, nonce, ladderId, ladderRungIndex, authenticatedWallet } = input;

    // ─── 1. Authorization: signer must match authenticated user ───
    if (dto.maker.toLowerCase() !== authenticatedWallet.toLowerCase()) {
      throw new ForbiddenException('Order maker must match authenticated wallet');
    }

    // ─── 2. Chain support ─────────────────────────────────────────
    if (!isSupportedChainId(dto.chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${dto.chainId}`);
    }
    if (dto.tokenIn.toLowerCase() === dto.tokenOut.toLowerCase()) {
      throw new BadRequestException('tokenIn and tokenOut must differ');
    }
    // ─── 2a. Reject tokens incompatible with exact-amountIn execution ──
    // Fee-on-transfer / rebasing tokens deliver less than amountIn to the
    // router, so the downstream aggregator swap reverts with no useful
    // error — the order would just churn and fail. Reject at creation with
    // a clear message instead. Checked on both sides. See
    // ChainInfo.blockedTokens for the per-chain list + rationale.
    for (const [side, addr] of [
      ['tokenIn', dto.tokenIn],
      ['tokenOut', dto.tokenOut],
    ] as const) {
      if (isBlockedToken(dto.chainId, addr)) {
        throw new BadRequestException(
          `${side} (${addr}) is not supported: fee-on-transfer or rebasing tokens are incompatible with order execution.`,
        );
      }
    }

    // ─── 2b. Maker balance covers amountIn ────────────────────────
    // Without this guard the keeper picks the order up at trigger time, the
    // contract reverts on transferFrom (insufficient balance), and the order
    // re-enters OPEN on every poll — never fills, never errors visibly.
    await this.assertMakerHasBalance(dto);

    // ─── 2c. minAmountOut must be within the slippage bound of trigger ──
    // Backstop for non-web clients + form bugs: reject a signed floor that
    // sits more than MAX_SLIPPAGE_BPS below the trigger-implied output.
    await this.assertMinAmountOutWithinBound(dto);

    // ─── 3. Deadline must be in future ────────────────────────────
    const deadlineDate = unixToDate(dto.deadline);
    if (deadlineDate <= new Date()) {
      throw new BadRequestException('Order deadline must be in the future');
    }

    // ─── 4. Nonce uniqueness per maker (DB-level) ─────────────────
    const existing = await this.prisma.order.findFirst({
      where: { maker: dto.maker.toLowerCase(), nonce, chainId: dto.chainId },
    });
    if (existing) {
      throw new BadRequestException('Order with this nonce already exists');
    }

    // ─── 5. EIP-712 signature verification ────────────────────────
    // Normalize all addresses to EIP-55 checksum format (viem requirement).
    const orderTypeUint8 = ORDER_TYPE_TO_UINT8[dto.orderType];
    const makerChecksum = getAddress(dto.maker);
    const tokenInChecksum = getAddress(dto.tokenIn);
    const tokenOutChecksum = getAddress(dto.tokenOut);

    const messageForVerify = {
      maker: makerChecksum,
      tokenIn: tokenInChecksum,
      tokenOut: tokenOutChecksum,
      amountIn: BigInt(dto.amountIn),
      minAmountOut: BigInt(dto.minAmountOut),
      orderType: orderTypeUint8,
      triggerPrice: BigInt(dto.triggerPrice),
      deadline: BigInt(dto.deadline),
      nonce: BigInt(nonce),
      feeBps: dto.feeBps,
    };

    const valid = await verifyTypedData({
      address: makerChecksum,
      domain: {
        name: 'OwlOrderFi',
        version: '1',
        chainId: dto.chainId,
        verifyingContract: getAddress(this.getRouterForChain(dto.chainId)),
      },
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message: messageForVerify,
      signature: signature as `0x${string}`,
    });

    if (!valid) {
      this.logger.warn(`Invalid EIP-712 signature for order from ${dto.maker}`);
      throw new UnauthorizedException('Invalid EIP-712 order signature');
    }

    // ─── 6. Persist ───────────────────────────────────────────────
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { walletAddress: authenticatedWallet.toLowerCase() },
    });

    const created = await this.prisma.order.create({
      data: {
        userId: user.id,
        chainId: dto.chainId,
        maker: dto.maker.toLowerCase(),
        tokenIn: dto.tokenIn.toLowerCase(),
        tokenOut: dto.tokenOut.toLowerCase(),
        amountIn: dto.amountIn,
        minAmountOut: dto.minAmountOut,
        triggerPrice: dto.triggerPrice,
        orderType: dto.orderType as PrismaOrderType,
        feeBps: dto.feeBps,
        status: PrismaOrderStatus.OPEN,
        nonce,
        signature,
        deadline: deadlineDate,
        ladderId: ladderId ?? null,
        ladderRungIndex: ladderRungIndex ?? null,
      },
    });

    this.logger.log(`Order created: ${created.id} (${dto.orderType} on ${dto.chainId})`);
    return this.toDto(created);
  }

  /**
   * List orders for a given wallet. Most recent first.
   */
  async listForUser(walletAddress: string, status?: PrismaOrderStatus) {
    const orders = await this.prisma.order.findMany({
      where: {
        maker: walletAddress.toLowerCase(),
        ...(status && { status }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => this.toDto(o));
  }

  /**
   * Get a single order. Caller must own it.
   */
  async findOne(id: string, walletAddress: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.maker !== walletAddress.toLowerCase()) {
      throw new ForbiddenException('Not your order');
    }
    return this.toDto(order);
  }

  /**
   * Cancel an order (off-chain). Marks status as CANCELLED.
   * Note: on-chain nonce is NOT consumed by this; only the local order
   * is removed from the keeper's queue. For on-chain cancel, user must
   * call LimitOrderRouter.cancelOrder(nonce) directly from their wallet.
   */
  async cancel(id: string, walletAddress: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.maker !== walletAddress.toLowerCase()) {
      throw new ForbiddenException('Not your order');
    }
    // Both transitions are status-filtered atomic CAS writes. The order can
    // legitimately flip OPEN ⇄ EXECUTING between our reads (keeper claims it,
    // or a transient failure releases it back to OPEN), so retry a few times
    // to land on whichever state is current rather than throwing a stale
    // "cannot cancel" on a momentary flip. Bounded — terminal states break
    // immediately, and pathological churn falls through to the error below.
    for (let attempt = 0; attempt < 3; attempt++) {
      // Fast path — OPEN → CANCELLED. count=0 means the keeper beat us to
      // the OPEN → EXECUTING lock. The status filter is what makes the
      // cancel/execute race safe — without it the cancel overwrites
      // EXECUTING, the tx is already on-chain, and the order flips to
      // FILLED a few seconds later (a "cancelled" toast followed by a
      // fill). When this wins, execution is GUARANTEED not to happen: the
      // keeper's lock gets count=0 and skips the order entirely.
      const openCas = await this.prisma.order.updateMany({
        where: { id, status: PrismaOrderStatus.OPEN },
        data: { status: PrismaOrderStatus.CANCELLED },
      });
      if (openCas.count === 1) {
        const updated = await this.prisma.order.findUniqueOrThrow({ where: { id } });
        this.logger.log(`Order cancelled (off-chain, pre-execution): ${id}`);
        return this.toDto(updated);
      }

      // Keeper is mid-execution: request a cooperative abort instead of
      // refusing. Stamp cancelRequestedAt (CAS on EXECUTING) and let the
      // keeper's last-mile re-check — right before broadcast — turn it into
      // a real CANCELLED, for free, no on-chain tx. The only way this loses
      // is if the swap is already broadcast, in which case the order fills
      // and the maker must fall back to the on-chain cancelOrder(nonce) to
      // retire any future use of the nonce.
      const execCas = await this.prisma.order.updateMany({
        where: { id, status: PrismaOrderStatus.EXECUTING },
        data: { cancelRequestedAt: new Date() },
      });
      if (execCas.count === 1) {
        const updated = await this.prisma.order.findUniqueOrThrow({ where: { id } });
        this.logger.log(`Cancel requested mid-execution (cooperative abort): ${id}`);
        return this.toDto(updated);
      }

      // Neither CAS hit. If the order is in a terminal/non-cancellable
      // state, stop and report it. Otherwise it's a transient OPEN ⇄
      // EXECUTING flip — loop and try again.
      const fresh = await this.prisma.order.findUnique({ where: { id } });
      const status = fresh?.status;
      if (status !== PrismaOrderStatus.OPEN && status !== PrismaOrderStatus.EXECUTING) {
        throw new BadRequestException(`Cannot cancel order with status ${status ?? 'UNKNOWN'}`);
      }
    }

    // Exhausted retries on a churning order — let the caller retry.
    const last = await this.prisma.order.findUnique({ where: { id } });
    throw new BadRequestException(
      `Order is changing state (${last?.status ?? 'UNKNOWN'}) — please retry the cancel`,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /**
   * Reverts the create with a 400 if `maker` doesn't currently hold at
   * least `amountIn` of `tokenIn`. Balance can drop later (this is a
   * snapshot at create time), but catching the obvious "I have zero of
   * this token" case prevents silent never-filling orders.
   */
  /**
   * Resolve the RPC URL for a chain: per-chain override (CHAIN_<id>_RPC)
   * first, else the shared registry default. CHAIN_<id>_RPC may be a
   * comma-separated fallback list — take the FIRST endpoint (passing the
   * whole list to http() makes a malformed single URL that errors). Throws
   * a 400 if nothing is configured.
   */
  private resolveRpcUrl(chainId: number): string {
    const rpcUrl =
      this.config.get<string>(`CHAIN_${chainId}_RPC`)?.split(',')[0]?.trim() ||
      CHAINS[chainId as keyof typeof CHAINS]?.rpcUrls[0];
    if (!rpcUrl) {
      throw new BadRequestException(
        `No RPC URL configured for chainId ${chainId}. Set CHAIN_${chainId}_RPC or add the chain to the shared registry.`,
      );
    }
    return rpcUrl;
  }

  private async assertMakerHasBalance(dto: CreateOrderInput): Promise<void> {
    const rpcUrl = this.resolveRpcUrl(dto.chainId);
    const client = createPublicClient({ transport: http(rpcUrl) });
    const tokenAddr = getAddress(dto.tokenIn);
    const makerAddr = getAddress(dto.maker);
    const erc20Abi = [
      { type: 'function', name: 'balanceOf', stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
      { type: 'function', name: 'decimals', stateMutability: 'view',
        inputs: [], outputs: [{ name: '', type: 'uint8' }] },
      { type: 'function', name: 'symbol', stateMutability: 'view',
        inputs: [], outputs: [{ name: '', type: 'string' }] },
    ] as const;

    // Parallelize the three reads so the gate doesn't add a round-trip
    // tax. symbol() falls back to a short address if the token uses the
    // legacy bytes32 symbol format (e.g. old USDT).
    const [balance, decimals, symbol] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [makerAddr] }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' })
        .catch(() => `${tokenAddr.slice(0, 6)}…${tokenAddr.slice(-4)}`),
    ]);

    const required = BigInt(dto.amountIn);
    if (balance < required) {
      const have = formatUnits(balance, decimals);
      const need = formatUnits(required, decimals);
      throw new BadRequestException(
        `Insufficient ${symbol} balance: have ${have}, need ${need}`,
      );
    }
  }

  /**
   * Reject a signed order whose minAmountOut sits more than MAX_SLIPPAGE_BPS
   * below the output the triggerPrice implies. The contract enforces only
   * minPriceScaled (derived from minAmountOut) as price protection —
   * maxSlippageBps is signed but never read on-chain — so an over-loose
   * minAmountOut would let the keeper fill legally far below the price the
   * maker thinks they set. The web clamps slippage too, but this is the
   * server-side backstop that also covers non-web clients. Re-derives
   * expectedOut with the SAME shared math the web used to compute it.
   */
  private async assertMinAmountOutWithinBound(dto: CreateOrderInput): Promise<void> {
    const triggerPriceScaled = BigInt(dto.triggerPrice);
    const amountInRaw = BigInt(dto.amountIn);
    const minAmountOut = BigInt(dto.minAmountOut);
    // Skip when the trigger is unset/zero — other validation handles that.
    if (triggerPriceScaled <= 0n || amountInRaw <= 0n) return;

    const rpcUrl = this.resolveRpcUrl(dto.chainId);
    const client = createPublicClient({ transport: http(rpcUrl) });
    const decimalsAbi = [
      { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
    ] as const;
    const [decIn, decOut] = await Promise.all([
      client.readContract({ address: getAddress(dto.tokenIn), abi: decimalsAbi, functionName: 'decimals' }),
      client.readContract({ address: getAddress(dto.tokenOut), abi: decimalsAbi, functionName: 'decimals' }),
    ]);

    const expectedOut = computeExpectedAmountOut({
      orderType: dto.orderType,
      amountInRaw,
      triggerPriceScaled,
      tokenInDecimals: Number(decIn),
      tokenOutDecimals: Number(decOut),
    });
    const floor = minAmountOutFloor(expectedOut);
    if (expectedOut > 0n && minAmountOut < floor) {
      const maxPct = Number(MAX_SLIPPAGE_BPS) / 100;
      throw new BadRequestException(
        `minAmountOut is more than ${maxPct}% below the trigger-implied output — slippage too high. ` +
          `Reduce slippage tolerance to at most ${maxPct}%.`,
      );
    }
  }

  private toDto(o: Awaited<ReturnType<PrismaService['order']['findUniqueOrThrow']>>): OrderDto {
    return {
      id: o.id,
      chainId: o.chainId,
      maker: o.maker as `0x${string}`,
      tokenIn: o.tokenIn as `0x${string}`,
      tokenOut: o.tokenOut as `0x${string}`,
      amountIn: o.amountIn,
      minAmountOut: o.minAmountOut,
      triggerPrice: o.triggerPrice,
      orderType: o.orderType as OrderType,
      feeBps: o.feeBps,
      deadline: Math.floor(o.deadline.getTime() / 1000),
      status: o.status,
      nonce: o.nonce,
      signature: o.signature,
      createdAt: o.createdAt,
      filledAt: o.filledAt,
      txHash: o.txHash as `0x${string}` | null,
      filledAmountOut: o.filledAmountOut,
      feeTier: o.feeTier,
      feeAmount: o.feeAmount,
      failureReason: o.failureReason,
      retryCount: o.retryCount,
      ladderId: o.ladderId,
      ladderRungIndex: o.ladderRungIndex,
    };
  }
}

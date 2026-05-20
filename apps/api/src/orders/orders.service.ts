import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyTypedData, getAddress, type Address } from 'viem';
import {
  ORDER_EIP712_TYPES,
  ORDER_TYPE_TO_UINT8,
  type CreateOrderInput,
  type Order as OrderDto,
  type OrderType,
  isSupportedChainId,
  unixToDate,
} from '@polyorder/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { OrderType as PrismaOrderType, OrderStatus as PrismaOrderStatus } from '@prisma/client';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly routerAddress: Address;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const addr = config.get<string>('LIMIT_ORDER_ROUTER_ADDRESS');
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      throw new Error('LIMIT_ORDER_ROUTER_ADDRESS env var must be a valid address');
    }
    this.routerAddress = addr as Address;
  }

  /**
   * Create a new order. Verifies EIP-712 signature against expected schema.
   * Signer must match order.maker AND the authenticated user.
   */
  async create(input: {
    dto: CreateOrderInput;
    signature: string;
    nonce: string;
    authenticatedWallet: string;
  }) {
    const { dto, signature, nonce, authenticatedWallet } = input;

    // ─── 1. Authorization: signer must match authenticated user ───
    if (dto.maker.toLowerCase() !== authenticatedWallet.toLowerCase()) {
      throw new ForbiddenException('Order maker must match authenticated wallet');
    }

    // ─── 2. Chain support ─────────────────────────────────────────
    if (!isSupportedChainId(dto.chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${dto.chainId}`);
    }

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
    };

    const valid = await verifyTypedData({
      address: makerChecksum,
      domain: {
        name: 'Polyorder',
        version: '1',
        chainId: dto.chainId,
        verifyingContract: getAddress(this.routerAddress),
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
        status: PrismaOrderStatus.OPEN,
        nonce,
        signature,
        deadline: deadlineDate,
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
    if (order.status !== PrismaOrderStatus.OPEN) {
      throw new BadRequestException(`Cannot cancel order with status ${order.status}`);
    }
    const updated = await this.prisma.order.update({
      where: { id },
      data: { status: PrismaOrderStatus.CANCELLED },
    });
    this.logger.log(`Order cancelled (off-chain): ${id}`);
    return this.toDto(updated);
  }

  // ─── Helpers ────────────────────────────────────────────────────

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
      deadline: Math.floor(o.deadline.getTime() / 1000),
      status: o.status,
      nonce: o.nonce,
      signature: o.signature,
      createdAt: o.createdAt,
      filledAt: o.filledAt,
      txHash: o.txHash as `0x${string}` | null,
      filledAmountOut: o.filledAmountOut,
    };
  }
}

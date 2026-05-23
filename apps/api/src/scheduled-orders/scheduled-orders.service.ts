import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  http,
  verifyTypedData,
  getAddress,
  type Address,
} from 'viem';
import {
  type CreateScheduledOrderInput,
  type ScheduledOrder as ScheduledOrderDto,
  CHAINS,
  isSupportedChainId,
  SCHEDULED_ORDER_EIP712_TYPES,
} from '@polyorder/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';
import {
  ScheduledOrderStatus as PrismaScheduledStatus,
} from '@prisma/client';

/**
 * API service for DCA + TWAP orders (same primitive on the contract,
 * two UX framings at the UI level). Verifies EIP-712 signature against
 * the chain-specific router, persists, exposes list/get/cancel.
 *
 * Off-chain cancel here just flips DB status to CANCELLED and stops the
 * keeper from picking it up. For true cancellation that survives a
 * keeper that ALREADY raced ahead, the maker also has to call
 * cancelOrder(nonce) on the contract (UI prompts for both).
 */
@Injectable()
export class ScheduledOrdersService {
  private readonly logger = new Logger(ScheduledOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Per-chain router address, mirrors the helper in OrdersService. */
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
        `Set CHAIN_${chainId}_ROUTER in apps/api/.env.`,
    );
  }

  /** Per-chain RPC URL for the balance-check + future on-chain queries. */
  private getRpcForChain(chainId: number): string {
    const rpc =
      this.config.get<string>(`CHAIN_${chainId}_RPC`) ??
      CHAINS[chainId as keyof typeof CHAINS]?.rpcUrls[0];
    if (!rpc) {
      throw new BadRequestException(
        `No RPC URL configured for chainId ${chainId}. ` +
          `Set CHAIN_${chainId}_RPC or add the chain to the shared registry.`,
      );
    }
    return rpc;
  }

  async create(params: {
    dto: CreateScheduledOrderInput;
    signature: `0x${string}`;
    nonce: string;
    deadline: number;
    authenticatedWallet: string;
  }): Promise<ScheduledOrderDto> {
    const { dto, signature, nonce, deadline, authenticatedWallet } = params;

    // ─── 1. Chain + wallet sanity ─────────────────────────────────
    if (!isSupportedChainId(dto.chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${dto.chainId}`);
    }
    if (dto.maker.toLowerCase() !== authenticatedWallet.toLowerCase()) {
      throw new UnauthorizedException(
        `Maker (${dto.maker}) must match the authenticated session wallet (${authenticatedWallet})`,
      );
    }

    // ─── 2. Schedule sanity (mirror contract bounds) ──────────────
    if (dto.intervalSec < 60) {
      throw new BadRequestException(`intervalSec must be ≥ 60 (got ${dto.intervalSec})`);
    }
    if (dto.maxSlices > 10_000) {
      throw new BadRequestException(`maxSlices must be ≤ 10000 (got ${dto.maxSlices})`);
    }
    if (dto.endTime !== 0 && dto.endTime <= dto.startTime) {
      throw new BadRequestException(`endTime must be > startTime when bounded`);
    }
    if (BigInt(dto.amountPerSlice) === 0n) {
      throw new BadRequestException('amountPerSlice must be > 0');
    }

    // ─── 3. EIP-712 signature verification ────────────────────────
    const router = this.getRouterForChain(dto.chainId);
    const makerChecksum = getAddress(dto.maker);
    const tokenInChecksum = getAddress(dto.tokenIn);
    const tokenOutChecksum = getAddress(dto.tokenOut);

    const message = {
      maker: makerChecksum,
      tokenIn: tokenInChecksum,
      tokenOut: tokenOutChecksum,
      amountPerSlice: BigInt(dto.amountPerSlice),
      intervalSec: BigInt(dto.intervalSec),
      startTime: BigInt(dto.startTime),
      endTime: BigInt(dto.endTime),
      maxSlices: dto.maxSlices,
      maxSlippageBps: dto.maxSlippageBps,
      feeBps: dto.feeBps,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    };

    const valid = await verifyTypedData({
      address: makerChecksum,
      domain: {
        name: 'Polyorder',
        version: '1',
        chainId: dto.chainId,
        verifyingContract: getAddress(router),
      },
      types: SCHEDULED_ORDER_EIP712_TYPES,
      primaryType: 'ScheduledOrder',
      message,
      signature,
    });

    if (!valid) {
      this.logger.warn(`Invalid EIP-712 signature for scheduled order from ${dto.maker}`);
      throw new UnauthorizedException('Invalid EIP-712 scheduled order signature');
    }

    // ─── 4. Resolve userId from authenticated wallet ──────────────
    const user = await this.prisma.user.findUnique({
      where: { walletAddress: authenticatedWallet.toLowerCase() },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('Authenticated wallet not found');
    }

    // ─── 5. Persist ───────────────────────────────────────────────
    const created = await this.prisma.scheduledOrder.create({
      data: {
        userId: user.id,
        chainId: dto.chainId,
        maker: dto.maker.toLowerCase(),
        tokenIn: dto.tokenIn.toLowerCase(),
        tokenOut: dto.tokenOut.toLowerCase(),
        amountPerSlice: dto.amountPerSlice,
        intervalSec: dto.intervalSec,
        startTime: new Date(dto.startTime * 1000),
        endTime: dto.endTime === 0 ? null : new Date(dto.endTime * 1000),
        maxSlices: dto.maxSlices,
        maxSlippageBps: dto.maxSlippageBps,
        feeBps: dto.feeBps,
        nonce,
        signature,
        deadline: new Date(deadline * 1000),
      },
    });

    this.logger.log(
      `Scheduled order created: ${created.id} (${
        dto.endTime === 0 ? 'DCA' : 'TWAP'
      } on chain ${dto.chainId})`,
    );

    // Unused but keeps the import necessary for future on-chain balance check.
    void this.getRpcForChain;
    void createPublicClient;
    void http;

    return this.toDto(created);
  }

  async listForUser(authenticatedWallet: string, status?: PrismaScheduledStatus) {
    const orders = await this.prisma.scheduledOrder.findMany({
      where: {
        maker: authenticatedWallet.toLowerCase(),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { executions: { orderBy: { sliceIndex: 'asc' } } },
    });
    return orders.map((o) => this.toDto(o));
  }

  async findOne(id: string, authenticatedWallet: string) {
    const order = await this.prisma.scheduledOrder.findUnique({
      where: { id },
      include: { executions: { orderBy: { sliceIndex: 'asc' } } },
    });
    if (!order) throw new NotFoundException(`Scheduled order ${id} not found`);
    if (order.maker.toLowerCase() !== authenticatedWallet.toLowerCase()) {
      throw new UnauthorizedException('Not the maker of this order');
    }
    return this.toDto(order);
  }

  /**
   * Off-chain cancel — flips DB status so the keeper stops picking it
   * up on the next poll. For full cancellation that survives an
   * in-flight keeper tx, the maker should ALSO call
   * cancelOrder(nonce) on the contract from the UI. UI prompts for
   * both when the user clicks Cancel.
   */
  async cancel(id: string, authenticatedWallet: string) {
    const order = await this.prisma.scheduledOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException(`Scheduled order ${id} not found`);
    if (order.maker.toLowerCase() !== authenticatedWallet.toLowerCase()) {
      throw new UnauthorizedException('Not the maker of this order');
    }
    if (order.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot cancel a ${order.status.toLowerCase()} order`,
      );
    }
    const updated = await this.prisma.scheduledOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: { executions: { orderBy: { sliceIndex: 'asc' } } },
    });
    this.logger.log(`Scheduled order cancelled (off-chain): ${id}`);
    return this.toDto(updated);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDto(o: any): ScheduledOrderDto {
    return {
      id: o.id,
      chainId: o.chainId,
      maker: o.maker,
      tokenIn: o.tokenIn,
      tokenOut: o.tokenOut,
      amountPerSlice: o.amountPerSlice,
      intervalSec: o.intervalSec,
      startTime: Math.floor(o.startTime.getTime() / 1000),
      endTime: o.endTime ? Math.floor(o.endTime.getTime() / 1000) : 0,
      maxSlices: o.maxSlices,
      maxSlippageBps: o.maxSlippageBps,
      feeBps: o.feeBps,
      nonce: o.nonce,
      signature: o.signature,
      deadline: Math.floor(o.deadline.getTime() / 1000),
      status: o.status,
      slicesExecuted: o.slicesExecuted,
      lastExecutedAt: o.lastExecutedAt,
      createdAt: o.createdAt,
      cancelledAt: o.cancelledAt,
    };
  }
}

/**
 * Unit tests for OrdersService.cancel() — the off-chain cancel race
 * handling (audit finding #3). Three mutually exclusive paths:
 *
 *   1. OPEN  → atomic CAS to CANCELLED; guaranteed no execution.
 *   2. EXECUTING → keeper already locked it, so stamp cancelRequestedAt
 *      (cooperative abort) instead of refusing. Order stays EXECUTING in
 *      the response; the keeper's last-mile re-check turns it into a real
 *      CANCELLED unless the swap is already broadcast.
 *   3. terminal → refuse with the current status.
 *
 * Both CAS writes are `updateMany` with a status filter so a status change
 * between the read and the write can't be clobbered — these tests pin that
 * the second branch only runs when the first CAS missed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service.js';

const MAKER = '0xabc0000000000000000000000000000000000001';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    chainId: 8453,
    maker: MAKER,
    tokenIn: '0x4200000000000000000000000000000000000006',
    tokenOut: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amountIn: '1000000000000000000',
    minAmountOut: '2000000000',
    triggerPrice: '2000000000',
    orderType: 'LIMIT_SELL',
    feeBps: 30,
    deadline: new Date('2099-01-01T00:00:00Z'),
    status: OrderStatus.OPEN,
    nonce: '1',
    signature: '0x' + '00'.repeat(65),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    filledAt: null,
    txHash: null,
    filledAmountOut: null,
    feeTier: null,
    feeAmount: null,
    failureReason: null,
    retryCount: 0,
    cancelRequestedAt: null,
    ladderId: null,
    ladderRungIndex: null,
    ...overrides,
  };
}

function buildService(prismaOrder: Record<string, ReturnType<typeof vi.fn>>) {
  const prisma = { order: prismaOrder } as never;
  const config = { get: vi.fn() } as never;
  return new OrdersService(prisma, config);
}

describe('OrdersService.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('OPEN → atomic CAS to CANCELLED, never touches the EXECUTING path', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const order = makeOrder();
    const svc = buildService({
      findUnique: vi.fn().mockResolvedValue(order),
      updateMany,
      findUniqueOrThrow: vi.fn().mockResolvedValue(makeOrder({ status: OrderStatus.CANCELLED })),
    });

    const dto = await svc.cancel('order-1', MAKER);

    expect(dto.status).toBe(OrderStatus.CANCELLED);
    // Exactly one updateMany — the OPEN CAS. No fall-through to EXECUTING.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.OPEN },
      data: { status: OrderStatus.CANCELLED },
    });
  });

  it('EXECUTING → stamps cancelRequestedAt (cooperative abort) when OPEN CAS misses', async () => {
    // First updateMany (OPEN CAS) misses, second (EXECUTING CAS) hits.
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const svc = buildService({
      findUnique: vi.fn().mockResolvedValue(makeOrder({ status: OrderStatus.EXECUTING })),
      updateMany,
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue(makeOrder({ status: OrderStatus.EXECUTING, cancelRequestedAt: new Date() })),
    });

    const dto = await svc.cancel('order-1', MAKER);

    expect(dto.status).toBe(OrderStatus.EXECUTING); // stays EXECUTING — keeper decides the outcome
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', status: OrderStatus.EXECUTING },
      data: { cancelRequestedAt: expect.any(Date) },
    });
  });

  it('terminal (FILLED) → refuses with the current status', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 }); // both CAS miss
    const svc = buildService({
      // Initial read + the fresh re-read used to build the error message.
      findUnique: vi.fn().mockResolvedValue(makeOrder({ status: OrderStatus.FILLED })),
      updateMany,
      findUniqueOrThrow: vi.fn(),
    });

    const err = await svc.cancel('order-1', MAKER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/status FILLED/);
    expect(updateMany).toHaveBeenCalledTimes(2); // tried OPEN CAS then EXECUTING CAS, both missed
  });

  it('not the maker → ForbiddenException, no writes', async () => {
    const updateMany = vi.fn();
    const svc = buildService({
      findUnique: vi.fn().mockResolvedValue(makeOrder({ maker: '0xdead000000000000000000000000000000000000' })),
      updateMany,
      findUniqueOrThrow: vi.fn(),
    });

    await expect(svc.cancel('order-1', MAKER)).rejects.toThrow(ForbiddenException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('missing order → NotFoundException', async () => {
    const svc = buildService({
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    });

    await expect(svc.cancel('nope', MAKER)).rejects.toThrow(NotFoundException);
  });
});

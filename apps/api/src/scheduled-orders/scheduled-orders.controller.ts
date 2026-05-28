import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  CreateScheduledOrderRequestSchema,
  type CreateScheduledOrderRequest,
  type ScheduledOrderStatus,
} from '@owlorderfi/shared';
import { ScheduledOrdersService } from './scheduled-orders.service.js';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import { CfThrottlerGuard } from '../common/guards/cf-throttler.guard.js';
import {
  CurrentSession,
  type SessionInfo,
} from '../common/decorators/current-session.decorator.js';
import { ScheduledOrderStatus as PrismaScheduledStatus } from '@prisma/client';

@Controller('scheduled-orders')
@UseGuards(Web3JwtAuthGuard)
export class ScheduledOrdersController {
  constructor(private readonly scheduled: ScheduledOrdersService) {}

  // Same rationale as OrdersController.create: an on-chain read per call,
  // so cap per-IP to stop an authenticated client burning paid-RPC quota.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CfThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async create(
    @Body(new ZodValidationPipe(CreateScheduledOrderRequestSchema))
    body: CreateScheduledOrderRequest,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.scheduled.create({
      dto: body.order,
      signature: body.signature as `0x${string}`,
      nonce: body.nonce,
      deadline: body.deadline,
      authenticatedWallet: session.walletAddress,
    });
  }

  @Get()
  async list(
    @CurrentSession() session: SessionInfo,
    @Query('status') status?: ScheduledOrderStatus,
  ) {
    return this.scheduled.listForUser(
      session.walletAddress,
      status as PrismaScheduledStatus | undefined,
    );
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.scheduled.findOne(id, session.walletAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.scheduled.cancel(id, session.walletAddress);
  }
}

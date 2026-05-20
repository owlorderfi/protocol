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
import { ZodValidationPipe } from 'nestjs-zod';
import {
  CreateOrderRequestSchema,
  type CreateOrderRequest,
  type OrderStatus,
} from '@polyorder/shared';
import { OrdersService } from './orders.service.js';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import {
  CurrentSession,
  type SessionInfo,
} from '../common/decorators/current-session.decorator.js';
import { OrderStatus as PrismaOrderStatus } from '@prisma/client';

@Controller('orders')
@UseGuards(Web3JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.orders.create({
      dto: body.order,
      signature: body.signature,
      nonce: body.nonce,
      authenticatedWallet: session.walletAddress,
    });
  }

  @Get()
  async list(
    @CurrentSession() session: SessionInfo,
    @Query('status') status?: OrderStatus,
  ) {
    return this.orders.listForUser(
      session.walletAddress,
      status as PrismaOrderStatus | undefined,
    );
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.orders.findOne(id, session.walletAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionInfo,
  ) {
    return this.orders.cancel(id, session.walletAddress);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import {
  WalletTransaction,
  WalletTransactionDocument,
} from '../wallet/schemas/wallet-transaction.schema';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(WalletTransaction.name)
    private readonly txModel: Model<WalletTransactionDocument>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingOrders(): Promise<void> {
    const pending = await this.orderModel
      .find({ status: 'pending' })
      .select('_id userId')
      .limit(100)
      .lean();

    for (const order of pending) {
      const orderId = order._id.toString();
      try {
        await this.txModel.updateOne(
          { orderId, type: 'reconciliation' },
          {
            $setOnInsert: {
              userId: order.userId,
              amountCents: 0,
              type: 'reconciliation',
              orderId,
            },
          },
          { upsert: true },
        );
      } catch (err: any) {
        if (err?.code !== 11000) {
          this.logger.error(`Error conciliando orden ${orderId}`, err);
        }
      }
    }
  }
}

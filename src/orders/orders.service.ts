import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Order, OrderDocument, OrderItem } from './schemas/order.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Wallet, WalletDocument } from '../wallet/schemas/wallet.schema';
import {
  WalletTransaction,
  WalletTransactionDocument,
} from '../wallet/schemas/wallet-transaction.schema';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(WalletTransaction.name)
    private readonly txModel: Model<WalletTransactionDocument>,
  ) {}

  async create(userId: string, dto: CreateOrderDto) {
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.productModel.find({ _id: { $in: productIds } });
    const byId = new Map(products.map((p) => [p._id.toString(), p]));

    const items: OrderItem[] = [];
    let total = 0;

    for (const item of dto.items) {
      const product = byId.get(item.productId);
      if (!product) {
        throw new NotFoundException(`Producto ${item.productId} no existe`);
      }
      const lineTotal = product.priceCents * item.qty;
      total += lineTotal;
      items.push({
        productId: item.productId,
        qty: item.qty,
        priceCents: product.priceCents,
      });
    }

    return this.orderModel.create({
      userId,
      items,
      totalCents: total,
      status: 'pending',
    });
  }

  async pay(userId: string, orderId: string) {
    const session = await this.connection.startSession();

    try {
      let paidOrder: OrderDocument | null = null;

      await session.withTransaction(async () => {
        const order = await this.orderModel
          .findOne({ _id: orderId, userId, status: 'pending' })
          .session(session);

        if (!order) {
          const existing = await this.orderModel
            .findOne({ _id: orderId, userId })
            .session(session);
          if (existing?.status === 'paid') {
            throw new ConflictException('La orden ya fue pagada');
          }
          throw new NotFoundException('Orden no encontrada');
        }

        const wallet = await this.walletModel.findOneAndUpdate(
          { userId, balanceCents: { $gte: order.totalCents } },
          { $inc: { balanceCents: -order.totalCents } },
          { session, new: true },
        );
        if (!wallet) {
          throw new BadRequestException('Saldo insuficiente');
        }

        for (const item of order.items) {
          const updated = await this.productModel.findOneAndUpdate(
            { _id: item.productId, stock: { $gte: item.qty } },
            { $inc: { stock: -item.qty } },
            { session, new: true },
          );
          if (!updated) {
            throw new BadRequestException(
              `Stock insuficiente para producto ${item.productId}`,
            );
          }
        }

        order.status = 'paid';
        await order.save({ session });

        await this.txModel.create(
          [
            {
              userId,
              amountCents: -order.totalCents,
              type: 'payment',
              orderId,
            },
          ],
          { session },
        );

        paidOrder = order;
      });

      return paidOrder;
    } catch (e) {
      if (e instanceof HttpException) {
        throw e;
      }
      this.logger.error(`Error inesperado al pagar orden ${orderId}`, e);
      throw e;
    } finally {
      await session.endSession();
    }
  }

  async findOneForUser(userId: string, orderId: string) {
    const order = await this.orderModel.findOne({ _id: orderId, userId });
    if (!order) {
      throw new NotFoundException('Orden no encontrada');
    }
    return order;
  }
}

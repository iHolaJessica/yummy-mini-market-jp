# Plan de soluciones — yummy-mini-market

> Documento de trabajo para la prueba técnica Backend Engineer (Yummy Marketplace).  
> Por cada reto se proponen **dos enfoques**, la **solución recomendada** y el **código concreto** para implementarla.

---

## Resumen ejecutivo


| Nivel               | Retos identificados                                                                      | Prioridad  |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------- |
| **1 — Bloqueantes** | Docker no levanta                                                                        | 🔴 Crítica |
| **2 — Core**        | Conciliación infla la DB, saldo/stock incorrectos, IDOR, validación, errores silenciosos | 🔴 Alta    |
| **3 — Bonus**       | N+1, índices, concurrencia robusta                                                       | 🟡 Media   |


**Orden sugerido de implementación:** Nivel 1 → errores silenciosos + IDOR + validación → stock/saldo → conciliación → rendimiento (N+1/índices) → tests propios → `BUGS.md`.

---

## Nivel 1 — Bloqueantes

### Reto 1.1 — El servicio no levanta con `docker compose up --build`

**Síntoma:** `docker compose up --build` falla; la API no queda en `http://localhost:3000`.

**Causas raíz identificadas en el código:**

1. `**Dockerfile`:** `npm ci --omit=dev` elimina devDependencies, pero luego `npm run build` necesita `@nestjs/cli` y `typescript`.
2. `**app.module.ts`:** MongoDB está hardcodeado a `mongodb://localhost:27017/market`. Dentro de Docker el host correcto es `mongo` (definido en `docker-compose.yml` como `MONGO_URI`).
3. **Opcional:** `depends_on` no espera a que Mongo esté listo; la app puede fallar al primer intento de conexión.

#### Solución A — Fix mínimo de infra

- Cambiar el `Dockerfile` a un build multi-stage o instalar devDeps solo para compilar:
  ```dockerfile
  RUN npm ci
  RUN npm run build
  RUN npm prune --omit=dev
  ```
- Leer `process.env.MONGO_URI` en `AppModule` (con fallback a localhost para desarrollo local).
- Actualizar `.env.example` documentando ambos entornos.


| Pros                                              | Contras                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| Cambios pequeños, rápido de implementar           | No resuelve el race condition con Mongo al arrancar |
| Cumple el requisito de entrega sin pasos manuales | Menos “production-ready”                            |


#### Solución B — Docker robusto con healthcheck

- Todo lo de la Solución A, más:
  - `healthcheck` en el servicio `mongo` en `docker-compose.yml`.
  - `depends_on: mongo: condition: service_healthy` en el servicio `app`.
  - Opcional: script `wait-for-it` o reintentos de conexión en bootstrap.


| Pros                                     | Contras                    |
| ---------------------------------------- | -------------------------- |
| Arranque determinista en CI y evaluación | Más archivos/configuración |
| Demuestra criterio de infra maduro       | Tiempo extra (~30 min)     |


#### ✅ Recomendación: **Solución B**

La evaluación exige que `docker compose up --build` funcione sin pasos manuales. El healthcheck evita fallos intermitentes que pueden confundir al evaluador. El fix del Dockerfile y `MONGO_URI` es obligatorio en ambas opciones.

**Archivos a tocar:** `Dockerfile`, `src/app.module.ts`, `docker-compose.yml`, `.env.example`.

#### 💻 Código de la solución recomendada

`**Dockerfile`**

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
```

`**src/app.module.ts**`

```typescript
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { WalletModule } from './wallet/wallet.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGO_URI ?? 'mongodb://localhost:27017/market',
    ),
    ScheduleModule.forRoot(),
    ProductsModule,
    OrdersModule,
    WalletModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
```

`**docker-compose.yml**` (fragmento del servicio `mongo` y `app`)

```yaml
services:
  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - MONGO_URI=mongodb://mongo:27017/market
    depends_on:
      mongo:
        condition: service_healthy
```

---

## Nivel 2 — Core (lógica, datos, seguridad)

### Reto 2.1 — La base de datos crece sin control al arrancar

**Síntoma:** Colección `wallet_transactions` crece continuamente sin operaciones de usuario.

**Causa raíz:** `ReconciliationService` ejecuta `setInterval(..., 1000)` y, cada segundo, inserta un registro `reconciliation` por **cada** orden `pending`, sin comprobar si ya existe.

```26:36:src/reconciliation/reconciliation.service.ts
  async reconcilePendingOrders(): Promise<void> {
    const pending = await this.orderModel.find({ status: 'pending' });

    for (const order of pending) {
      await this.txModel.create({
        userId: order.userId,
        amountCents: 0,
        type: 'reconciliation',
        orderId: order._id.toString(),
      });
    }
  }
```

#### Solución A — Idempotencia con índice único

- Crear índice único compuesto en `wallet_transactions`: `{ orderId: 1, type: 1 }` (parcial: `type: 'reconciliation'`).
- Antes de insertar, usar `findOne` o `updateOne` con `upsert` y `setOnInsert`.
- Aumentar el intervalo (p. ej. 5–15 min) o usar `@Cron` de `@nestjs/schedule` (ya importado en `AppModule`).


| Pros                           | Contras                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Simple, ataca la causa directa | Sigue haciendo un `find` completo de pendientes cada ciclo |
| Fácil de testear               |                                                            |


#### Solución B — Cola de trabajo con estado de conciliación

- Añadir campo `reconciledAt` en `Order` o tabla/colección de jobs.
- Procesar solo órdenes no conciliadas con `find({ status: 'pending', reconciledAt: null }).limit(N)`.
- Marcar como conciliada tras éxito (transacción o `findOneAndUpdate` atómico).


| Pros                                       | Contras                              |
| ------------------------------------------ | ------------------------------------ |
| Escalable, no re-procesa órdenes ya vistas | Más cambios de schema                |
| Control de batch size                      | Overkill para el tamaño del proyecto |


#### ✅ Recomendación: **Solución A**

Para el alcance de la prueba, la idempotencia con índice único + intervalo razonable resuelve el bug y demuestra el concepto. La Solución B es mejor en producción real con alto volumen.

**Archivos:** `reconciliation.service.ts`, `wallet-transaction.schema.ts`, posiblemente `order.schema.ts`.

#### 💻 Código de la solución recomendada

`**src/wallet/schemas/wallet-transaction.schema.ts`** (índice único parcial)

```typescript
export const WalletTransactionSchema =
  SchemaFactory.createForClass(WalletTransaction);

WalletTransactionSchema.index(
  { orderId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'reconciliation' },
  },
);
```

`**src/reconciliation/reconciliation.service.ts**`

```typescript
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
        // Código 11000 = duplicate key → ya conciliada, ignorar
        if (err?.code !== 11000) {
          this.logger.error(`Error conciliando orden ${orderId}`, err);
        }
      }
    }
  }
}
```

> Nota: eliminar `OnModuleInit` y el `setInterval` de 1 segundo. Registrar `ReconciliationService` en el módulo sin cambios extra si `ScheduleModule` ya está en `AppModule`.

---

### Reto 2.2 — Validación de entrada: `qty ≤ 0` no devuelve 400

**Síntoma:** Se aceptan cantidades negativas; el total de la orden puede ser negativo. Test en rojo: `rechaza cantidades negativas`.

**Causa raíz:** `configureApp()` está vacío (sin `ValidationPipe`). Los DTOs no usan decoradores de `class-validator`.

#### Solución A — ValidationPipe global + decoradores en DTOs

- En `app-setup.ts`:
  ```typescript
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  ```
- En `create-order.dto.ts`: `@IsArray()`, `@ValidateNested()`, `@Min(1)` en `qty`, `@IsMongoId()` en `productId`.
- Igual para `wallet/topup`: `@IsInt()`, `@Min(1)` en `amountCents`.


| Pros                                | Contras                      |
| ----------------------------------- | ---------------------------- |
| Patrón estándar NestJS              | Requiere DTOs bien definidos |
| Reutilizable en todos los endpoints |                              |


#### Solución B — Validación manual en el servicio

- En `OrdersService.create()`, comprobar `item.qty > 0` y lanzar `BadRequestException`.
- Repetir en controller de wallet.


| Pros                      | Contras                                           |
| ------------------------- | ------------------------------------------------- |
| Rápido para un solo campo | Duplicación, fácil de olvidar en nuevos endpoints |
| No depende de pipes       | No escala                                         |


#### ✅ Recomendación: **Solución A**

`class-validator` ya está en `package.json`. Es el enfoque idiomático de NestJS y previene regresiones en todos los endpoints.

**Archivos:** `app-setup.ts`, `create-order.dto.ts`, nuevo DTO para topup.

#### 💻 Código de la solución recomendada

`**src/app-setup.ts`**

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
}
```

`**src/orders/dto/create-order.dto.ts**`

```typescript
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsMongoId,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateOrderItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  qty: number;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
```

`**src/wallet/dto/topup.dto.ts**` (nuevo)

```typescript
import { IsInt, Min } from 'class-validator';

export class TopupDto {
  @IsInt()
  @Min(1)
  amountCents: number;
}
```

`**src/wallet/wallet.controller.ts**` (usar el DTO)

```typescript
import { TopupDto } from './dto/topup.dto';

@Post('topup')
topup(
  @Headers('x-user-id') userId: string,
  @Body() body: TopupDto,
) {
  return this.wallet.topup(userId, body.amountCents);
}
```

---

### Reto 2.3 — IDOR: un usuario ve órdenes de otro

**Síntoma:** `GET /orders/:id` devuelve cualquier orden si conoces el ID. Test en rojo: `un usuario NO puede ver la orden de otro usuario`.

**Causa raíz:** `findOneForUser` no compara `order.userId` con el `userId` del header.

```89:95:src/orders/orders.service.ts
  async findOneForUser(userId: string, orderId: string) {
    const order = await this.orderModel.findById(orderId);
    if (!order) {
      throw new NotFoundException('Orden no encontrada');
    }
    return order;
  }
```

#### Solución A — Filtro en la query

```typescript
const order = await this.orderModel.findOne({ _id: orderId, userId });
if (!order) throw new NotFoundException('Orden no encontrada');
```


| Pros                                                     | Contras |
| -------------------------------------------------------- | ------- |
| Una query, respuesta 404 uniforme (no filtra existencia) |         |
| Patrón OWASP recomendado                                 |         |


#### Solución B — Guard/middleware de autorización

- Crear `OrderOwnershipGuard` que valide pertenencia antes del handler.
- Centralizar lógica de “recurso propio” para futuros endpoints.


| Pros                             | Contras                         |
| -------------------------------- | ------------------------------- |
| Escalable si hay muchos recursos | Más boilerplate para 1 endpoint |
| Separación de responsabilidades  |                                 |


#### ✅ Recomendación: **Solución A**

Para un solo endpoint, el filtro en query es correcto, seguro (404 en ambos casos) y mínimo. Aplicar la misma lógica en `pay()` para que un usuario no pague órdenes ajenas.

**Archivos:** `orders.service.ts`.

#### 💻 Código de la solución recomendada

`**src/orders/orders.service.ts`** — métodos `findOneForUser` y filtro en `pay`

```typescript
async findOneForUser(userId: string, orderId: string) {
  const order = await this.orderModel.findOne({ _id: orderId, userId });
  if (!order) {
    throw new NotFoundException('Orden no encontrada');
  }
  return order;
}

// Dentro de pay(), al cargar la orden:
const order = await this.orderModel.findOne({
  _id: orderId,
  userId,
  status: 'pending',
});
if (!order) {
  throw new NotFoundException('Orden no encontrada');
}
```

> Usar siempre `404` cuando la orden no existe **o** no pertenece al usuario (no revelar existencia con `403`).

---

### Reto 2.4 — Stock negativo / oversell

**Síntoma:** Se puede pagar una orden con más unidades de las disponibles; `product.stock` queda negativo. Test: `no permite vender más stock del disponible`.

**Causa raíz:** `pay()` descuenta stock sin validar disponibilidad ni usar operaciones atómicas.

```66:70:src/orders/orders.service.ts
        for (const item of order.items) {
          const product = await this.productModel.findById(item.productId);
          product.stock -= item.qty;
          await product.save();
        }
```

#### Solución A — Validación + decremento atómico con condición

```typescript
const updated = await this.productModel.findOneAndUpdate(
  { _id: item.productId, stock: { $gte: item.qty } },
  { $inc: { stock: -item.qty } },
  { new: true },
);
if (!updated) throw new BadRequestException('Stock insuficiente');
```

- Ejecutar dentro de una **transacción MongoDB** junto con el débito de wallet y el cambio de estado de la orden.


| Pros                              | Contras                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Atómico, seguro ante concurrencia | Requiere replica set / transacciones (memory server en tests las soporta) |
| Correcto a nivel de negocio       |                                                                           |


#### Solución B — Validar stock solo al crear la orden

- En `create()`, rechazar si `qty > product.stock`.
- No volver a validar en `pay()`.


| Pros                 | Contras                                          |
| -------------------- | ------------------------------------------------ |
| Simple               | **No resuelve** race entre dos pagos simultáneos |
| Evita órdenes obvias | Stock puede cambiar entre create y pay           |


#### ✅ Recomendación: **Solución A**

La validación en `create()` es complementaria (UX temprana), pero el fix real debe estar en `pay()` con `$inc` condicional y transacción. La Solución B sola es un parche.

**Archivos:** `orders.service.ts`, posiblemente `orders.module.ts` (sesión de Mongo).

#### 💻 Código de la solución recomendada

El decremento de stock va **dentro** de la transacción de `pay()` (ver Reto 2.5). Fragmento aislado:

```typescript
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
```

Complemento opcional en `create()` (feedback temprano, no sustituye el fix en `pay`):

```typescript
if (item.qty > product.stock) {
  throw new BadRequestException(
    `Stock insuficiente para producto ${item.productId}`,
  );
}
```

---

### Reto 2.5 — Saldo incorrecto / pagos concurrentes

**Síntoma:** Doble click o pagos simultáneos pueden dejar saldo negativo. Test pendiente: `it.todo('los pagos concurrentes...')`.

**Causa raíz:** Patrón read-modify-write sin bloqueo:

```61:64:src/orders/orders.service.ts
      const wallet = await this.walletModel.findOne({ userId });
      if (wallet && wallet.balanceCents >= order.totalCents) {
        wallet.balanceCents -= order.totalCents;
        await wallet.save();
```

Además, si el saldo es insuficiente, **no lanza error** — devuelve la orden sin pagar.

#### Solución A — Transacción MongoDB con updates atómicos

```typescript
const session = await this.connection.startSession();
await session.withTransaction(async () => {
  const wallet = await this.walletModel.findOneAndUpdate(
    { userId, balanceCents: { $gte: order.totalCents } },
    { $inc: { balanceCents: -order.totalCents } },
    { session, new: true },
  );
  if (!wallet) throw new BadRequestException('Saldo insuficiente');

  const paid = await this.orderModel.findOneAndUpdate(
    { _id: orderId, userId, status: 'pending' },
    { status: 'paid' },
    { session, new: true },
  );
  if (!paid) throw new NotFoundException(...);

  // stock con $inc condicional en la misma transacción
});
```


| Pros                                           | Contras                      |
| ---------------------------------------------- | ---------------------------- |
| Correcto ante concurrencia                     | Requiere transacciones Mongo |
| Un solo flujo coherente wallet + order + stock |                              |


#### Solución B — Optimistic locking (campo `version`)

- Añadir `@Prop() version` en `Wallet` y `Product`.
- Reintentar en conflicto de versión (patrón retry).


| Pros                                       | Contras                            |
| ------------------------------------------ | ---------------------------------- |
| Funciona sin transacciones multi-documento | Más complejo, lógica de reintentos |
|                                            | Peor UX bajo alta contención       |


#### ✅ Recomendación: **Solución A**

MongoDB 4+ con transacciones es el enfoque natural para “pago = débito + stock + estado”. Combinar con idempotencia en `pay()` (rechazar si `status !== 'pending'`) evita doble cobro.

**Archivos:** `orders.service.ts`, `orders.module.ts`.

#### 💻 Código de la solución recomendada

`**src/orders/orders.service.ts`** — inyectar conexión e implementar `pay()` completo (integra 2.4, 2.5, 2.6 y evita N+1 en stock):

```typescript
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
// ... resto de imports

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
    } finally {
      await session.endSession();
    }
  }
}
```

> `@InjectConnection()` funciona porque `MongooseModule.forRoot()` ya está en `AppModule`. No hace falta cambiar `orders.module.ts`.

---

### Reto 2.6 — Errores silenciosos en el pago

**Síntoma:** Un pago fallido puede reportar éxito (`{ status: 'ok' }`). Regla de negocio #5 incumplida.

**Causa raíz:**

```84:86:src/orders/orders.service.ts
    } catch (e) {
      return { status: 'ok' };
    }
```

También: saldo insuficiente no lanza excepción; devuelve orden `pending` con HTTP 201.

#### Solución A — Eliminar el catch silencioso; propagar excepciones NestJS

- Borrar el `try/catch` o re-lanzar con `throw e`.
- Lanzar `BadRequestException` si saldo insuficiente.
- Lanzar `ConflictException` si la orden ya está pagada.
- Loguear errores inesperados con `Logger.error`.


| Pros                               | Contras                                       |
| ---------------------------------- | --------------------------------------------- |
| Comportamiento HTTP correcto (4xx) | Requiere ajustar tests que asumen 201 siempre |
| Transparente para el cliente       |                                               |


#### Solución B — Resultado tipado (discriminated union)

- `pay()` retorna `{ ok: true, order } | { ok: false, reason: 'INSUFFICIENT_FUNDS' | ... }`.
- El controller mapea a status HTTP.


| Pros                               | Contras                    |
| ---------------------------------- | -------------------------- |
| Control explícito del contrato API | Menos idiomático en NestJS |
|                                    | Más código en controller   |


#### ✅ Recomendación: **Solución A**

Las excepciones HTTP de NestJS son el estándar del framework. El `catch` que devuelve `{ status: 'ok' }` es claramente un bug intencional — eliminarlo es prioritario.

**Archivos:** `orders.service.ts`, `orders.controller.ts` (códigos HTTP explícitos si hace falta).

#### 💻 Código de la solución recomendada

Eliminar por completo el bloque defectuoso y dejar que NestJS propague las excepciones:

```typescript
// ❌ ELIMINAR esto:
async pay(userId: string, orderId: string) {
  try {
    // ...
    return order;
  } catch (e) {
    return { status: 'ok' };  // bug intencional
  }
}

// ✅ REEMPLAZAR por pay() sin try/catch silencioso (ver Reto 2.5).
// Las excepciones BadRequestException, NotFoundException y ConflictException
// se convierten automáticamente en 400, 404 y 409.
```

`**src/orders/orders.controller.ts**` — códigos HTTP explícitos (opcional pero claro):

```typescript
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  // ...

  @Post()
  @HttpCode(201)
  create(
    @Headers('x-user-id') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.create(userId, dto);
  }

  @Post(':id/pay')
  @HttpCode(200)
  pay(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.orders.pay(userId, id);
  }
}
```

Ajuste en test de oversell — esperar error explícito tras el fix:

```typescript
await request(server)
  .post(`/orders/${created.body._id}/pay`)
  .set('x-user-id', user)
  .expect(400); // BadRequestException por stock insuficiente
```

---

## Nivel 3 — Bonus (rendimiento y calidad)

### Reto 3.1 — Consultas N+1 en creación y pago de órdenes

**Síntoma:** Por cada ítem de la orden se hace un `findById` secuencial. Regla #7.

**Causa raíz:** Bucles con `await this.productModel.findById` en `create()` y `pay()`.

#### Solución A — Batch query con `$in`

```typescript
const ids = dto.items.map(i => i.productId);
const products = await this.productModel.find({ _id: { $in: ids } });
const byId = new Map(products.map(p => [p._id.toString(), p]));
```


| Pros                  | Contras                                   |
| --------------------- | ----------------------------------------- |
| 1 query en lugar de N | Hay que validar que todos los IDs existen |
| Cambio localizado     |                                           |


#### Solución B — DataLoader (patrón GraphQL/batching)

- Cache por request para deduplicar lecturas de productos.


| Pros                                   | Contras                           |
| -------------------------------------- | --------------------------------- |
| Elegante en APIs con muchas relaciones | Over-engineering para REST simple |


#### ✅ Recomendación: **Solución A**

Suficiente para demostrar conciencia de rendimiento sin añadir dependencias.

**Archivos:** `orders.service.ts`.

#### 💻 Código de la solución recomendada

`**src/orders/orders.service.ts`** — método `create()` con batch query:

```typescript
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
    if (item.qty > product.stock) {
      throw new BadRequestException(
        `Stock insuficiente para producto ${item.productId}`,
      );
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
```

> De N queries (`findById` en bucle) pasa a **1 query** con `$in`.

---

### Reto 3.2 — Faltan índices en campos filtrados

**Síntoma:** Consultas lentas al crecer la DB (`status`, `userId`, `orderId` en transacciones).

#### Solución A — Índices en los schemas Mongoose

```typescript
OrderSchema.index({ userId: 1, status: 1 });
OrderSchema.index({ status: 1 }); // conciliación
WalletTransactionSchema.index({ orderId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'reconciliation' } });
```


| Pros                             | Contras                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Declarativo, se crea al arrancar | Índices únicos pueden fallar si ya hay duplicados (limpiar en dev) |
| Mejora conciliación e IDOR       |                                                                    |


#### Solución B — Script de migración separado

- `npm run migrate:indexes` con `createIndexes()` explícito.


| Pros                           | Contras                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| Control en despliegues grandes | Paso manual extra (conflicto con requisito Docker sin pasos extra) |


#### ✅ Recomendación: **Solución A**

Los índices en schema son automáticos y alineados con NestJS/Mongoose. El índice único de conciliación también implementa idempotencia (Reto 2.1).

**Archivos:** `order.schema.ts`, `wallet-transaction.schema.ts`, `wallet.schema.ts` (ya tiene `unique` en `userId`).

#### 💻 Código de la solución recomendada

`**src/orders/schemas/order.schema.ts`**

```typescript
export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ userId: 1, _id: 1 });       // GET /orders/:id con ownership
OrderSchema.index({ status: 1 });               // conciliación de pendientes
OrderSchema.index({ userId: 1, status: 1 });  // consultas combinadas
```

`**src/wallet/schemas/wallet-transaction.schema.ts**`

```typescript
export const WalletTransactionSchema =
  SchemaFactory.createForClass(WalletTransaction);

WalletTransactionSchema.index({ userId: 1, createdAt: -1 });
WalletTransactionSchema.index(
  { orderId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'reconciliation' },
  },
);
```

`**src/wallet/schemas/wallet.schema.ts**` — ya tiene `@Prop({ unique: true })` en `userId`; opcionalmente reforzar:

```typescript
export const WalletSchema = SchemaFactory.createForClass(Wallet);
WalletSchema.index({ userId: 1 }, { unique: true });
```

---

### Reto 3.3 — Test de concurrencia (entregable)

**Síntoma:** `it.todo('los pagos concurrentes no permiten gastar más que el saldo')` sin implementar.

#### Solución A — Test e2e con `Promise.all`

- Topup exacto para 1 orden.
- Crear 2 órdenes con el mismo costo total al saldo.
- Disparar ambos `POST /orders/:id/pay` en paralelo.
- Assert: una `paid`, otra falla; `balanceCents >= 0`.


| Pros                      | Contras                         |
| ------------------------- | ------------------------------- |
| Reproduce el bug real     | Puede ser flaky sin fix atómico |
| Valorado en la evaluación |                                 |


#### Solución B — Test de integración unitario con mocks de race

- Mockear `findOne` para simular interleaving.


| Pros         | Contras                           |
| ------------ | --------------------------------- |
| Determinista | No prueba el stack completo       |
|              | Menos convincente en defensa oral |


#### ✅ Recomendación: **Solución A**

La prueba pide tests que reproduzcan bugs reales. Implementar el test **antes** del fix ayuda a validar TDD; debe pasar tras aplicar Reto 2.5.

**Archivos:** `test/orders.e2e-spec.ts`.

#### 💻 Código de la solución recomendada

`**test/orders.e2e-spec.ts`** — reemplazar el `it.todo` por:

```typescript
it('los pagos concurrentes no permiten gastar más que el saldo', async () => {
  const user = 'user-concurrent';
  const priceCents = 500;
  const productId = await seedProduct(priceCents, 100);

  // Saldo exacto para UNA sola orden
  await request(server)
    .post('/wallet/topup')
    .set('x-user-id', user)
    .send({ amountCents: priceCents })
    .expect(201);

  const orderA = await request(server)
    .post('/orders')
    .set('x-user-id', user)
    .send({ items: [{ productId, qty: 1 }] })
    .expect(201);

  const orderB = await request(server)
    .post('/orders')
    .set('x-user-id', user)
    .send({ items: [{ productId, qty: 1 }] })
    .expect(201);

  const [payA, payB] = await Promise.all([
    request(server)
      .post(`/orders/${orderA.body._id}/pay`)
      .set('x-user-id', user),
    request(server)
      .post(`/orders/${orderB.body._id}/pay`)
      .set('x-user-id', user),
  ]);

  const statuses = [payA.status, payB.status].sort();
  // Uno debe tener éxito (200/201) y el otro fallar (400)
  expect(statuses).toContain(400);
  expect(statuses.some((s) => s >= 200 && s < 300)).toBe(true);

  const wallet = await request(server)
    .get('/wallet')
    .set('x-user-id', user)
    .expect(200);

  expect(wallet.body.balanceCents).toBeGreaterThanOrEqual(0);
});
```

---


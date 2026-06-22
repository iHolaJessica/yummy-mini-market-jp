# BUGS encontrados

> Completa una entrada por cada bug que encuentres. Sé conciso (3–4 líneas por campo).
> Este documento es la base de tu defensa oral.

---

## Bug 1 — Docker build falla al compilar

- **Nivel:** 1
- **Archivo(s):** `Dockerfile`
- **Síntoma:** `docker compose up --build` falla durante la etapa de build, presenta errores con las dependencias al intentar interpretar modulos dentro de `node_modules/@nestjs/core/package.json`.
- **Causa raíz:** El Dockerfile original usaba `npm ci --omit=dev` antes del build, lo que eliminada debependencias necesarias para compilar la aplicación (sin `@nestjs/cli`/`typescript`). Provocando fallos en la compilación.
- **Fix:** Build multi-stage: en `builder` se ejecuta `npm ci` completo + `npm run build`, para instalar y posteriormente compilar la aplicación. En la imagen final se hace `npm ci --omit=dev` limpio y solo se copia `dist/`.
- **Prevención:** Se debe mantener el uso de Docker multi-stage build para separar claramente la fase de compilación con la de ejecución.

---

## Bug 2 — MongoDB apunta a localhost dentro de Docker

- **Nivel:** 1
- **Archivo(s):** `src/app.module.ts`, `docker-compose.yml`
- **Síntoma:** La app levanta en Docker pero no conecta a MongoDB, o falla al arrancar porque intenta `mongodb://localhost:27017` en lugar del servicio `mongo`.
- **Causa raíz:** `MongooseModule.forRoot()` utilizaba una URI de conexión con localhost. En este contexto, los contenedores se comunican a través de la red interna, por lo que el host correcto debe ser el nombre del servicio definido en docker-compose.
- **Fix:** Leer `process.env.MONGO_URI` para desarrollo local. En `docker-compose.yml` definir `MONGO_URI=mongodb://mongo:27017/market` y `depends_on` con `condition: service_healthy` + healthcheck en Mongo para asegurar que la base de datos este disponible antes de iniciar la aplicación.
- **Prevención:** Nunca hardcodear hosts de infra; documentar variables en `.env.example` y validar arranque con `docker compose up --build` sin pasos manuales.

---

## Bug 3 — La base de datos crece sin operaciones de usuario

- **Nivel:** 2
- **Archivo(s):** `src/reconciliation/reconciliation.service.ts`, `src/wallet/schemas/wallet-transaction.schema.ts`
- **Síntoma:** La colección `wallet_transactions` crece continuamente al arrancar la app, insertando registros `reconciliation` cada segundo aunque no haya actividad nueva.
- **Causa raíz:** `ReconciliationService` usaba `setInterval(..., 1000)` y, en cada tick, hacía `create()` por cada orden `pending` sin comprobar si ya existía un registro de conciliación para esa orden.
- **Fix:** Se reemplaza `setInterval` por `@Cron` para ejecución programada controlada. Se sustituye `create()` por `updateOne` con `upsert` y `$setOnInsert` para evitar duplicados e idempotencia. Además, se agrega un índice único por `{ orderId, type }` (filtrado por `reconciliation`) para garantizar consistencia de datos.
- **Prevención:** Jobs periódicos deben ser idempotentes; usar índices únicos para garantizar la consistencia de los datos; limitar el batch (`limit(100)`) por ciclo para evitar sobrecargas.

---

## Bug 4 — Cantidades negativas o cero no devuelven 400

- **Nivel:** 2
- **Archivo(s):** `src/app-setup.ts`, `src/orders/dto/create-order.dto.ts`, `src/wallet/wallet.controller.ts`
- **Síntoma:** `POST /orders` con `qty: -1` o `qty: 0` responde 201 y el total de la orden puede ser negativo. El test *rechaza cantidades negativas* falla.
- **Causa raíz:** La aplicación no cuenta con un mecanismo central de validación de datos de entrada. Los DTOs no incluyen decoradores de validación, por lo que NestJS no aplica reglas sobre el payload recibido y permite la entrada de datos inválidos.
- **Fix:**Activar `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted` para eliminar y rechazar campos extra, y `transform` para convertir datos. Agregar `@Min(1)` en `qty` y `@IsInt()` + `@Min(1)` en `amountCents`, asegurando un contrato de entrada validado a nivel de DTO, incluyendo la validación de la estructura del payload.
- **Prevención:** Asegurar que la validación sea global, consistente en todos los endpoints y verificada automáticamente mediante tests que incluyen casos inválidos.

---

## Bug 5 — IDOR en GET /orders/:id

- **Nivel:** 2
- **Archivo(s):** `src/orders/orders.service.ts`
- **Síntoma:** Un usuario que conoce el `_id` de una orden ajena obtiene 200 con datos de otro usuario en `GET /orders/:id`. El test *un usuario NO puede ver la orden de otro* falla.
- **Causa raíz:** `findOneForUser()` usa `findById(orderId)` sin filtrar por `userId` del header `x-user-id`. Lo mismo ocurre al cargar la orden en `pay()`.
- **Fix:** Cambiar a `findOne({ _id: orderId, userId })` en `findOneForUser` y en `pay()`. Responder siempre `404` si no hay match (no revelar existencia con `403`).
- **Prevención:**En lugar de traer el recurso y luego validar si pertenece al usuario, es más seguro filtrar directamente en la consulta a la base de datos. Así evitamos exponer datos de otros usuarios y prevenimos vulnerabilidades como IDOR.

---

## Bug 6 — Stock negativo (oversell)

- **Nivel:** 2
- **Archivo(s):** `src/orders/orders.service.ts`
- **Síntoma:** Se puede pagar una orden con más unidades de las disponibles; `product.stock` queda negativo. 
- **Causa raíz:** En `pay()` el stock se descuenta con read-modify-write (`product.stock -= item.qty; save()`) sin validar disponibilidad ni operación atómica, por lo que dos pagos pueden usar el mismo stock al mismo tiempo.
- **Fix:** En `pay()`, usar `findOneAndUpdate` con `{ stock: { $gte: item.qty } }` y `{ $inc: { stock: -item.qty } }` dentro de una transacción en MongoDB. Lanzar `BadRequestException` si no hay match. Validación temprana opcional en `create()`.
- **Prevención:** Usar actualizaciones condicionales atómicas en lugar de read-modify-write y garantizar transacciones multi-documento para asegurar que el pago, el stock y el wallet se actualicen de forma consistente y conjunta.

---

## Bug 7 — Saldo incorrecto ante pagos concurrentes

- **Nivel:** 2
- **Archivo(s):** `src/orders/orders.service.ts`
- **Síntoma:** Dos pagos simultáneos pueden dejar `balanceCents` negativo. 
- **Causa raíz:** `pay()` lee el wallet, comprueba saldo en memoria y guarda (`wallet.balanceCents -= total; save()`). Sin atomicidad, dos requests pueden leer el mismo saldo y ambos debitar.
- **Fix:** Crear una única operación con `findOneAndUpdate({ userId, balanceCents: { $gte: total } }, { $inc: { balanceCents: -total } })`, y que el cambio de estado de la orden ocurra en la misma transacción. Rechazar con `BadRequestException` si el update no modifica documento.
- **Prevención:** Siempre probar escenarios concurrentes y evitar el patrón "leer, modificar y guardar" cuando varios procesos pueden cambiar el mismo dato simultáneamente.

---

## Bug 8 — Errores silenciosos en el pago

- **Nivel:** 2
- **Archivo(s):** `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`
- **Síntoma:** Un pago fallido puede responder `{ status: 'ok' }` o devolver la orden `pending` con HTTP 201/200 aunque el saldo sea insuficiente. Incumple la regla de negocio #5.
- **Causa raíz:** Bloque `catch (e) { return { status: 'ok' }; }` traga cualquier excepción. Además, saldo insuficiente no lanza error: simplemente no entra al `if` y retorna la orden sin pagar.
- **Fix:** Eliminar el catch silencioso; propagar excepciones NestJS (`BadRequestException`, `NotFoundException`, `ConflictException`). Lanzar error explícito cuando el débito atómico no aplique. 
- **Prevención:** No capturar excepciones sin re-lanzar en flujos de pago; tests que esperen 4xx en fallos de saldo/stock; logging con `Logger.error` solo para errores inesperados.

---

## Bug 9 — Consultas N+1 al crear y pagar órdenes

- **Nivel:** 3
- **Archivo(s):** `src/orders/orders.service.ts`
- **Síntoma:** Cuando se crea o paga una orden, el sistema busca cada producto uno por uno en la base de datos con un`findById`.
- **Causa raíz:** Bucles `for` que recorren cada producto esperando que cada consulta se termine antes de ejecutar una nuevamente `await`.
- **Fix:** Recolectar IDs con `dto.items.map(i => i.productId)`, ejecutar una sola consulta, Se organizan los productos usando su `_id` como clave para encontrarlos rápidamente-
- **Prevención:** Revisar bucles con `await`, ya que suele ser una señal se consultas repetitivas a la base de datos.

---

## Bug 10 — Faltan índices en campos filtrados

- **Nivel:** 3
- **Archivo(s):** `src/orders/schemas/order.schema.ts`, `src/wallet/schemas/wallet-transaction.schema.ts`
- **Síntoma:** Las búsquedas por `userId`, `status` y `orderId` se vuelven cada vez más lentas a medida que crece la cantidad de datos en MongoDB.
- **Causa raíz:** Los schemas no tenían índices en los campos que se usan frecuentemente para buscar información.
- **Fix:** En `OrderSchema`: índices `{ userId: 1, _id: 1 }`, `{ status: 1 }`, `{ userId: 1, status: 1 }`. En `WalletTransactionSchema`: `{ userId: 1, createdAt: -1 }.` Se crearon "índices" para que MongoDB encuentre los registros más rápido
- **Prevención:** Cada vez que se agregue una nueva búsqueda importante, se debe evaluar si necesita un índice para mantener un buen rendimiento cuando la base de datos crezca.

---


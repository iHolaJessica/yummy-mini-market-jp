import request from 'supertest';
import { createTestApp, TestContext } from './test-app';

describe('Orders', () => {
  let ctx: TestContext;
  let server: any;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  // Inserta un producto a medida para escenarios concretos.
  async function seedProduct(priceCents: number, stock: number) {
    const p = await ctx.productModel.create({
      name: `test-${priceCents}-${stock}`,
      priceCents,
      stock,
    });
    return p._id.toString();
  }

  it('flujo feliz: recargar saldo, crear orden y pagarla', async () => {
    const user = 'user-happy';
    const productId = await seedProduct(850, 10);

    await request(server)
      .post('/wallet/topup')
      .set('x-user-id', user)
      .send({ amountCents: 5000 })
      .expect(201);

    const created = await request(server)
      .post('/orders')
      .set('x-user-id', user)
      .send({ items: [{ productId, qty: 1 }] })
      .expect(201);

    const orderId = created.body._id;

    const paid = await request(server)
      .post(`/orders/${orderId}/pay`)
      .set('x-user-id', user)
      .expect(200);

    expect(paid.body.status).toBe('paid');
  });

  it('rechaza el pago cuando el saldo es insuficiente', async () => {
    const user = 'user-no-funds';
    const productId = await seedProduct(850, 10);

    const created = await request(server)
      .post('/orders')
      .set('x-user-id', user)
      .send({ items: [{ productId, qty: 1 }] })
      .expect(201);

    await request(server)
      .post(`/orders/${created.body._id}/pay`)
      .set('x-user-id', user)
      .expect(400);

    const order = await request(server)
      .get(`/orders/${created.body._id}`)
      .set('x-user-id', user)
      .expect(200);

    expect(order.body.status).toBe('pending');
  });

  it('rechaza cantidades negativas (no debe permitir total negativo)', async () => {
    const user = 'user-neg';
    const productId = await seedProduct(850, 10);

    await request(server)
      .post('/orders')
      .set('x-user-id', user)
      .send({ items: [{ productId, qty: -3 }] })
      .expect(400);
  });

  it('un usuario NO puede ver la orden de otro usuario (IDOR)', async () => {
    const owner = 'user-owner';
    const attacker = 'user-attacker';
    const productId = await seedProduct(850, 10);

    const created = await request(server)
      .post('/orders')
      .set('x-user-id', owner)
      .send({ items: [{ productId, qty: 1 }] })
      .expect(201);

    const orderId = created.body._id;

    await request(server)
      .get(`/orders/${orderId}`)
      .set('x-user-id', attacker)
      .expect(404);
  });

  it('no permite vender más stock del disponible (oversell)', async () => {
    const user = 'user-oversell';
    const productId = await seedProduct(100, 1); // solo 1 en stock

    await request(server)
      .post('/wallet/topup')
      .set('x-user-id', user)
      .send({ amountCents: 100000 })
      .expect(201);

    const created = await request(server)
      .post('/orders')
      .set('x-user-id', user)
      .send({ items: [{ productId, qty: 5 }] }) // pide 5
      .expect(201);

    await request(server)
      .post(`/orders/${created.body._id}/pay`)
      .set('x-user-id', user);

    const product = await ctx.productModel.findById(productId);
    expect(product.stock).toBeGreaterThanOrEqual(0);
  });

  it('los pagos concurrentes no permiten gastar más que el saldo', async () => {
    const user = 'user-concurrent';
    const priceCents = 500;
    const productId = await seedProduct(priceCents, 100);

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
    expect(statuses).toContain(400);
    expect(statuses.some((s) => s >= 200 && s < 300)).toBe(true);

    const wallet = await request(server)
      .get('/wallet')
      .set('x-user-id', user)
      .expect(200);

    expect(wallet.body.balanceCents).toBeGreaterThanOrEqual(0);
  });
});

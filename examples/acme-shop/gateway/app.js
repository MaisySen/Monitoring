const { metrics } = require('@monitoring/trace');
const express = require('express');
const log = require('../log')('web-gateway');
const app = express(); app.use(express.json());
const CATALOG = 'http://127.0.0.1:4101', CART = 'http://127.0.0.1:4102', PAY = 'http://127.0.0.1:4103';
async function call(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
app.get('/products', async (req, res) => { const r = await call(`${CATALOG}/products`); log.info('listed products', { count: r.body.length }); res.status(r.status).json(r.body); });
app.get('/product/:id', async (req, res) => {
  const r = await call(`${CATALOG}/product/${req.params.id}`);
  if (r.status === 404) log.warn('product not found', { sku: req.params.id });
  res.status(r.status).json(r.body);
});
app.post('/cart', async (req, res) => { const r = await call(`${CART}/cart`, { method: 'POST', body: req.body }); res.status(r.status).json(r.body); });
app.post('/checkout', async (req, res) => {
  const user = req.body.user;
  const cart = await call(`${CART}/cart/${user}`);
  if (cart.status >= 500) {
    metrics.increment('acme.checkout.failed', 1, { reason: 'cart_unavailable' });
    log.error('checkout failed: cart-service returned ' + cart.status, { user });
    return res.status(502).json({ error: 'cart unavailable' });
  }
  const items = cart.body.items ?? [];
  if (!items.length) { log.warn('checkout with empty cart', { user }); return res.status(400).json({ error: 'empty cart' }); }
  const prices = await Promise.all(items.map((i) => call(`${CATALOG}/product/${i.sku}`)));
  const total = items.reduce((s, i, k) => s + (prices[k].body.price_cents ?? 0) * i.qty, 0);
  const pay = await call(`${PAY}/charge`, { method: 'POST', body: { user, total_cents: total } });
  if (pay.status !== 200) {
    metrics.increment('acme.checkout.failed', 1, { reason: pay.body.reason ?? 'unknown' });
    log.error('checkout failed: payment ' + (pay.body.reason ?? pay.status), { user, total_cents: total });
    return res.status(502).json({ error: 'payment failed', reason: pay.body.reason });
  }
  await call(`${CART}/cart/${user}`, { method: 'DELETE' });
  metrics.increment('acme.checkout.completed', 1, { plan: user % 5 === 0 ? 'pro' : 'free' });
  metrics.histogram('acme.checkout.value', total / 100, { currency: 'usd' });
  log.info('checkout complete', { user, order_id: pay.body.order_id, total_cents: total });
  res.json({ ok: true, order_id: pay.body.order_id, total_cents: total });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(4100, () => log.info('web-gateway listening on 4100'));

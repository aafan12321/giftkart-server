'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApp } = require('../app');
const { MemoryStore } = require('../payments/store');
const { hmacHex } = require('../payments/service');
const { orderIdFor, optimizeCloudinary, sanitizeForFirestore, isValidRzpOrderId } = require('../payments/ids');

const KEY_SECRET = 'test_key_secret';
const WH_SECRET = 'test_webhook_secret';
const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(60);

function makeRazorpay() {
  const state = { orders: new Map(), payments: new Map(), apiDown: false, apiHang: false, captureCalls: 0, n: 0 };
  const down = () => Object.assign(new Error('razorpay down'), { statusCode: 502 });
  const rz = {
    state,
    orders: {
      create: async (o) => {
        state.n += 1;
        const id = `order_TestOrder${String(state.n).padStart(6, '0')}`;
        const order = { id, amount: o.amount, currency: o.currency, notes: o.notes, status: 'created' };
        state.orders.set(id, order);
        return { ...order };
      },
      fetch: async (id) => { const o = state.orders.get(id); if (!o) throw Object.assign(new Error('nf'), { statusCode: 400 }); return { ...o }; },
      fetchPayments: async (id) => {
        if (state.apiDown) throw down();
        if (!state.orders.has(id)) throw Object.assign(new Error('nf'), { statusCode: 400 });
        return { items: [...state.payments.values()].filter((p) => p.order_id === id) };
      },
    },
    payments: {
      fetch: async (id) => {
        if (state.apiDown) throw down();
        if (state.apiHang) return new Promise(() => {});
        const p = state.payments.get(id);
        if (!p) throw Object.assign(new Error('nf'), { statusCode: 404 });
        return { ...p };
      },
      capture: async (id) => { state.captureCalls += 1; const p = state.payments.get(id); p.status = 'captured'; return { ...p }; },
      all: async ({ skip = 0, count = 100 }) => ({ items: [...state.payments.values()].slice(skip, skip + count) }),
    },
  };
  rz.addPayment = (order_id, over = {}) => {
    const id = over.id || `pay_Test${state.payments.size + 1}abc`;
    const p = { id, order_id, amount: state.orders.get(order_id) ? state.orders.get(order_id).amount : 49900, currency: 'INR', status: 'captured', method: 'upi', contact: '+919999999999', email: 'c@x.com', created_at: Math.floor(Date.now() / 1000) - 3600, ...over };
    state.payments.set(id, p);
    return p;
  };
  return rz;
}

function makeMailer() {
  const m = { sent: [], alerts: [], photos: [], fail: false };
  m.sendOrderEmail = async (d) => { if (m.fail) return false; m.sent.push(d); return true; };
  m.sendAlert = async (s, h) => { m.alerts.push({ s, h }); return true; };
  m.sendCancellation = async () => true;
  m.sendPhoto = async (d) => { m.photos.push(d); return true; };
  return m;
}

function makeReferral(enabled = false) {
  const calls = { reserve: [], redeem: [], mark: [], release: [] };
  return {
    enabled, calls,
    router: express.Router(), adminRouter: express.Router(),
    authenticate: async (req) => (req.get('authorization') === 'Bearer good' ? { uid: 'u1' } : null),
    sendError: (res, e) => res.status(400).json({ error: 'referral_error', message: e.message }),
    service: {
      reserve: async (uid, rupees) => { calls.reserve.push([uid, rupees]); return { discount: 50 }; },
      attachOrder: async () => {}, release: async (...a) => { calls.release.push(a); },
      redeem: async (uid, rid, oid) => { calls.redeem.push([uid, rid, oid]); return { redeemed: true, discount: 50 }; },
      markOrderCompleted: async (uid) => { calls.mark.push(uid); },
      redeemCod: async () => ({ discount: 50 }),
    },
  };
}

const closers = [];
test.after(async () => { for (const c of closers) await c(); });

async function boot({ referral = makeReferral(false), config = {} } = {}) {
  const razorpay = makeRazorpay(); const store = new MemoryStore(); const mailer = makeMailer();
  const cfg = { razorpayKeyId: 'rzp_test', razorpayKeySecret: KEY_SECRET, webhookSecret: WH_SECRET, razorpayApiTimeoutMs: 200, disableJobs: true, ...config };
  const { app, service } = createApp({ razorpay, store, mailer, referral, config: cfg, logger: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const get = async (path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json() }; };
  const sign = (o, p) => hmacHex(KEY_SECRET, `${o}|${p}`);
  const intent = (rupees = 499) => ({
    expectedPaidRupees: rupees,
    order: {
      product: { name: 'Frame (12")', price: rupees, imageUrl: 'https://x/y.jpg' }, quantity: 1, totalAmount: rupees,
      address: { name: 'Aamir', phone: '9999999999', house: '1', area: 'Bagh', city: 'Srinagar', pincode: '190001' },
      paymentMethod: 'Online Payment', status: 'Confirmed',
      customDetails: { customerName: 'Z', photoUrl: 'https://res.cloudinary.com/doftoomx/image/upload/v1/p.jpg' },
    },
  });
  // create a Razorpay order through the real endpoint (records the intent)
  const createOrder = async (rupees = 499, extra = {}) => {
    const r = await post('/create-order', { amount: rupees * 100, product_name: 'Frame', intent: intent(rupees), ...extra }, extra._h || {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.order_id;
  };
  const close = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
  closers.push(close);
  return { razorpay, store, mailer, service, referral, post, get, sign, intent, createOrder, close, base };
}

const orderDocs = (h) => [...h.store.orders.keys()];

// ── helpers / units ──────────────────────────────────────────────────────────
test('orderIdFor is deterministic and validates input', () => {
  assert.equal(orderIdFor('order_Nxyz1234abcd'), 'GKNxyz1234abcd');
  assert.equal(orderIdFor('order_Nxyz1234abcd'), orderIdFor('order_Nxyz1234abcd'));
  assert.throws(() => orderIdFor(''));
  assert.throws(() => orderIdFor('pay_123456'));
  assert.equal(isValidRzpOrderId('order_abc'), false);
});

test('optimizeCloudinary only rewrites raw upload URLs, with fixed widths', () => {
  const raw = 'https://res.cloudinary.com/doftoomx/image/upload/v1700000000/a/b.png';
  assert.equal(optimizeCloudinary(raw, 300), 'https://res.cloudinary.com/doftoomx/image/upload/f_auto,q_auto:eco,c_limit,w_400/v1700000000/a/b.png');
  assert.match(optimizeCloudinary(raw, 5000), /w_1200\//);
  assert.equal(optimizeCloudinary('https://res.cloudinary.com/doftoomx/image/upload/w_100/v1/a.png', 400), 'https://res.cloudinary.com/doftoomx/image/upload/w_100/v1/a.png');
  assert.equal(optimizeCloudinary('https://example.com/a.png'), 'https://example.com/a.png');
});

test('sanitizeForFirestore drops base64 blobs, undefined and huge strings', () => {
  const out = sanitizeForFirestore({ a: 1, photoBase64: 'x'.repeat(10), b: undefined, c: 'y'.repeat(30000), d: [1, undefined, { photo_base64: 'z', ok: true }], e: NaN });
  assert.deepEqual(out, { a: 1, c: '[omitted: too large]', d: [1, { ok: true }], e: 0 });
});

// ── verify-payment ───────────────────────────────────────────────────────────
test('valid signature: order created from stored intent, one email, deterministic id', async () => {
  const h = await boot();
  const rid = await h.createOrder();
  const pay = h.razorpay.addPayment(rid);
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.order_id, orderIdFor(rid));
  await settle();
  assert.deepEqual(orderDocs(h), [orderIdFor(rid)]);
  const doc = await h.store.getOrder(orderIdFor(rid));
  assert.equal(doc.paymentVerified, true);
  assert.equal(doc.paymentId, pay.id);
  assert.equal(doc.product.name, 'Frame (12")');
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.mailer.sent[0].amount, 499);
  await h.close();
});

test('invalid signature but Razorpay says captured: accepted (never reject a real payment)', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: 'bad' });
  assert.equal(r.status, 200); assert.equal(r.body.success, true);
  await h.close();
});

test('invalid signature and payment NOT captured: rejected (400)', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid, { status: 'failed' });
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: 'bad' });
  assert.equal(r.status, 400);
  assert.equal(orderDocs(h).length, 0);
  await h.close();
});

test('MISSING signature and orderId: recovered from Razorpay by payment id', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: '', signature: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.order_id, orderIdFor(rid));
  await h.close();
});

test('missing signature while Razorpay API is down: 503 retryable (not a hard failure)', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  h.razorpay.state.apiDown = true;
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: '' });
  assert.equal(r.status, 503); assert.equal(r.body.retryable, true);
  assert.equal(orderDocs(h).length, 0);
  await h.close();
});

test('valid signature while Razorpay API is down: accepted, flagged for review', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  h.razorpay.state.apiDown = true;
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  assert.equal(r.status, 200); assert.equal(r.body.success, true);
  await settle();
  assert.match(h.mailer.sent[0].banners.join(' '), /Razorpay API was unreachable/);
  await h.close();
});

test('Razorpay API TIMEOUT (hangs): valid signature still succeeds within the timeout', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  h.razorpay.state.apiHang = true;
  const t0 = Date.now();
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  assert.equal(r.status, 200); assert.ok(Date.now() - t0 < 2000);
  await h.close();
});

test('duplicate verify (10 in parallel): ONE order, ONE email, same id', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const body = { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 };
  const rs = await Promise.all(Array.from({ length: 10 }, () => h.post('/verify-payment', body)));
  assert.ok(rs.every((r) => r.status === 200 && r.body.order_id === orderIdFor(rid)));
  await settle(); await sleep(100);
  assert.equal(orderDocs(h).length, 1);
  assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('amount mismatch is flagged in the email but the paid order is still created', async () => {
  const h = await boot();
  const rid = await h.createOrder(499); const pay = h.razorpay.addPayment(rid);
  await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 4999 });
  await settle();
  assert.equal(orderDocs(h).length, 1);
  assert.match(h.mailer.sent[0].banners.join(' '), /Amount mismatch/);
  await h.close();
});

test('email failure never affects the order; the retry job sends it later', async () => {
  const h = await boot();
  h.mailer.fail = true;
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(orderDocs(h).length, 1); assert.equal(h.mailer.sent.length, 0);
  h.mailer.fail = false;
  await h.store.updatePayment(rid, { paidAtMs: 0, emailClaim: null });
  const n = await h.service.retryUnnotified();
  assert.equal(n, 1); assert.equal(h.mailer.sent.length, 1);
  await h.service.retryUnnotified();
  assert.equal(h.mailer.sent.length, 1, 'never emailed twice');
  await h.close();
});

test('storage down during verify: still answers success and emails the owner', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  h.store.failOrderWrites = true;
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499, product_name: 'Frame' });
  assert.equal(r.status, 200); assert.equal(r.body.success, true);
  await settle();
  assert.equal(h.mailer.sent.length, 1);
  assert.match(h.mailer.sent[0].banners.join(' '), /NOT saved on the server/);
  await h.close();
});

// ── webhook ──────────────────────────────────────────────────────────────────
function webhookBody(event, pay) { return JSON.stringify({ event, payload: { payment: { entity: pay } } }); }
const whHeaders = (raw, id = 'evt_1', secret = WH_SECRET) => ({ 'x-razorpay-signature': hmacHex(secret, raw), 'x-razorpay-event-id': id });

test('webhook: invalid signature rejected; valid one creates the order WITHOUT the app', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const raw = webhookBody('payment.captured', pay);
  assert.equal((await h.post('/razorpay-webhook', raw, whHeaders(raw, 'e0', 'wrong'))).status, 400);
  assert.equal(orderDocs(h).length, 0);
  const r = await h.post('/razorpay-webhook', raw, whHeaders(raw, 'e1'));
  assert.equal(r.status, 200);
  await settle();
  assert.deepEqual(orderDocs(h), [orderIdFor(rid)]);
  assert.equal((await h.store.getOrder(orderIdFor(rid))).product.name, 'Frame (12")', 'full details recovered from the stored intent');
  assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('webhook replay (same event + different event for same payment): one order, one email', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const raw = webhookBody('payment.captured', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw, 'e1'));
  const dup = await h.post('/razorpay-webhook', raw, whHeaders(raw, 'e1'));
  assert.equal(dup.body.duplicate, true);
  const raw2 = webhookBody('order.paid', pay);
  await h.post('/razorpay-webhook', raw2, whHeaders(raw2, 'e2'));
  await settle(); await sleep(100);
  assert.equal(orderDocs(h).length, 1); assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('webhook BEFORE verify: verify returns the same order (already), no second email', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  const raw = webhookBody('payment.captured', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw));
  await settle();
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  assert.equal(r.body.order_id, orderIdFor(rid)); assert.equal(r.body.already, true);
  await settle(); await sleep(100);
  assert.equal(orderDocs(h).length, 1); assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('verify BEFORE webhook: webhook is a no-op', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid);
  await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 499 });
  const raw = webhookBody('payment.captured', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw));
  await settle(); await sleep(100);
  assert.equal(orderDocs(h).length, 1); assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('webhook payment.authorized (auto-capture OFF): server captures then creates the order', async () => {
  const h = await boot();
  const rid = await h.createOrder(); const pay = h.razorpay.addPayment(rid, { status: 'authorized' });
  const raw = webhookBody('payment.authorized', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw));
  await settle();
  assert.equal(h.razorpay.state.captureCalls, 1);
  assert.equal(orderDocs(h).length, 1);
  await h.close();
});

test('webhook for a payment that is not ours (e.g. website): ignored, no order', async () => {
  const h = await boot();
  h.razorpay.state.orders.set('order_ForeignOrder01', { id: 'order_ForeignOrder01', amount: 10000, notes: {} });
  const pay = h.razorpay.addPayment('order_ForeignOrder01');
  const raw = webhookBody('payment.captured', pay);
  assert.equal((await h.post('/razorpay-webhook', raw, whHeaders(raw))).status, 200);
  await settle();
  assert.equal(orderDocs(h).length, 0); assert.equal(h.mailer.sent.length, 0);
  await h.close();
});

test('webhook from an OLD app build (no intent): minimal flagged order, later verify upgrades it + full email', async () => {
  const h = await boot();
  const rid = (await h.post('/create-order', { amount: 49900, product_name: 'Old Frame' })).body.order_id; // old build: no intent
  const pay = h.razorpay.addPayment(rid);
  const raw = webhookBody('payment.captured', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw));
  await settle();
  let doc = await h.store.getOrder(orderIdFor(rid));
  assert.equal(doc.needsReview, true);
  assert.equal(h.mailer.sent.length, 1);
  assert.match(h.mailer.sent[0].banners.join(' '), /NOT received/);
  const addr = { name: 'Old', phone: '8888888888', house: '2', area: 'x', city: 'y', pincode: '190001' };
  await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), product_name: 'Old Frame', amount: 499, quantity: 1, address: addr });
  await settle(); await sleep(100);
  doc = await h.store.getOrder(orderIdFor(rid));
  assert.equal(doc.needsReview, false); assert.equal(doc.address.name, 'Old');
  assert.equal(h.mailer.sent.length, 2); assert.equal(h.mailer.sent[1].address.name, 'Old');
  await h.close();
});

test('OLD app build normal path: server does NOT write an order doc (the app does), email sent once', async () => {
  const h = await boot();
  const rid = (await h.post('/create-order', { amount: 49900, product_name: 'Old Frame' })).body.order_id;
  const pay = h.razorpay.addPayment(rid);
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), product_name: 'Old Frame', amount: 499, quantity: 1, address: { name: 'Old' } });
  assert.equal(r.status, 200); assert.equal(r.body.success, true); assert.ok(r.body.referral);
  await settle();
  assert.equal(orderDocs(h).length, 0); assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

// ── payment-status (app recovery) ────────────────────────────────────────────
test('payment-status: paid at Razorpay but app never called verify => order created, then idempotent', async () => {
  const h = await boot();
  const rid = await h.createOrder(); h.razorpay.addPayment(rid);
  const a = await h.get(`/payment-status?razorpay_order_id=${rid}`);
  assert.equal(a.body.state, 'paid'); assert.equal(a.body.order_id, orderIdFor(rid));
  const b = await h.get(`/payment-status?razorpay_order_id=${rid}`);
  assert.equal(b.body.state, 'paid');
  await settle(); await sleep(100);
  assert.equal(orderDocs(h).length, 1); assert.equal(h.mailer.sent.length, 1);
  await h.close();
});

test('payment-status: never paid => not_paid; pending UPI => pending; garbage id => 400; API down => 503', async () => {
  const h = await boot();
  const rid = await h.createOrder();
  assert.equal((await h.get(`/payment-status?razorpay_order_id=${rid}`)).body.state, 'not_paid');
  h.razorpay.addPayment(rid, { status: 'created', created_at: Math.floor(Date.now() / 1000) - 30 });
  assert.equal((await h.get(`/payment-status?razorpay_order_id=${rid}`)).body.state, 'pending');
  assert.equal((await h.get('/payment-status?razorpay_order_id=nope')).status, 400);
  h.razorpay.state.apiDown = true;
  const down = await h.get(`/payment-status?razorpay_order_id=${rid}`);
  assert.equal(down.status, 503); assert.equal(down.body.retryable, true);
  await h.close();
});

test('payment-status: another user cannot read someone else\'s payment (uid mismatch => 403)', async () => {
  const ref = makeReferral(true);
  ref.authenticate = async (req) => { const a = req.get('authorization'); return a === 'Bearer owner' ? { uid: 'owner' } : a === 'Bearer other' ? { uid: 'other' } : null; };
  const h = await boot({ referral: ref });
  const rid = await h.createOrder(499, { _h: { Authorization: 'Bearer owner' } });
  h.razorpay.addPayment(rid);
  assert.equal((await h.get(`/payment-status?razorpay_order_id=${rid}`, { Authorization: 'Bearer other' })).status, 403);
  assert.equal((await h.get(`/payment-status?razorpay_order_id=${rid}`, { Authorization: 'Bearer owner' })).body.state, 'paid');
  await h.close();
});

// ── reconcile / monitoring ───────────────────────────────────────────────────
test('reconcile: captured payment the app never confirmed is recovered + owner alerted; foreign payments only alert', async () => {
  const h = await boot();
  const rid = await h.createOrder(); h.razorpay.addPayment(rid);
  h.razorpay.state.orders.set('order_ForeignOrder02', { id: 'order_ForeignOrder02', amount: 100, notes: {} });
  h.razorpay.addPayment('order_ForeignOrder02');
  const fresh = await h.createOrder(); h.razorpay.addPayment(fresh, { created_at: Math.floor(Date.now() / 1000) - 10 }); // inside grace window
  const stats = await h.service.reconcileRecent({ lookbackHours: 6, graceMin: 5 });
  await settle();
  assert.equal(stats.recovered, 1); assert.equal(stats.foreign, 1);
  assert.deepEqual(orderDocs(h), [orderIdFor(rid)]);
  assert.equal(h.mailer.alerts.length, 2);
  const again = await h.service.reconcileRecent({ lookbackHours: 6, graceMin: 5 });
  assert.equal(again.recovered, 0);
  assert.equal(h.mailer.alerts.length, 2, 'alerts are not repeated');
  await h.close();
});

// ── create-order / referral / COD ────────────────────────────────────────────
test('create-order: validates amount, stores intent, returns same shape as v10', async () => {
  const h = await boot();
  assert.equal((await h.post('/create-order', { amount: 50 })).status, 400);
  const r = await h.post('/create-order', { amount: 49900, product_name: 'F', intent: h.intent() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'currency', 'key_id', 'order_id', 'referral_discount', 'success']);
  const doc = await h.store.getPayment(r.body.order_id);
  assert.equal(doc.status, 'created'); assert.equal(doc.intent.order.product.name, 'Frame (12")');
  await h.close();
});

test('referral: discount reserved at create-order is settled exactly once even with verify + webhook', async () => {
  const ref = makeReferral(true);
  const h = await boot({ referral: ref });
  const rid = await h.createOrder(499, { use_referral: true, _h: { Authorization: 'Bearer good' } });
  const pay = h.razorpay.addPayment(rid);
  const raw = webhookBody('payment.captured', pay);
  await h.post('/razorpay-webhook', raw, whHeaders(raw));
  const r = await h.post('/verify-payment', { payment_id: pay.id, order_id: rid, signature: h.sign(rid, pay.id), amount: 449 }, { Authorization: 'Bearer good' });
  assert.equal(r.body.referral.redeemed, true);
  assert.equal(ref.calls.redeem.length, 1);
  await settle();
  const doc = await h.store.getOrder(orderIdFor(rid));
  assert.equal(doc.referralDiscount, 50);
  assert.equal(doc.totalAmount, 449, 'server applies the referral discount to the recovered order');
  assert.equal(h.mailer.sent[0].banners.length, 0, 'no false amount-mismatch warning');
  await h.close();
});

test('cod-order: idempotency key returns the same order and emails once', async () => {
  const h = await boot();
  const body = { product_name: 'Cup', amount: 300, quantity: 1, address: { name: 'A' }, client_key: 'abcd1234efgh' };
  const a = await h.post('/cod-order', body); const b = await h.post('/cod-order', body);
  assert.equal(a.body.order_id, b.body.order_id); assert.equal(b.body.duplicate, true);
  await settle();
  assert.equal(h.mailer.sent.length, 1);
  assert.equal((await h.post('/cod-order', { amount: 5 })).status, 400);
  await h.close();
});

test('health + root endpoints', async () => {
  const h = await boot();
  assert.equal((await h.get('/health')).body.ok, true);
  assert.match((await h.get('/')).body.status, /GiftKart Server/);
  await h.close();
});

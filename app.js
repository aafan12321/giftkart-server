'use strict';
const express = require('express');
const path = require('path');
const cors = require('cors');
const { createPaymentsService, safeEqualHex, hmacHex, withTimeout } = require('./payments/service');
const { isValidRzpOrderId, orderIdFor, safeNum } = require('./payments/ids');
const { rateLimit } = require('./payments/ratelimit');

const VERSION = 'v11';

function createApp({ razorpay, store, mailer, referral, config, logger = console }) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({
    limit: '10mb',
    // Razorpay signs the RAW body; keep it for the webhook route only.
    verify: (req, res, buf) => { if (req.originalUrl && req.originalUrl.startsWith('/razorpay-webhook')) req.rawBody = buf; },
  }));
  app.use(cors());

  const service = createPaymentsService({ razorpay, store, mailer, referral, config, logger });
  const limitWrite = rateLimit({ windowMs: 60000, max: 120 });
  const limitStatus = rateLimit({ windowMs: 60000, max: 300 });

  // ── Referral module (unchanged behaviour from v10) ────────────────────────
  if (referral.enabled) {
    app.use('/referral', referral.router);
    app.use('/admin/referral/api', referral.adminRouter);
  } else {
    app.get('/referral/health', (req, res) => res.status(503).json({ ok: false, referral: false, reason: 'FIREBASE_SERVICE_ACCOUNT is missing or invalid on the server' }));
    app.use('/referral', (req, res) => res.status(503).json({ success: false, error: 'referral_unavailable', message: 'Referral service is not configured.' }));
  }
  app.get('/admin/referral', (req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    res.sendFile(path.join(__dirname, 'admin', 'referral_admin.html'));
  });

  app.get('/', (req, res) => res.json({ status: `GiftKart Server ${VERSION} ✅`, referral: referral.enabled }));
  app.get('/health', (req, res) => res.json({
    ok: true, version: VERSION, uptimeSec: Math.round(process.uptime()),
    durableStore: !!store.durable, referral: !!referral.enabled,
    razorpayKeys: !!(config.razorpayKeyId && config.razorpayKeySecret),
    webhookSecret: !!config.webhookSecret, email: !!(config.fromEmail && config.notifyEmail),
  }));

  async function optionalAuth(req) {
    try { return referral.enabled && req.get('authorization') ? await referral.authenticate(req) : null; }
    catch (_) { return null; }
  }
  async function safe(fn, fallback) { try { return await fn(); } catch (e) { logger.error('❌', e && e.message); return fallback; } }

  // ── POST /create-order ────────────────────────────────────────────────────
  app.post('/create-order', limitWrite, async (req, res) => {
    let reservedUid = null;
    try {
      const { amount, product_name, currency = 'INR', use_referral, intent } = req.body;
      if (!amount || typeof amount !== 'number' || amount < 100)
        return res.status(400).json({ error: 'Invalid amount.' });

      let finalAmount = Math.round(amount);
      let referralDiscount = 0;
      let uid = null;
      if (use_referral === true) {
        if (!referral.enabled)
          return res.status(503).json({ error: 'referral_unavailable', message: 'Referral discounts are unavailable right now. Please try again later.' });
        const auth = await referral.authenticate(req);
        if (!auth)
          return res.status(401).json({ error: 'login_required', message: 'Please sign in to use your referral discount.' });
        try {
          const r = await referral.service.reserve(auth.uid, finalAmount / 100);
          referralDiscount = r.discount;
          reservedUid = auth.uid;
          uid = auth.uid;
          finalAmount -= referralDiscount * 100;
        } catch (e) {
          return referral.sendError(res, e);
        }
      } else {
        const auth = await optionalAuth(req);
        uid = auth ? auth.uid : null;
      }

      let order;
      try {
        order = await razorpay.orders.create({
          amount: finalAmount, currency,
          receipt: `receipt_${Date.now()}`,
          notes: { product_name: product_name || 'GiftKart Product', referral_discount: String(referralDiscount), app: 'giftkart-app' },
        });
        if (reservedUid) await referral.service.attachOrder(reservedUid, order.id);
      } catch (e) {
        if (reservedUid) await referral.service.release(reservedUid, null).catch(() => {});
        throw e;
      }

      // Durable intent, BEFORE the customer can pay. If this write fails we
      // still let the checkout proceed (and log loudly) - a customer must
      // never be blocked from paying because our database blinked.
      const intentOk = intent && typeof intent === 'object' && JSON.stringify(intent).length < 200000;
      await safe(() => service.recordOrderCreated({
        rzpOrder: order, uid, intent: intentOk ? intent : null,
        productName: product_name, referralDiscount, clientAmountPaise: Math.round(amount),
      }), null);

      res.json({
        success: true, order_id: order.id, amount: order.amount, currency: order.currency,
        key_id: config.razorpayKeyId, referral_discount: referralDiscount,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create order', details: error.message });
    }
  });

  // ── POST /verify-payment (idempotent; tolerant; never loses a paid order) ─
  app.post('/verify-payment', limitWrite, async (req, res) => {
    try {
      const b = req.body || {};
      const paymentId = typeof b.payment_id === 'string' ? b.payment_id.trim() : '';
      let rzpOrderId = typeof b.order_id === 'string' ? b.order_id.trim() : '';
      const signature = typeof b.signature === 'string' ? b.signature.trim() : '';
      if (!paymentId && !isValidRzpOrderId(rzpOrderId)) return res.status(400).json({ error: 'Missing required fields' });
      if (paymentId && !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return res.status(400).json({ error: 'Invalid payment id' });
      if (rzpOrderId && !isValidRzpOrderId(rzpOrderId)) rzpOrderId = ''; // empty/garbage from a UPI-intent edge case: recover from Razorpay

      const sigOk = !!(rzpOrderId && paymentId && signature && service.verifySignature(rzpOrderId, paymentId, signature));
      let payment = null; let apiErr = null;
      try {
        if (paymentId) {
          payment = await withTimeout(Promise.resolve(razorpay.payments.fetch(paymentId)), config.razorpayApiTimeoutMs || 8000, 'payments.fetch');
        } else {
          const t = await service.fetchPaymentTruth(rzpOrderId);
          payment = t.payment || null;
          if (!payment) return res.status(202).json({ success: false, pending: true, retryable: true });
        }
      } catch (e) { apiErr = e; }

      if (payment) {
        if (!rzpOrderId) rzpOrderId = payment.order_id;
        if (!isValidRzpOrderId(rzpOrderId) || payment.order_id !== rzpOrderId)
          return res.status(400).json({ success: false, error: 'Payment does not belong to this order.' });
        payment = await service.ensureCaptured(payment).catch(() => payment);
        if (payment.status === 'failed' || payment.status === 'refunded')
          return res.status(400).json({ success: false, error: 'Payment was not completed.' });
        if (payment.status !== 'captured') {
          if (!sigOk) return res.status(202).json({ success: false, pending: true, retryable: true });
          payment = { ...payment, unverified: true }; // valid signature, Razorpay status lagging
        } else if (signature && !sigOk) {
          logger.warn(JSON.stringify({ evt: 'signature_mismatch_but_captured', paymentId, rzpOrderId }));
        }
      } else {
        // Razorpay API unreachable / timed out.
        if (apiErr && (apiErr.statusCode === 400 || apiErr.statusCode === 404) && !sigOk)
          return res.status(400).json({ success: false, error: 'Payment not found.' });
        if (!sigOk) return res.status(503).json({ success: false, error: 'verification_unavailable', retryable: true });
        const stored = await safe(() => store.getPayment(rzpOrderId), null);
        payment = {
          id: paymentId, order_id: rzpOrderId, status: 'captured', unverified: true,
          amount: (stored && stored.amountPaise) || Math.round(safeNum(b.amount, 0) * 100),
        };
      }

      let fin;
      try {
        fin = await service.finalizePaid({ rzpOrderId, payment, source: 'verify', clientDetails: b });
      } catch (e) {
        // Storage is down. The payment is real: answer success, email directly.
        logger.error('❌ finalizePaid failed, answering from signature/API proof:', e && e.message);
        const orderId = orderIdFor(rzpOrderId);
        fin = { orderId, already: false, kind: null, persisted: false };
        setImmediate(() => mailer.sendOrderEmail({
          orderId, productName: b.product_name || 'GiftKart Product', amount: safeNum(payment.amount, 0) / 100,
          quantity: b.quantity || 1, address: b.address || {}, paymentMethod: 'Online Payment (Razorpay)',
          paymentId: payment.id, photoBase64: b.photo_base64 || null, customDetails: b.custom_details || null,
          products: Array.isArray(b.products) ? b.products : null, referralDiscount: 0,
          banners: ['Database was unavailable; this order was NOT saved on the server. Verify it exists in Firestore.'],
        }));
      }

      let referralResult = { redeemed: false, discount: 0 };
      if (fin.persisted !== false) {
        const auth = await optionalAuth(req);
        const uid = (auth && auth.uid) || fin.uid;
        referralResult = await safe(() => service.settleReferralOnce(rzpOrderId, uid, fin.orderId), referralResult);
        if (fin.kind === 'minimal') await safe(() => service.upgradeMinimalOrder(rzpOrderId, b), false);
        service.notifyLater(rzpOrderId, { clientDetails: b, photoBase64: b.photo_base64 || null });
      }

      logger.log(JSON.stringify({ evt: 'verify', rzpOrderId, paymentId: payment.id, orderId: fin.orderId, already: !!fin.already, sigOk }));
      res.json({ success: true, order_id: fin.orderId, payment_id: payment.id, referral: referralResult, already: !!fin.already });
    } catch (error) {
      logger.error('❌ verify-payment error:', error && error.message);
      res.status(500).json({ success: false, error: 'Verification error', retryable: true });
    }
  });

  // ── GET /payment-status (app recovery) ────────────────────────────────────
  app.get('/payment-status', limitStatus, async (req, res) => {
    const id = String(req.query.razorpay_order_id || '');
    if (!isValidRzpOrderId(id)) return res.status(400).json({ success: false, error: 'invalid_order_id' });
    try {
      const s = await service.paymentStatus(id);
      const auth = await optionalAuth(req);
      if (s.uid && auth && auth.uid && s.uid !== auth.uid) return res.status(403).json({ success: false, error: 'forbidden' });
      res.json({
        success: true, state: s.state, order_id: s.orderId || null,
        payment_id: s.paymentId || null, amount_paise: s.amountPaise || null,
      });
    } catch (e) {
      logger.error('❌ payment-status error:', e && e.message);
      res.status(503).json({ success: false, error: 'status_unavailable', retryable: true });
    }
  });

  // ── POST /razorpay-webhook ────────────────────────────────────────────────
  app.post('/razorpay-webhook', async (req, res) => {
    if (!config.webhookSecret) return res.status(503).json({ error: 'webhook_not_configured' });
    const sig = req.get('x-razorpay-signature');
    const raw = req.rawBody;
    if (!sig || !raw || !safeEqualHex(hmacHex(config.webhookSecret, raw), sig))
      return res.status(400).json({ error: 'invalid_signature' });
    const eventId = req.get('x-razorpay-event-id') || require('crypto').createHash('sha256').update(raw).digest('hex');
    try {
      const out = await service.handleWebhook(req.body, eventId);
      res.json({ ok: true, ...out });
    } catch (e) {
      logger.error('❌ webhook processing failed:', e && e.message);
      res.status(500).json({ ok: false }); // Razorpay retries non-2xx
    }
  });

  // ── POST /attach-photo (rare: only when the photo upload to Cloudinary failed)
  app.post('/attach-photo', limitWrite, async (req, res) => {
    const { razorpay_order_id: id, photo_base64: photo } = req.body || {};
    if (!isValidRzpOrderId(id) || typeof photo !== 'string' || photo.length < 100 || photo.length > 8000000)
      return res.status(400).json({ success: false, error: 'invalid_request' });
    try {
      const p = await store.getPayment(id);
      if (!p) return res.status(404).json({ success: false, error: 'unknown_order' });
      if (p.photoEmailed) return res.json({ success: true, duplicate: true });
      const ok = await mailer.sendPhoto({ orderId: p.orderId || orderIdFor(id), photoBase64: photo });
      if (ok) await store.updatePayment(id, { photoEmailed: true });
      res.json({ success: ok });
    } catch (e) { res.status(503).json({ success: false, retryable: true }); }
  });

  // ── POST /cod-order (v10 behaviour + optional idempotency key) ────────────
  app.post('/cod-order', limitWrite, async (req, res) => {
    try {
      const { product_name, amount, quantity, address, photo_base64, custom_details, products, use_referral, client_key } = req.body;
      if (!product_name || !amount) return res.status(400).json({ error: 'Missing required fields' });

      const key = typeof client_key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(client_key) ? client_key : null;
      if (key) {
        const prior = await safe(() => store.getCodKey(key), null);
        if (prior) return res.json({ success: true, order_id: prior.orderId, referral_discount: prior.referralDiscount || 0, amount_final: prior.finalAmount, duplicate: true });
      }

      const orderId = `GK${Date.now()}`;
      const subtotal = safeNum(amount, 0);
      let referralDiscount = 0;
      if (use_referral === true) {
        if (!referral.enabled)
          return res.status(503).json({ error: 'referral_unavailable', message: 'Referral discounts are unavailable right now. Please try again later.' });
        const auth = await referral.authenticate(req);
        if (!auth)
          return res.status(401).json({ error: 'login_required', message: 'Please sign in to use your referral discount.' });
        try {
          referralDiscount = (await referral.service.redeemCod(auth.uid, subtotal, orderId)).discount;
        } catch (e) { return referral.sendError(res, e); }
      } else if (referral.enabled) {
        try {
          const auth = await referral.authenticate(req);
          if (auth) await referral.service.markOrderCompleted(auth.uid);
        } catch (e) { logger.error('❌ referral mark failed:', e.message); }
      }

      const finalAmount = Math.max(1, subtotal - referralDiscount);
      if (key) await safe(() => store.setCodKey(key, { orderId, referralDiscount, finalAmount }), null);
      res.json({ success: true, order_id: orderId, referral_discount: referralDiscount, amount_final: finalAmount });
      setImmediate(() => mailer.sendOrderEmail({
        orderId, productName: product_name, amount: finalAmount, quantity: quantity || 1,
        address: address || {}, paymentMethod: 'Cash on Delivery', paymentId: null,
        photoBase64: photo_base64 || null, customDetails: custom_details || null,
        products: Array.isArray(products) ? products : null, referralDiscount, banners: [],
      }));
    } catch (error) {
      res.status(500).json({ error: 'COD order error', details: error.message });
    }
  });

  // ── POST /cancel-order (unchanged) ────────────────────────────────────────
  app.post('/cancel-order', limitWrite, async (req, res) => {
    try {
      const { order_id, product_name, amount, quantity, payment_method, order_date, address } = req.body;
      if (!order_id || !product_name) return res.status(400).json({ error: 'Missing required fields' });
      res.json({ success: true, order_id });
      setImmediate(() => mailer.sendCancellation({
        orderId: order_id, productName: product_name, amount: amount || 0, quantity: quantity || 1,
        paymentMethod: payment_method || 'N/A', orderDate: order_date || 'N/A', address: address || {},
      }));
    } catch (error) {
      res.status(500).json({ error: 'Cancellation error', details: error.message });
    }
  });

  // ── Background jobs: email retry + orphan reconciliation ──────────────────
  let timers = []; let busy = false;
  function startJobs() {
    if (config.disableJobs) return;
    const every = Math.max(1, config.reconcileIntervalMin || 5) * 60000;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const r = await service.reconcileRecent({ lookbackHours: config.reconcileLookbackHours || 6, graceMin: config.orphanGraceMin || 5 });
        const n = await service.retryUnnotified();
        if (r.recovered || r.foreign || r.errors || n) logger.log(JSON.stringify({ evt: 'reconcile', ...r, emailsRetried: n }));
      } catch (e) { logger.error('❌ reconcile job failed:', e && e.message); }
      finally { busy = false; }
    };
    timers.push(setTimeout(tick, 30000), setInterval(tick, every));
    timers.forEach((t) => t.unref && t.unref());
  }
  function stopJobs() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = []; }

  return { app, service, startJobs, stopJobs };
}

module.exports = { createApp, VERSION };

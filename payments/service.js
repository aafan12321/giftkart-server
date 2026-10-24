'use strict';
const crypto = require('crypto');
const { orderIdFor, isValidRzpOrderId, safeNum, sanitizeForFirestore } = require('./ids');

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label || 'operation'} timed out`), { code: 'ETIMEDOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function safeEqualHex(a, b) {
  try {
    const x = Buffer.from(String(a), 'utf8'); const y = Buffer.from(String(b), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (_) { return false; }
}

function createPaymentsService({ razorpay, store, mailer, referral, config = {}, logger = console, now = () => Date.now() }) {
  const apiTimeoutMs = config.razorpayApiTimeoutMs || 8000;

  const rz = (p, label) => withTimeout(Promise.resolve(p), apiTimeoutMs, label);
  const isNotFound = (e) => e && (e.statusCode === 400 || e.statusCode === 404);

  function verifySignature(rzpOrderId, paymentId, signature) {
    if (!rzpOrderId || !paymentId || !signature || !config.razorpayKeySecret) return false;
    return safeEqualHex(hmacHex(config.razorpayKeySecret, `${rzpOrderId}|${paymentId}`), signature);
  }

  // ── Intent recorded at /create-order (before the customer can pay) ────────
  async function recordOrderCreated({ rzpOrder, uid, intent, productName, referralDiscount, clientAmountPaise }) {
    await store.setPayment(rzpOrder.id, {
      razorpayOrderId: rzpOrder.id,
      amountPaise: rzpOrder.amount,
      currency: rzpOrder.currency,
      status: 'created',
      createdAtMs: now(),
      uid: uid || null,
      productName: productName || null,
      referralDiscount: referralDiscount || 0,
      clientAmountPaise: clientAmountPaise || null,
      intent: intent ? sanitizeForFirestore(intent) : null,
    });
  }

  async function isOurOrder(rzpOrderId) {
    if (await store.getPayment(rzpOrderId)) return true;
    try {
      const o = await rz(razorpay.orders.fetch(rzpOrderId), 'orders.fetch');
      const n = (o && o.notes) || {};
      return n.app === 'giftkart-app' || n.referral_discount !== undefined;
    } catch (_) { return false; }
  }

  // ── Razorpay truth ────────────────────────────────────────────────────────
  async function ensureCaptured(payment) {
    if (payment && payment.status === 'authorized') {
      try {
        return await rz(razorpay.payments.capture(payment.id, payment.amount, payment.currency || 'INR'), 'capture');
      } catch (e) {
        // Auto-capture may have won the race; re-read the truth.
        return await rz(razorpay.payments.fetch(payment.id), 'payments.fetch');
      }
    }
    return payment;
  }

  async function fetchPaymentTruth(rzpOrderId, { cancelled = false } = {}) {
    const res = await rz(razorpay.orders.fetchPayments(rzpOrderId), 'orders.fetchPayments');
    const items = (res && res.items) || [];
    const captured = items.find((p) => p.status === 'captured');
    if (captured) return { state: 'paid', payment: captured };
    const auth = items.find((p) => p.status === 'authorized');
    if (auth) {
      const p = await ensureCaptured(auth);
      return p && p.status === 'captured' ? { state: 'paid', payment: p } : { state: 'pending', payment: p };
    }
    const nowSec = now() / 1000;
    // A UPI attempt the customer abandoned stays 'created' at Razorpay for a long time.
    // Only treat a very fresh one as 'still in progress', and not at all when the app
    // says the customer cancelled (a real payment shows up as authorized/captured).
    const pendingSec = cancelled ? 0 : 60;
    if (pendingSec > 0 && items.some((p) => p.status === 'created' && nowSec - p.created_at < pendingSec)) return { state: 'pending' };
    return { state: 'not_paid', attempts: items.length, failed: items.some((p) => p.status === 'failed') };
  }

  // ── Order documents ───────────────────────────────────────────────────────
  function buildOrderFromIntent(intent, ex, ctx) {
    const o = sanitizeForFirestore(intent.order) || {};
    const data = {
      ...o,
      orderId: ctx.orderId,
      razorpayOrderId: ctx.rzpOrderId,
      paymentId: ctx.payment.id,
      paymentMethod: o.paymentMethod || 'Online Payment',
      status: o.status || 'Confirmed',
      paymentVerified: !ctx.payment.unverified,
      paymentSource: ctx.source,
      amountPaidPaise: ctx.amountPaid,
      orderDate: o.orderDate || ctx.nowIso,
      createdAt: store.serverTime(),
    };
    // The app builds the intent BEFORE the server decides the referral discount.
    // The server is the authority, so apply it here (never combined with COD advance).
    const refDiscount = safeNum(ex.referralDiscount, 0);
    if (refDiscount > 0 && !(safeNum(o.codAdvance, 0) > 0)) {
      data.referralDiscount = refDiscount;
      data.totalAmount = Math.max(0, safeNum(o.totalAmount, 0) - refDiscount);
    }
    if (ctx.flags.length) { data.needsReview = true; data.reviewReason = ctx.flags.join('; '); }
    return data;
  }

  function buildMinimalOrder(ex, ctx) {
    const rupees = ctx.amountPaid / 100;
    const phone = String(ctx.payment.contact || '').replace(/\D/g, '').slice(-10);
    return {
      orderId: ctx.orderId,
      razorpayOrderId: ctx.rzpOrderId,
      paymentId: ctx.payment.id,
      product: { name: ex.productName || 'GiftKart Product', price: rupees, imageUrl: '' },
      quantity: 1,
      totalAmount: rupees,
      address: { name: 'Contact via Razorpay number', phone, house: '', area: '', city: '', pincode: '' },
      paymentMethod: 'Online Payment',
      status: 'Confirmed',
      paymentVerified: true,
      paymentSource: ctx.source,
      amountPaidPaise: ctx.amountPaid,
      needsReview: true,
      reviewReason: 'Payment captured but the app never sent order details. Contact the customer (Razorpay contact) and confirm what they ordered.',
      customerContact: ctx.payment.contact || null,
      customerEmail: ctx.payment.email || null,
      orderDate: ctx.nowIso,
      createdAt: store.serverTime(),
    };
  }

  // THE idempotent heart: any number of calls (verify, webhook, status poll,
  // reconcile - in any order, concurrently) produce exactly one paid record,
  // one order id and at most one order document.
  async function finalizePaid({ rzpOrderId, payment, source, clientDetails = null }) {
    const orderId = orderIdFor(rzpOrderId);
    const nowIso = new Date(now()).toISOString();
    return store.transactPayment(rzpOrderId, orderId, (existing) => {
      const ex = existing || {};
      if (ex.status === 'paid') {
        return { result: { orderId: ex.orderId || orderId, already: true, kind: ex.orderDocKind || null, uid: ex.uid || null, flags: ex.flags || [] } };
      }
      const amountPaid = safeNum(payment.amount, ex.amountPaise || 0);
      const flags = [];
      const claimed = clientDetails ? Math.round(safeNum(clientDetails.amount, 0) * 100) : 0;
      if (claimed > 0 && Math.abs(claimed - amountPaid) > 100) {
        flags.push(`Amount mismatch: app claimed ₹${claimed / 100} but Razorpay captured ₹${amountPaid / 100}`);
      }
      const expected = safeNum(ex.intent && ex.intent.expectedPaidRupees, 0) - safeNum(ex.referralDiscount, 0);
      if (expected > 0 && Math.abs(expected * 100 - amountPaid) > 100) {
        flags.push(`Amount mismatch: order expected ₹${expected} but Razorpay captured ₹${amountPaid / 100}`);
      }
      if (payment.unverified) flags.push('Razorpay API was unreachable; accepted on a valid signature. Please confirm in the Razorpay dashboard.');

      const ctx = { orderId, rzpOrderId, payment, source, amountPaid, flags, nowIso };
      const patch = {
        status: 'paid', paymentId: payment.id, amountPaidPaise: amountPaid, paidAtMs: now(),
        orderId, source, method: payment.method || null, contact: payment.contact || null,
        payerEmail: payment.email || null, apiConfirmed: !payment.unverified,
        flags, emailPending: true, updatedAtMs: now(),
      };
      let order = null;
      if (ex.intent && ex.intent.order) {
        patch.orderDocKind = 'intent';
        order = { id: orderId, mode: 'merge', data: buildOrderFromIntent(ex.intent, ex, ctx) };
      } else if (source !== 'verify') {
        patch.orderDocKind = 'minimal';
        order = { id: orderId, mode: 'create-if-absent', data: buildMinimalOrder(ex, ctx) };
      } else {
        patch.orderDocKind = 'client'; // legacy app build: it writes its own order document
      }
      return { payment: patch, order, result: { orderId, already: false, kind: patch.orderDocKind, uid: ex.uid || null, flags } };
    });
  }

  async function upgradeMinimalOrder(rzpOrderId, cd) {
    const p = await store.getPayment(rzpOrderId);
    if (!p || p.orderDocKind !== 'minimal' || !cd) return false;
    const qty = Math.max(1, Math.round(safeNum(cd.quantity, 1)));
    const total = safeNum(cd.amount, p.amountPaidPaise / 100);
    const data = sanitizeForFirestore({
      product: { name: cd.product_name || p.productName || 'GiftKart Product', price: Math.round(total / qty), imageUrl: '' },
      quantity: qty, totalAmount: total, address: cd.address || {},
      customDetails: cd.custom_details || null,
      ...(Array.isArray(cd.products) && cd.products.length ? { products: cd.products } : {}),
      needsReview: false, reviewReason: null,
    });
    await store.mergeOrder(p.orderId || orderIdFor(rzpOrderId), data);
    await store.updatePayment(rzpOrderId, { orderDocKind: 'minimal+client' });
    return true;
  }

  // ── Referral (once per payment, even if verify AND webhook both run) ──────
  async function settleReferralOnce(rzpOrderId, uid, orderId) {
    const empty = { redeemed: false, discount: 0 };
    if (!referral || !referral.enabled || !uid) return empty;
    const p = await store.getPayment(rzpOrderId);
    if (p && p.referralSettled) return p.referralResult || empty;
    try {
      let result = empty;
      const r = await referral.service.redeem(uid, rzpOrderId, orderId);
      if (r && r.redeemed) result = { redeemed: true, discount: r.discount };
      else await referral.service.markOrderCompleted(uid);
      await store.updatePayment(rzpOrderId, { referralSettled: true, referralResult: result });
      return result;
    } catch (e) {
      logger.error('❌ referral settle failed:', e && e.message);
      return empty; // never break the customer's order; retried on next call
    }
  }

  // ── Owner notification: exactly once per kind, retried if it fails ────────
  function buildEmailData(p, intent, cd, photoBase64, kind) {
    const o = intent ? intent.order : null;
    let productName = o ? ((o.product && o.product.name) || p.productName) : ((cd && cd.product_name) || p.productName || 'GiftKart Product');
    if (o && safeNum(o.codAdvance, 0) > 0) {
      productName += ` — COD ADVANCE ₹${o.codAdvance} PAID, ₹${safeNum(o.balanceAmount, 0)} TO COLLECT ON DELIVERY`;
    }
    const banners = [...(p.flags || [])];
    if (kind === 'minimal') banners.push('Order details were NOT received from the app. Payment was captured by Razorpay; contact the customer on the Razorpay number below and confirm the order.');
    return {
      orderId: p.orderId,
      productName,
      amount: safeNum(p.amountPaidPaise, 0) / 100,
      quantity: o ? o.quantity : (cd && cd.quantity) || 1,
      address: o ? o.address : (cd && cd.address) || {},
      paymentMethod: 'Online Payment (Razorpay)',
      paymentId: p.paymentId,
      photoBase64: photoBase64 || null,
      customDetails: o ? (o.customDetails || (o.product && o.product.customDetails) || null) : (cd && cd.custom_details) || null,
      products: o ? (Array.isArray(o.products) ? o.products : null) : (cd && Array.isArray(cd.products) ? cd.products : null),
      referralDiscount: safeNum(p.referralDiscount, 0),
      banners,
      contact: kind === 'minimal' || (p.flags && p.flags.length) ? p.contact : null,
      email: kind === 'minimal' ? p.payerEmail : null,
    };
  }

  async function notify(rzpOrderId, { clientDetails = null, photoBase64 = null } = {}) {
    const p = await store.getPayment(rzpOrderId);
    if (!p || p.status !== 'paid') return false;
    const intent = p.intent && p.intent.order ? p.intent : null;
    const kind = intent || clientDetails ? 'full' : 'minimal';
    if (p.emailFullSent) return true;
    if (kind === 'minimal' && p.emailMinimalSent) return true;
    if (!(await store.claimNotify(rzpOrderId, kind, 120000))) return false;
    const ok = await mailer.sendOrderEmail(buildEmailData(p, intent, clientDetails, photoBase64, kind));
    await store.updatePayment(rzpOrderId, ok
      ? (kind === 'full' ? { emailFullSent: true, emailPending: false, emailError: null } : { emailMinimalSent: true, emailPending: false, emailError: null })
      : { emailAttempts: (p.emailAttempts || 0) + 1, emailError: 'send_failed' });
    return ok;
  }

  function notifyLater(rzpOrderId, opts) {
    setImmediate(() => notify(rzpOrderId, opts).catch((e) => logger.error('❌ notify failed:', e && e.message)));
  }

  // Paid per Razorpay (webhook / status / reconcile): finish everything.
  async function handlePaid(payment, source) {
    const p = await ensureCaptured(payment);
    if (!p || p.status !== 'captured') return { pending: true };
    const rzpOrderId = p.order_id;
    const fin = await finalizePaid({ rzpOrderId, payment: p, source });
    const ref = await settleReferralOnce(rzpOrderId, fin.uid, fin.orderId);
    notifyLater(rzpOrderId);
    logger.log(JSON.stringify({ evt: 'paid', source, rzpOrderId, paymentId: p.id, orderId: fin.orderId, already: fin.already, kind: fin.kind }));
    return { ...fin, referral: ref };
  }

  async function paymentStatus(rzpOrderId, opts = {}) {
    if (!isValidRzpOrderId(rzpOrderId)) return { state: 'unknown' };
    const p = await store.getPayment(rzpOrderId);
    if (p && p.status === 'paid') {
      return { state: 'paid', orderId: p.orderId || orderIdFor(rzpOrderId), paymentId: p.paymentId, amountPaise: p.amountPaidPaise, uid: p.uid || null };
    }
    let truth;
    try { truth = await fetchPaymentTruth(rzpOrderId, opts); }
    catch (e) { if (isNotFound(e)) return { state: 'unknown' }; throw e; }
    if (truth.state === 'paid') {
      if (!p && !(await isOurOrder(rzpOrderId))) return { state: 'unknown' };
      const r = await handlePaid(truth.payment, 'status');
      if (r.pending) return { state: 'pending' };
      return { state: 'paid', orderId: r.orderId, paymentId: truth.payment.id, amountPaise: truth.payment.amount, uid: r.uid || null };
    }
    return { state: truth.state === 'pending' ? 'pending' : 'not_paid', uid: p ? p.uid || null : null };
  }

  async function recordFailure(payment) {
    if (!payment || !payment.order_id) return;
    const p = await store.getPayment(payment.order_id);
    if (!p || p.status === 'paid') return;
    await store.updatePayment(payment.order_id, {
      lastFailure: { paymentId: payment.id, code: payment.error_code || null, reason: payment.error_description || null, atMs: now() },
    });
  }

  // ── Webhook ───────────────────────────────────────────────────────────────
  async function handleWebhook(event, eventId) {
    const ev = await store.addEvent(eventId, { event: event.event, payload: sanitizeForFirestore(event.payload) });
    if (!ev.isNew && ev.status === 'processed') return { duplicate: true };
    const pay = event.payload && event.payload.payment && event.payload.payment.entity;
    switch (event.event) {
      case 'payment.captured':
      case 'payment.authorized':
      case 'order.paid':
        if (pay && pay.order_id && (await isOurOrder(pay.order_id))) await handlePaid(pay, 'webhook');
        break;
      case 'payment.failed':
        await recordFailure(pay);
        break;
      default: break;
    }
    await store.setEventStatus(eventId, 'processed');
    return { processed: true };
  }

  // ── Self-healing: captured payments that never became orders ──────────────
  async function reconcileRecent({ lookbackHours = 6, graceMin = 5 } = {}) {
    const stats = { checked: 0, recovered: 0, foreign: 0, errors: 0 };
    const to = Math.floor(now() / 1000);
    const from = to - lookbackHours * 3600;
    for (let skip = 0; skip < 1000; skip += 100) {
      const r = await rz(razorpay.payments.all({ from, to, count: 100, skip }), 'payments.all');
      const items = (r && r.items) || [];
      for (const p of items) {
        if (!p.order_id || !['captured', 'authorized'].includes(p.status)) continue;
        if (to - p.created_at < graceMin * 60) continue; // give the app its chance first
        stats.checked += 1;
        try {
          const doc = await store.getPayment(p.order_id);
          if (doc && doc.status === 'paid') continue;
          if (!doc && !(await isOurOrder(p.order_id))) {
            stats.foreign += 1;
            const a = await store.addEvent(`alert_${p.id}`, { kind: 'foreign_payment', paymentId: p.id });
            if (a.isNew) await mailer.sendAlert('Captured payment not created by the app', `<p>Payment <b>${p.id}</b> (₹${p.amount / 100}, ${p.contact || 'no contact'}) was captured but was not created through the app server. No order was created. Check the Razorpay dashboard.</p>`);
            continue;
          }
          const res = await handlePaid(p, 'reconcile');
          if (res && !res.pending && !res.already) {
            stats.recovered += 1;
            await mailer.sendAlert('Recovered a paid order the app never confirmed',
              `<p>Razorpay captured <b>₹${p.amount / 100}</b> (payment <b>${p.id}</b>, ${p.contact || 'no contact'}) but the app never confirmed it. The order <b>${res.orderId}</b> was created automatically (${res.kind === 'intent' ? 'full details recovered' : 'details missing - please contact the customer'}).</p>`);
          }
        } catch (e) { stats.errors += 1; logger.error('❌ reconcile item failed:', p.id, e && e.message); }
      }
      if (items.length < 100) break;
    }
    return stats;
  }

  async function retryUnnotified() {
    const list = await store.listPendingEmail(25);
    let n = 0;
    for (const { id, data } of list) {
      if (now() - (data.paidAtMs || 0) < 120000) continue;
      if (await notify(id).catch(() => false)) n += 1;
    }
    return n;
  }

  return {
    verifySignature, recordOrderCreated, isOurOrder, fetchPaymentTruth, ensureCaptured,
    finalizePaid, upgradeMinimalOrder, settleReferralOnce, notify, notifyLater, handlePaid,
    paymentStatus, handleWebhook, reconcileRecent, retryUnnotified, withTimeout, hmacHex, safeEqualHex,
  };
}

module.exports = { createPaymentsService, withTimeout, hmacHex, safeEqualHex };

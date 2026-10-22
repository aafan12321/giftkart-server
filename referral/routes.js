'use strict';
const express = require('express');
const { ReferralError } = require('./service');
const { hashKey, clientIp, ipLimiter } = require('./util');

function ctxFrom(req) {
  const dev = (req.get('x-device-id') || '').slice(0, 64);
  const ip = clientIp(req);
  return {
    deviceHash: /^[A-Za-z0-9-]{8,64}$/.test(dev) ? hashKey(`dev:${dev}`) : null,
    ipHash: ip ? hashKey(`ip:${ip}`) : null,
  };
}

function sendError(res, e) {
  if (e instanceof ReferralError) {
    const body = { success: false, error: e.code, message: e.message };
    if (e.retryAfterSec) body.retryAfterSec = e.retryAfterSec;
    if (e.minOrderValue != null) body.minOrderValue = e.minOrderValue;
    return res.status(e.status).json(body);
  }
  console.error('referral error:', e && e.message);
  return res.status(500).json({ success: false, error: 'server_error', message: 'Something went wrong. Please try again.' });
}

// Verifies the Firebase ID token and makes sure the referral profile exists.
// Returns { uid, ctx } or null when the request is unauthenticated.
function createAuthenticator({ verifyToken, getAccountCreatedAt, service }) {
  return async function authenticate(req) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return null;
    let decoded;
    try { decoded = await verifyToken(m[1]); } catch (_) { return null; }
    const ctx = ctxFrom(req);
    await service.ensureUser(decoded.uid, {
      email: decoded.email, name: decoded.name, deviceHash: ctx.deviceHash, ipHash: ctx.ipHash,
      accountCreatedAt: () => getAccountCreatedAt(decoded.uid),
    });
    return { uid: decoded.uid, ctx };
  };
}

function createReferralRouter({ service, authenticate }) {
  const router = express.Router();
  router.use(ipLimiter(90, 60000));

  // Public, no login: open https://<server>/referral/health to see if the service is alive.
  router.get('/health', async (_req, res) => {
    try {
      const cfg = await service.getConfig();
      res.json({ ok: true, referral: true, firestore: true, enabled: cfg.enabled, discountAmount: cfg.discountAmount });
    } catch (e) {
      res.status(500).json({ ok: false, referral: true, firestore: false, error: e.message });
    }
  });

  const handler = (fn) => async (req, res) => {
    try {
      const auth = await authenticate(req);
      if (!auth) return res.status(401).json({ success: false, error: 'login_required', message: 'Please sign in first.' });
      await fn(req, res, auth);
    } catch (e) { sendError(res, e); }
  };

  router.post('/me', handler(async (req, res, a) => {
    res.json({ success: true, ...(await service.overview(a.uid)) });
  }));

  router.post('/apply', handler(async (req, res, a) => {
    const r = await service.applyCode(a.uid, req.body && req.body.code, a.ctx);
    res.json({ success: true, ...r, ...(await service.overview(a.uid)) });
  }));

  router.post('/quote', handler(async (req, res, a) => {
    const sub = Number(req.body && req.body.subtotal);
    res.json({ success: true, ...(await service.quote(a.uid, sub)) });
  }));

  router.post('/release', handler(async (req, res, a) => {
    const id = String((req.body && req.body.razorpay_order_id) || '').slice(0, 64);
    res.json({ success: true, ...(await service.release(a.uid, id || null)) });
  }));

  return router;
}

module.exports = { createReferralRouter, createAuthenticator, sendError, ctxFrom };

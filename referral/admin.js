'use strict';
const express = require('express');
const crypto = require('crypto');
const { ipLimiter } = require('./util');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// CSV cell: quote, and neutralise spreadsheet formulas (=,+,-,@) from user-supplied text.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const iso = (t) => (t ? new Date(t).toISOString() : '');

function createAdminRouter({ service, adminKey }) {
  const router = express.Router();
  router.use(ipLimiter(60, 60000));
  router.use(express.json({ limit: '20kb' }));

  router.use((req, res, next) => {
    if (!adminKey) return res.status(503).json({ error: 'admin_disabled', message: 'Set ADMIN_API_KEY to enable admin APIs.' });
    const given = req.get('x-admin-key') || '';
    if (!crypto.timingSafeEqual(sha(given), sha(adminKey))) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { console.error('admin error:', e.message); res.status(500).json({ error: 'server_error' }); }
  };

  router.get('/config', wrap(async (_req, res) => res.json(await service.getConfig())));
  router.put('/config', wrap(async (req, res) => res.json(await service.setConfig(req.body || {}))));
  router.get('/analytics', wrap(async (_req, res) => res.json(await service.analytics())));
  router.get('/flags', wrap(async (_req, res) => res.json(await service.listFlags())));

  router.get('/referrals', wrap(async (req, res) => {
    res.json(await service.listReferrals({ search: req.query.search, status: req.query.status }));
  }));

  router.get('/referrals.csv', wrap(async (req, res) => {
    const rows = await service.listReferrals({ search: req.query.search, status: req.query.status });
    const head = ['referrer_name', 'referrer_email', 'referrer_code', 'referred_name', 'referred_email', 'status',
      'applied_at', 'redeemed_at', 'order_id', 'amount_saved_inr', 'referrer_reward_inr'];
    const lines = [head.join(',')].concat(rows.map((r) => [
      r.referrerName, r.referrerEmail, r.code, r.referredName, r.referredEmail, r.status,
      iso(r.appliedAt), iso(r.redeemedAt), r.orderId, r.amountSaved, r.referrerReward,
    ].map(csvCell).join(',')));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="referrals.csv"' });
    res.send(lines.join('\n'));
  }));

  router.post('/block-user', wrap(async (req, res) => {
    const ok = await service.blockUser(String(req.body.uid || ''), req.body.blocked !== false);
    res.status(ok ? 200 : 404).json({ ok });
  }));
  router.post('/block-code', wrap(async (req, res) => {
    const ok = await service.blockCode(String(req.body.code || ''), req.body.blocked !== false);
    res.status(ok ? 200 : 404).json({ ok });
  }));

  return router;
}

module.exports = { createAdminRouter, csvCell };

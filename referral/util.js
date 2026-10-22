'use strict';
const crypto = require('crypto');

// No 0/O/1/I/L so codes stay readable when typed from a screenshot.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^GIFT-[${ALPHABET}]{6}$`);

function generateCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `GIFT-${s}`;
}

// Accepts "gift-ab12cd", "GIFTAB12CD", "ab12cd"; returns canonical code or null.
function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let c = raw.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 10 && c.startsWith('GIFT')) c = c.slice(4);
  if (c.length !== 6) return null;
  const code = `GIFT-${c}`;
  return CODE_RE.test(code) ? code : null;
}

function hashKey(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32);
}

// Strip control chars + cap length before anything user-supplied is stored.
function clean(v, max = 120) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

// Only a header set by YOUR proxy counts as a client IP. Behind Cloudflare/Railway,
// req.ip is the proxy's address shared by every user, so it must never be used for
// per-user lockouts (one bad actor would lock everyone out).
function clientIp(req) {
  return req.get('x-client-ip') || req.get('cf-connecting-ip') || '';
}
function limiterKey(req) {
  return clientIp(req) || (req.get('authorization') || '').slice(-24) || req.ip || 'unknown';
}

// Tiny fixed-window limiter (per IP) for all referral/admin endpoints.
function ipLimiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const k = limiterKey(req);
    const t = Date.now();
    const h = hits.get(k);
    if (!h || t - h.s > windowMs) hits.set(k, { s: t, n: 1 });
    else if (++h.n > max) {
      return res.status(429).json({ success: false, error: 'rate_limited', message: 'Too many requests. Please slow down.' });
    }
    if (hits.size > 5000) for (const [kk, v] of hits) if (t - v.s > windowMs) hits.delete(kk);
    next();
  };
}

module.exports = { ALPHABET, generateCode, normalizeCode, hashKey, clean, clientIp, ipLimiter };

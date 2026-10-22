'use strict';
// Tiny fixed-window limiter. Limits are deliberately generous: many customers
// share one carrier-grade-NAT IP, so this only stops floods, not real users.
function rateLimit({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();
  return (req, res, next) => {
    const ip = req.get('cf-connecting-ip') || req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.set(ip, h); }
    h.n += 1;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.start + windowMs - now) / 1000)));
      return res.status(429).json({ success: false, error: 'rate_limited', retryable: true });
    }
    next();
  };
}
module.exports = { rateLimit };

'use strict';
// Shared helpers. orderIdFor() MUST stay identical to PaymentIds.orderIdFor()
// in the Flutter app (lib/payment_ledger.dart): 'GK' + razorpay order id
// without its 'order_' prefix. Deterministic => idempotent everywhere.

const RZP_ORDER_RE = /^order_[A-Za-z0-9]{6,32}$/;

function isValidRzpOrderId(s) {
  return typeof s === 'string' && RZP_ORDER_RE.test(s);
}

function orderIdFor(rzpOrderId) {
  if (!isValidRzpOrderId(rzpOrderId)) throw new Error('invalid_razorpay_order_id');
  return 'GK' + rzpOrderId.slice('order_'.length);
}

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeNum(value, fallback = 0) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

const ALLOWED_WIDTHS = [200, 400, 800, 1200];
// Same transformation strings the app uses (Cloudinary strict-mode whitelist).
function optimizeCloudinary(url, width = 800) {
  if (typeof url !== 'string') return url;
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/);
  if (!m) return url;
  const rest = m[2];
  if (!/^v\d+\//.test(rest)) return url; // already transformed / unknown shape
  const w = ALLOWED_WIDTHS.find((x) => x >= width) || ALLOWED_WIDTHS[ALLOWED_WIDTHS.length - 1];
  return `${m[1]}f_auto,q_auto:eco,c_limit,w_${w}/${rest}`;
}

// Firestore-safe deep copy: drops undefined/functions, base64 blobs and huge
// strings, non-finite numbers. Keeps documents far below the 1 MiB limit.
function sanitizeForFirestore(value, depth = 0) {
  if (depth > 8) return null;
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 20000 ? '[omitted: too large]' : value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForFirestore(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!k || k.includes('/') || k.startsWith('__')) continue;
      if (k === 'photoBase64' || k === 'photo_base64') continue;
      const s = sanitizeForFirestore(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

module.exports = {
  isValidRzpOrderId, orderIdFor, esc, safeNum, optimizeCloudinary,
  sanitizeForFirestore, ALLOWED_WIDTHS,
};

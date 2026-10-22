'use strict';
const { generateCode, normalizeCode, clean } = require('./util');

const USERS = 'referral_users';     // one doc per uid: own code + first-order state
const CODES = 'referral_codes';     // doc id = code → uniqueness guarantee
const REFS = 'referrals';           // doc id = referred uid → "one code, ever"
const RATE = 'referral_rate';       // invalid-attempt counters (uid / device / ip)
const DEVICES = 'referral_devices'; // device → uids seen
const FLAGS = 'referral_flags';     // suspicious-pattern log for admins
const CFG_COL = 'settings';
const CFG_ID = 'referral_config';

const ERRORS = {
  feature_disabled:   [403, 'Referral offers are not available right now.'],
  invalid_code:       [404, 'That code is not valid. Please check and try again.'],
  own_code:           [400, "You can't use your own referral code."],
  already_applied:    [409, "You've already applied a referral code."],
  already_used:       [409, "You've already used your referral discount."],
  not_first_order:    [409, 'Referral codes only work before your first order.'],
  not_eligible:       [403, "This code can't be used on your account."],
  owner_inactive:     [403, 'This code is no longer active.'],
  blocked:            [403, "This account isn't eligible for referral offers."],
  rate_limited:       [429, 'Too many attempts. Please try again later.'],
  no_code:            [409, 'No referral code is applied to your account.'],
  code_expired:       [409, 'Your referral code has expired.'],
  min_order:          [409, 'Your order is below the minimum value for the referral discount.'],
  reservation_pending:[409, 'Your referral discount is attached to a payment in progress. Try again in a few minutes.'],
  not_ready:          [409, 'Please open Refer & Earn once to set up your account.'],
};

class ReferralError extends Error {
  constructor(code, extra = {}) {
    const [status, message] = ERRORS[code] || [400, 'Referral error'];
    super(message);
    this.code = code; this.status = status; Object.assign(this, extra);
  }
}
const err = (code, extra) => new ReferralError(code, extra);

const int = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function normalizeConfig(raw = {}) {
  const after = Number(raw.eligibleAccountsCreatedAfter);
  return {
    enabled: bool(raw.enabled, true),
    discountAmount: int(raw.discountAmount, 50, 1, 5000),
    minOrderValue: int(raw.minOrderValue, 0, 0, 100000),
    referrerRewardEnabled: bool(raw.referrerRewardEnabled, false),
    referrerRewardAmount: int(raw.referrerRewardAmount, 0, 0, 5000),
    eligibleAccountsCreatedAfter: Number.isFinite(after) && raw.eligibleAccountsCreatedAfter != null ? after : null,
    applicationExpiryDays: int(raw.applicationExpiryDays, 0, 0, 365),
    reservationTtlMinutes: int(raw.reservationTtlMinutes, 10, 1, 120),
    maxInvalidAttempts: int(raw.maxInvalidAttempts, 5, 1, 50),
    lockoutMinutes: int(raw.lockoutMinutes, 15, 1, 1440),
    maxAccountsPerDevice: int(raw.maxAccountsPerDevice, 3, 1, 50),
    blockSameDevice: bool(raw.blockSameDevice, true),
  };
}

function createService({ store, now = Date.now, paymentChecker = null, logger = console }) {
  async function getConfig() {
    return normalizeConfig((await store.get(CFG_COL, CFG_ID)) || {});
  }

  async function setConfig(patch = {}) {
    const cur = (await store.get(CFG_COL, CFG_ID)) || {};
    const next = { ...cur };
    for (const k of Object.keys(normalizeConfig({}))) {
      if (!(k in patch)) continue;
      next[k] = k === 'eligibleAccountsCreatedAfter' && typeof patch[k] === 'string'
        ? (patch[k] ? Date.parse(patch[k]) : null) : patch[k];
    }
    const normalized = normalizeConfig(next);
    await store.set(CFG_COL, CFG_ID, normalized);
    return normalized;
  }

  // ── pure helpers ────────────────────────────────────────────────────────
  function assertEligibleUser(user, cfg) {
    if (!cfg.enabled) throw err('feature_disabled');
    if (user.blocked) throw err('blocked');
    if (user.state === 'redeemed') throw err('already_used');
    if (user.completedOrders > 0) throw err('not_first_order');
    if (cfg.eligibleAccountsCreatedAfter != null && (user.accountCreatedAt || 0) < cfg.eligibleAccountsCreatedAfter) {
      throw err('not_eligible');
    }
  }
  const appliedExpired = (user, cfg, t) =>
    !!(user.applied && cfg.applicationExpiryDays > 0 &&
       t - user.applied.at > cfg.applicationExpiryDays * 86400000);
  const reservationActive = (user, t) =>
    user.state === 'reserved' && user.reservation && user.reservation.expiresAt > t;

  // Shared by reserve() and redeemCod(); throws a ReferralError or returns the ₹ discount.
  function checkReservable(user, cfg, t, codeDoc, owner, subtotal) {
    assertEligibleUser(user, cfg);
    if (!user.applied) throw err('no_code');
    if (appliedExpired(user, cfg, t)) throw err('code_expired');
    if (reservationActive(user, t)) {
      throw err('reservation_pending', { retryAfterSec: Math.ceil((user.reservation.expiresAt - t) / 1000) });
    }
    if (!owner || owner.blocked || (codeDoc && codeDoc.blocked)) throw err('owner_inactive');
    const sub = Math.floor(Number(subtotal));
    if (!Number.isFinite(sub) || sub < cfg.minOrderValue) throw err('min_order', { minOrderValue: cfg.minOrderValue });
    const discount = Math.min(cfg.discountAmount, Math.max(0, sub - 1)); // never charge < ₹1
    if (discount <= 0) throw err('min_order', { minOrderValue: cfg.minOrderValue });
    return discount;
  }

  // ── users & codes ───────────────────────────────────────────────────────
  class CodeTaken extends Error {}

  async function ensureUser(uid, profile = {}) {
    const existing = await store.get(USERS, uid);
    if (existing) return existing;
    const created = typeof profile.accountCreatedAt === 'function'
      ? await profile.accountCreatedAt() : profile.accountCreatedAt;
    for (let i = 0; i < 10; i++) {
      const code = generateCode();
      try {
        const doc = await store.runTransaction(async (tx) => {
          const u = await tx.get(USERS, uid);
          if (u) return u;
          if (await tx.get(CODES, code)) throw new CodeTaken();
          const t = now();
          const d = {
            uid, code,
            email: clean(profile.email, 120), name: clean(profile.name, 80),
            createdAt: t, accountCreatedAt: Number.isFinite(created) ? created : t,
            blocked: false, completedOrders: 0, state: 'none',
            applied: null, reservation: null, reservedOrders: {}, redeemed: null,
            deviceHash: profile.deviceHash || null, signupIpHash: profile.ipHash || null,
            stats: { referred: 0, successful: 0, earnings: 0 },
          };
          tx.create(USERS, uid, d);
          tx.create(CODES, code, { uid, code, blocked: false, createdAt: t });
          return d;
        });
        if (profile.deviceHash) await registerDevice(uid, profile.deviceHash).catch(() => {});
        return doc;
      } catch (e) {
        if (e instanceof CodeTaken) continue;
        throw e;
      }
    }
    throw new Error('code_generation_failed');
  }

  async function registerDevice(uid, deviceHash) {
    const cfg = await getConfig();
    const flagged = await store.runTransaction(async (tx) => {
      const d = (await tx.get(DEVICES, deviceHash)) || { uids: [] };
      if (d.uids.includes(uid)) return false;
      d.uids = [...d.uids, uid].slice(-50);
      tx.set(DEVICES, deviceHash, d);
      return d.uids.length > cfg.maxAccountsPerDevice;
    });
    if (flagged) await addFlag('many_accounts_device', uid, null, { deviceHash });
  }

  async function addFlag(type, uid, other, detail = {}) {
    try {
      const t = now();
      await store.set(FLAGS, `${type}_${uid}_${other || 'x'}_${t}`, { type, uid, other: other || null, detail, at: t });
    } catch (e) { logger.error('flag write failed', e.message); }
  }

  // ── rate limiting ───────────────────────────────────────────────────────
  const rateKeys = (uid, ctx = {}) => [
    `u_${uid}`, ctx.deviceHash && `d_${ctx.deviceHash}`, ctx.ipHash && `i_${ctx.ipHash}`,
  ].filter(Boolean);
  // IPs are shared (carrier NAT), so they get a 4× higher threshold than uid/device.
  const limitFor = (k, cfg) => (k.startsWith('i_') ? cfg.maxInvalidAttempts * 4 : cfg.maxInvalidAttempts);

  async function assertNotLocked(keys) {
    const t = now();
    for (const k of keys) {
      const r = await store.get(RATE, k);
      if (r && r.lockedUntil > t) throw err('rate_limited', { retryAfterSec: Math.ceil((r.lockedUntil - t) / 1000) });
    }
  }
  async function recordInvalid(keys, cfg) {
    const win = cfg.lockoutMinutes * 60000;
    for (const k of keys) {
      await store.runTransaction(async (tx) => {
        const t = now();
        const r = (await tx.get(RATE, k)) || { count: 0, windowStart: t, lockedUntil: 0 };
        let { count, windowStart } = r;
        if (t - windowStart > win) { count = 0; windowStart = t; }
        count += 1;
        const lockedUntil = count >= limitFor(k, cfg) ? t + win : r.lockedUntil || 0;
        tx.set(RATE, k, { count, windowStart, lockedUntil });
      });
    }
  }

  // ── apply a friend's code (locks it to the account; does NOT consume it) ─
  async function applyCode(uid, rawCode, ctx = {}) {
    const cfg = await getConfig();
    if (!cfg.enabled) throw err('feature_disabled');
    const keys = rateKeys(uid, ctx);
    await assertNotLocked(keys);
    const code = normalizeCode(rawCode);
    if (!code) { await recordInvalid(keys, cfg); throw err('invalid_code'); }
    try {
      await store.runTransaction(async (tx) => {
        const user = await tx.get(USERS, uid);
        if (!user) throw err('not_ready');
        const prior = await tx.get(REFS, uid);
        const codeDoc = await tx.get(CODES, code);
        const owner = codeDoc ? await tx.get(USERS, codeDoc.uid) : null;

        assertEligibleUser(user, cfg);
        if (user.applied || prior) throw err('already_applied');
        if (!codeDoc) throw err('invalid_code');
        if (codeDoc.uid === uid) throw err('own_code');
        if (!owner || owner.blocked || codeDoc.blocked) throw err('owner_inactive');
        if (cfg.blockSameDevice && owner.deviceHash && user.deviceHash && owner.deviceHash === user.deviceHash) {
          throw err('not_eligible', { flag: { type: 'same_device', other: owner.uid } });
        }
        const t = now();
        tx.set(USERS, uid, { ...user, applied: { code, ownerUid: owner.uid, at: t }, state: 'applied' });
        tx.set(REFS, uid, {
          referredUid: uid, referredName: user.name, referredEmail: user.email,
          referrerUid: owner.uid, referrerName: owner.name, referrerEmail: owner.email, referrerCode: code,
          code, status: 'applied', appliedAt: t, redeemedAt: null, orderId: null, amountSaved: 0,
          referrerReward: 0, deviceHash: user.deviceHash || null,
        });
        tx.set(USERS, owner.uid, { ...owner, stats: { ...owner.stats, referred: (owner.stats.referred || 0) + 1 } });
      });
    } catch (e) {
      if (e instanceof ReferralError) {
        if (['invalid_code', 'own_code', 'owner_inactive'].includes(e.code)) await recordInvalid(keys, cfg);
        if (e.flag) await addFlag(e.flag.type, uid, e.flag.other, {});
      }
      throw e;
    }
    return { discountAmount: cfg.discountAmount, minOrderValue: cfg.minOrderValue };
  }

  // ── read models ─────────────────────────────────────────────────────────
  function effectiveState(user, cfg, t) {
    if (user.state === 'redeemed') return 'redeemed';
    if (user.blocked) return 'blocked';
    if (user.applied && (user.state === 'expired' || appliedExpired(user, cfg, t))) return 'expired';
    return user.applied ? 'applied' : 'none';
  }

  async function overview(uid) {
    const cfg = await getConfig();
    const user = await store.get(USERS, uid);
    if (!user) throw err('not_ready');
    const t = now();
    let canApply = false;
    try { assertEligibleUser(user, cfg); canApply = !user.applied && user.state === 'none'; } catch (_) { /* no */ }
    return {
      code: user.code, enabled: cfg.enabled, discountAmount: cfg.discountAmount, minOrderValue: cfg.minOrderValue,
      rewardEnabled: cfg.referrerRewardEnabled, rewardAmount: cfg.referrerRewardAmount,
      state: effectiveState(user, cfg, t), canApply,
      appliedCode: user.applied ? user.applied.code : null,
      savedAmount: user.redeemed ? user.redeemed.amount : 0,
      stats: user.stats,
    };
  }

  async function quote(uid, subtotal) {
    const cfg = await getConfig();
    const user = await store.get(USERS, uid);
    const out = { eligible: false, discount: 0, reason: null, canApply: false, minOrderValue: cfg.minOrderValue };
    if (!user) return { ...out, reason: 'not_ready' };
    const t = now();
    try {
      assertEligibleUser(user, cfg);
      out.canApply = !user.applied && user.state === 'none';
      if (!user.applied) { out.reason = 'no_code'; return out; }
      if (appliedExpired(user, cfg, t)) { out.reason = 'code_expired'; return out; }
      const sub = Math.floor(Number(subtotal));
      if (!Number.isFinite(sub) || sub < cfg.minOrderValue) { out.reason = 'min_order'; return out; }
      const d = Math.min(cfg.discountAmount, Math.max(0, sub - 1));
      if (d <= 0) { out.reason = 'min_order'; return out; }
      return { ...out, eligible: true, discount: d };
    } catch (e) {
      if (e instanceof ReferralError) return { ...out, reason: e.code };
      throw e;
    }
  }

  // ── order lifecycle ─────────────────────────────────────────────────────
  const safePaid = async (id) => {
    if (!paymentChecker || !id) return false;
    try { return !!(await paymentChecker(id)); } catch (e) { logger.error('paymentChecker failed', e.message); return false; }
  };

  // If a reservation lapsed but its Razorpay order was actually paid (verify call lost),
  // settle it as redeemed so the discount can't be used a second time.
  async function settleExpiredReservation(uid) {
    if (!paymentChecker) return;
    const user = await store.get(USERS, uid);
    if (!user || user.state === 'redeemed' || reservationActive(user, now())) return;
    for (const id of Object.keys(user.reservedOrders || {}).slice(-5)) {
      if (await safePaid(id)) { await redeem(uid, id, id); return; }
    }
  }

  // Step 1 of an online order: hold the discount for one Razorpay order.
  async function reserve(uid, subtotal) {
    const cfg = await getConfig();
    await settleExpiredReservation(uid);
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user) throw err('not_ready');
      const codeDoc = user.applied ? await tx.get(CODES, user.applied.code) : null;
      const owner = user.applied ? await tx.get(USERS, user.applied.ownerUid) : null;
      const t = now();
      const discount = checkReservable(user, cfg, t, codeDoc, owner, subtotal);
      tx.set(USERS, uid, {
        ...user, state: 'reserved',
        reservation: { discount, subtotal: Math.floor(subtotal), at: t, expiresAt: t + cfg.reservationTtlMinutes * 60000, razorpayOrderId: null },
      });
      return { discount };
    });
  }

  async function attachOrder(uid, razorpayOrderId) {
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user || user.state !== 'reserved' || !user.reservation) throw err('no_code');
      tx.set(USERS, uid, {
        ...user,
        reservation: { ...user.reservation, razorpayOrderId },
        reservedOrders: { ...(user.reservedOrders || {}), [razorpayOrderId]: user.reservation.discount },
      });
      return true;
    });
  }

  // Payment failed / dismissed / order creation failed → give the discount back.
  async function release(uid, razorpayOrderId) {
    if (razorpayOrderId && await safePaid(razorpayOrderId)) {
      const r = await redeem(uid, razorpayOrderId, razorpayOrderId); // already paid: settle, never release
      return { released: false, redeemed: r.redeemed };
    }
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user || user.state !== 'reserved' || !user.reservation) return { released: false };
      const rid = user.reservation.razorpayOrderId;
      if (razorpayOrderId && rid && rid !== razorpayOrderId) return { released: false };
      tx.set(USERS, uid, { ...user, state: 'applied', reservation: null });
      return { released: true };
    });
  }

  // Payment verified → mark the discount redeemed (idempotent per Razorpay order).
  async function redeem(uid, razorpayOrderId, orderId) {
    const cfg = await getConfig();
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user) return { redeemed: false, reason: 'no_user' };
      const given = user.reservedOrders ? user.reservedOrders[razorpayOrderId] : undefined;
      if (user.state === 'redeemed') {
        if (user.redeemed.razorpayOrderId === razorpayOrderId) {
          return { redeemed: true, idempotent: true, discount: user.redeemed.amount, orderId: user.redeemed.orderId };
        }
        if (given != null) {
          tx.set(FLAGS, `double_${uid}_${razorpayOrderId}`, { type: 'double_discount_paid', uid, other: null, detail: { razorpayOrderId }, at: now() });
        }
        return { redeemed: false, reason: 'already_redeemed' };
      }
      if (given == null) return { redeemed: false, reason: 'not_discounted' };
      const ref = await tx.get(REFS, uid);
      const owner = user.applied ? await tx.get(USERS, user.applied.ownerUid) : null;
      const t = now();
      const reward = cfg.referrerRewardEnabled ? cfg.referrerRewardAmount : 0;
      tx.set(USERS, uid, {
        ...user, state: 'redeemed', completedOrders: (user.completedOrders || 0) + 1, reservation: null,
        redeemed: { orderId, razorpayOrderId, amount: given, at: t },
      });
      if (ref) tx.set(REFS, uid, { ...ref, status: 'redeemed', redeemedAt: t, orderId, amountSaved: given, referrerReward: reward });
      if (owner) {
        tx.set(USERS, owner.uid, {
          ...owner, stats: { ...owner.stats, successful: (owner.stats.successful || 0) + 1, earnings: (owner.stats.earnings || 0) + reward },
        });
      }
      return { redeemed: true, discount: given, orderId };
    });
  }

  // COD: reserve + redeem in one atomic step when the order is placed.
  async function redeemCod(uid, subtotal, orderId) {
    const cfg = await getConfig();
    await settleExpiredReservation(uid);
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user) throw err('not_ready');
      const codeDoc = user.applied ? await tx.get(CODES, user.applied.code) : null;
      const owner = user.applied ? await tx.get(USERS, user.applied.ownerUid) : null;
      const ref = await tx.get(REFS, uid);
      const t = now();
      const discount = checkReservable(user, cfg, t, codeDoc, owner, subtotal);
      const reward = cfg.referrerRewardEnabled ? cfg.referrerRewardAmount : 0;
      tx.set(USERS, uid, {
        ...user, state: 'redeemed', completedOrders: (user.completedOrders || 0) + 1, reservation: null,
        redeemed: { orderId, razorpayOrderId: null, amount: discount, at: t },
      });
      if (ref) tx.set(REFS, uid, { ...ref, status: 'redeemed', redeemedAt: t, orderId, amountSaved: discount, referrerReward: reward });
      tx.set(USERS, owner.uid, {
        ...owner, stats: { ...owner.stats, successful: (owner.stats.successful || 0) + 1, earnings: (owner.stats.earnings || 0) + reward },
      });
      return { discount };
    });
  }

  // An order completed WITHOUT the referral discount → the "first order" window is gone.
  async function markOrderCompleted(uid) {
    return store.runTransaction(async (tx) => {
      const user = await tx.get(USERS, uid);
      if (!user || user.state === 'redeemed') return false;
      const ref = user.applied ? await tx.get(REFS, uid) : null;
      const wasLive = user.state === 'applied' || user.state === 'reserved';
      tx.set(USERS, uid, {
        ...user, completedOrders: (user.completedOrders || 0) + 1,
        state: wasLive ? 'expired' : user.state, reservation: null,
      });
      if (ref && ref.status === 'applied') tx.set(REFS, uid, { ...ref, status: 'expired' });
      return true;
    });
  }

  // ── admin ───────────────────────────────────────────────────────────────
  async function listReferrals({ search = '', status = '' } = {}) {
    const cfg = await getConfig();
    const [rows, users, codes] = await Promise.all([store.list(REFS), store.list(USERS), store.list(CODES)]);
    const byUid = new Map(users.map((u) => [u.uid, u]));
    const blockedCodes = new Set(codes.filter((c) => c.blocked).map((c) => c.code));
    const t = now();
    const q = String(search || '').toLowerCase().trim();
    const out = rows.map((r) => {
      let st = r.status;
      if (st === 'applied') {
        const a = byUid.get(r.referredUid); const b = byUid.get(r.referrerUid);
        if ((a && a.blocked) || (b && b.blocked) || blockedCodes.has(r.code)) st = 'blocked';
        else if (cfg.applicationExpiryDays > 0 && t - r.appliedAt > cfg.applicationExpiryDays * 86400000) st = 'expired';
      }
      return { ...r, status: st };
    }).filter((r) => (!status || r.status === status) && (!q || [
      r.referrerName, r.referrerEmail, r.referredName, r.referredEmail, r.code, r.orderId,
    ].some((x) => String(x || '').toLowerCase().includes(q))));
    return out.sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));
  }

  async function analytics() {
    const rows = await listReferrals();
    const flags = await store.list(FLAGS);
    const c = (s) => rows.filter((r) => r.status === s).length;
    const redeemed = c('redeemed');
    return {
      totalReferrals: rows.length, applied: c('applied'), redeemed, expired: c('expired'), blocked: c('blocked'),
      redemptionRate: rows.length ? Math.round((redeemed / rows.length) * 1000) / 10 : 0,
      totalDiscountGiven: rows.reduce((s, r) => s + (r.amountSaved || 0), 0),
      flags: flags.length,
    };
  }
  const listFlags = async () => (await store.list(FLAGS)).sort((a, b) => b.at - a.at).slice(0, 200);

  async function blockUser(uid, blocked) {
    return store.runTransaction(async (tx) => {
      const u = await tx.get(USERS, uid);
      if (!u) return false;
      tx.set(USERS, uid, { ...u, blocked: !!blocked });
      return true;
    });
  }
  async function blockCode(rawCode, blocked) {
    const code = normalizeCode(rawCode);
    if (!code) return false;
    return store.runTransaction(async (tx) => {
      const c = await tx.get(CODES, code);
      if (!c) return false;
      tx.set(CODES, code, { ...c, blocked: !!blocked });
      return true;
    });
  }

  return {
    getConfig, setConfig, ensureUser, applyCode, overview, quote, reserve, attachOrder, release,
    redeem, redeemCod, markOrderCompleted, listReferrals, analytics, listFlags, blockUser, blockCode, registerDevice,
  };
}

module.exports = { createService, ReferralError, normalizeConfig, COLLECTIONS: { USERS, CODES, REFS, RATE, DEVICES, FLAGS, CFG_COL, CFG_ID } };

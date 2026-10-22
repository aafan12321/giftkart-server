'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../referral/store');
const { createService, ReferralError } = require('../referral/service');
const { normalizeCode, generateCode } = require('../referral/util');

const T0 = Date.UTC(2026, 9, 10);
function setup(opts = {}) {
  let t = T0;
  const store = new MemoryStore();
  const svc = createService({ store, now: () => t, logger: { error() {} }, ...opts });
  return { store, svc, advance: (ms) => { t += ms; }, clock: () => t };
}
const ctx = (d, i) => ({ deviceHash: d, ipHash: i });
async function user(svc, uid, device) {
  return svc.ensureUser(uid, { email: `${uid}@x.com`, name: uid, deviceHash: device || `dev_${uid}`, accountCreatedAt: T0 });
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof ReferralError && e.code === code, `expected ${code}`);

test('codes: format, uniqueness, normalisation', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = generateCode();
    assert.match(c, /^GIFT-[A-HJKMNP-Z2-9]{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 490);
  assert.equal(normalizeCode(' gift-ab23cd '), 'GIFT-AB23CD');
  assert.equal(normalizeCode('giftab23cd'), 'GIFT-AB23CD');
  assert.equal(normalizeCode('ab23cd'), 'GIFT-AB23CD');
  assert.equal(normalizeCode('GIFTAB'), null); // 'I' is never in a code body
  assert.equal(normalizeCode('GIFT-AB0OCD'), null);     // ambiguous chars never appear in codes
  assert.equal(normalizeCode("'; DROP"), null);
  assert.equal(normalizeCode(12345), null);
});

test('ensureUser: one stable unique code per user (idempotent)', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a');
  const a2 = await user(svc, 'a');
  const b = await user(svc, 'b');
  assert.equal(a.code, a2.code);
  assert.notEqual(a.code, b.code);
});

test('rule: cannot use own code', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a');
  await rejects(svc.applyCode('a', a.code, ctx('dev_a')), 'own_code');
});

test('rule: unknown / malformed code is invalid', async () => {
  const { svc } = setup();
  await user(svc, 'a');
  await rejects(svc.applyCode('a', 'GIFT-ZZZZZZ', {}), 'invalid_code');
  await rejects(svc.applyCode('a', 'nope', {}), 'invalid_code');
});

test('rule: only one code, ever (double apply)', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); const b = await user(svc, 'b'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await rejects(svc.applyCode('c', a.code, {}), 'already_applied');
  await rejects(svc.applyCode('c', b.code, {}), 'already_applied');
});

test('rule: not allowed once the user has a completed order', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.markOrderCompleted('c');
  await rejects(svc.applyCode('c', a.code, {}), 'not_first_order');
});

test('rule: owner must be active (blocked user / blocked code)', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c'); await user(svc, 'd');
  await svc.blockUser('a', true);
  await rejects(svc.applyCode('c', a.code, {}), 'owner_inactive');
  await svc.blockUser('a', false);
  await svc.blockCode(a.code, true);
  await rejects(svc.applyCode('d', a.code, {}), 'owner_inactive');
});

test('rule: feature switch off blocks everything', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.setConfig({ enabled: false });
  await rejects(svc.applyCode('c', a.code, {}), 'feature_disabled');
});

test('rule: accounts older than the launch cut-off are not eligible', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a');
  await svc.ensureUser('old', { accountCreatedAt: T0 - 86400000 * 90, deviceHash: 'dev_old' });
  await svc.setConfig({ eligibleAccountsCreatedAfter: T0 - 1000 });
  await rejects(svc.applyCode('old', a.code, {}), 'not_eligible');
});

test('fraud: same device as the referrer is blocked and flagged', async () => {
  const { svc } = setup();
  const a = await svc.ensureUser('a', { deviceHash: 'shared', accountCreatedAt: T0 });
  await svc.ensureUser('c', { deviceHash: 'shared', accountCreatedAt: T0 });
  await rejects(svc.applyCode('c', a.code, {}), 'not_eligible');
  assert.ok((await svc.listFlags()).some((f) => f.type === 'same_device'));
});

test('fraud: many accounts on one device get flagged', async () => {
  const { svc } = setup();
  for (const u of ['u1', 'u2', 'u3', 'u4']) await svc.ensureUser(u, { deviceHash: 'farm', accountCreatedAt: T0 });
  assert.ok((await svc.listFlags()).some((f) => f.type === 'many_accounts_device'));
});

test('rate limit: repeated invalid tries lock the user, then unlock after the window', async () => {
  const { svc, advance } = setup();
  await user(svc, 'c');
  for (let i = 0; i < 5; i++) await rejects(svc.applyCode('c', 'GIFT-ZZZZZZ', ctx('dev_c', 'ip1')), 'invalid_code');
  await rejects(svc.applyCode('c', 'GIFT-ZZZZZZ', ctx('dev_c', 'ip1')), 'rate_limited');
  advance(16 * 60000);
  await rejects(svc.applyCode('c', 'GIFT-ZZZZZZ', ctx('dev_c', 'ip1')), 'invalid_code');
});

test('rate limit: a locked device blocks other accounts on that device', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a');
  await svc.ensureUser('x', { deviceHash: 'dx', accountCreatedAt: T0 });
  await svc.ensureUser('y', { deviceHash: 'dx', accountCreatedAt: T0 });
  for (let i = 0; i < 5; i++) await rejects(svc.applyCode('x', 'GIFT-ZZZZZZ', ctx('dx')), 'invalid_code');
  await rejects(svc.applyCode('y', a.code, ctx('dx')), 'rate_limited');
});

test('apply locks the code in without consuming it; stats update', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  const r = await svc.applyCode('c', a.code, {});
  assert.equal(r.discountAmount, 50);
  const o = await svc.overview('c');
  assert.equal(o.state, 'applied'); assert.equal(o.appliedCode, a.code);
  assert.equal((await svc.overview('a')).stats.referred, 1);
  assert.equal((await svc.quote('c', 500)).discount, 50);
});

test('reserve → payment failed → release restores the discount', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  assert.equal((await svc.reserve('c', 500)).discount, 50);
  await svc.attachOrder('c', 'order_1');
  assert.equal((await svc.release('c', 'order_1')).released, true);
  assert.equal((await svc.overview('c')).state, 'applied');
  assert.equal((await svc.reserve('c', 500)).discount, 50); // usable again
});

test('reserve → paid → redeem: one time only, idempotent, ledger updated', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.reserve('c', 500); await svc.attachOrder('c', 'order_1');
  const r = await svc.redeem('c', 'order_1', 'GK1');
  assert.deepEqual([r.redeemed, r.discount], [true, 50]);
  assert.equal((await svc.redeem('c', 'order_1', 'GK1')).idempotent, true);
  await rejects(svc.reserve('c', 500), 'already_used');
  await rejects(svc.applyCode('c', a.code, {}), 'already_used');
  const rows = await svc.listReferrals();
  assert.equal(rows[0].status, 'redeemed'); assert.equal(rows[0].orderId, 'GK1'); assert.equal(rows[0].amountSaved, 50);
  assert.equal((await svc.overview('a')).stats.successful, 1);
  const an = await svc.analytics();
  assert.equal(an.totalDiscountGiven, 50); assert.equal(an.redemptionRate, 100);
});

test('release after redeem is a no-op (cannot undo a used discount)', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.reserve('c', 500); await svc.attachOrder('c', 'order_1');
  await svc.redeem('c', 'order_1', 'GK1');
  assert.equal((await svc.release('c', 'order_1')).released, false);
  await rejects(svc.reserve('c', 500), 'already_used');
});

test('abandoned reservation expires and the discount becomes usable again', async () => {
  const { svc, advance } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.reserve('c', 500); await svc.attachOrder('c', 'order_1');
  await rejects(svc.reserve('c', 500), 'reservation_pending');
  advance(11 * 60000);
  assert.equal((await svc.reserve('c', 500)).discount, 50);
});

test('lost verify call: expired reservation whose order was paid is settled, not reused', async () => {
  const paid = new Set();
  const { svc, advance } = setup({ paymentChecker: async (id) => paid.has(id) });
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.reserve('c', 500); await svc.attachOrder('c', 'order_1');
  paid.add('order_1'); advance(11 * 60000);
  await rejects(svc.reserve('c', 500), 'already_used');
  assert.equal((await svc.overview('c')).state, 'redeemed');
});

test('release refuses to free a discount whose payment already went through', async () => {
  const paid = new Set(['order_1']);
  const { svc } = setup({ paymentChecker: async (id) => paid.has(id) });
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.reserve('c', 500); await svc.attachOrder('c', 'order_1');
  const r = await svc.release('c', 'order_1');
  assert.equal(r.released, false);
  assert.equal((await svc.overview('c')).state, 'redeemed');
});

test('order placed without the discount burns the first-order window', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.markOrderCompleted('c');
  await rejects(svc.reserve('c', 500), 'not_first_order');
  assert.equal((await svc.listReferrals())[0].status, 'expired');
});

test('COD: atomic redeem at placement, once only', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  assert.equal((await svc.redeemCod('c', 400, 'GK9')).discount, 50);
  await rejects(svc.redeemCod('c', 400, 'GK10'), 'already_used');
});

test('minimum order value and ₹1 floor are enforced server-side', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  await svc.setConfig({ minOrderValue: 300 });
  await rejects(svc.reserve('c', 299), 'min_order');
  assert.equal((await svc.quote('c', 299)).eligible, false);
  await svc.setConfig({ minOrderValue: 0, discountAmount: 500 });
  assert.equal((await svc.quote('c', 120)).discount, 119); // never below ₹1
});

test('configurable discount + optional referrer reward', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.setConfig({ discountAmount: 75, referrerRewardEnabled: true, referrerRewardAmount: 20 });
  await svc.applyCode('c', a.code, {});
  assert.equal((await svc.redeemCod('c', 400, 'GK1')).discount, 75);
  assert.equal((await svc.overview('a')).stats.earnings, 20);
});

test('application expiry (when configured) disables an old applied code', async () => {
  const { svc, advance } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.setConfig({ applicationExpiryDays: 7 });
  await svc.applyCode('c', a.code, {});
  advance(8 * 86400000);
  await rejects(svc.reserve('c', 500), 'code_expired');
  assert.equal((await svc.listReferrals())[0].status, 'expired');
});

// ── race conditions ───────────────────────────────────────────────────────
test('race: two simultaneous applies by one user → exactly one wins', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); const b = await user(svc, 'b'); await user(svc, 'c');
  const res = await Promise.allSettled([svc.applyCode('c', a.code, {}), svc.applyCode('c', b.code, {})]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(res.find((r) => r.status === 'rejected').reason.code, 'already_applied');
});

test('race: ten simultaneous reserves → exactly one discount is handed out', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  const res = await Promise.allSettled(Array.from({ length: 10 }, () => svc.reserve('c', 500)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
});

test('race: two simultaneous COD orders → exactly one gets the discount', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a'); await user(svc, 'c');
  await svc.applyCode('c', a.code, {});
  const res = await Promise.allSettled([svc.redeemCod('c', 400, 'GK1'), svc.redeemCod('c', 400, 'GK2')]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await svc.overview('a')).stats.successful, 1);
});

test('race: parallel ensureUser never creates two codes for one user', async () => {
  const { svc, store } = setup();
  await Promise.all(Array.from({ length: 8 }, () => svc.ensureUser('p', { accountCreatedAt: T0 })));
  const codes = (await store.list('referral_codes')).filter((c) => c.uid === 'p');
  assert.equal(codes.length, 1);
});

test('race: many users applying one code all succeed and the counter is exact', async () => {
  const { svc } = setup();
  const a = await user(svc, 'a');
  const ids = Array.from({ length: 15 }, (_, i) => `u${i}`);
  for (const id of ids) await user(svc, id);
  await Promise.all(ids.map((id) => svc.applyCode(id, a.code, {})));
  assert.equal((await svc.overview('a')).stats.referred, 15);
});

test('config: same-device block can be switched off for single-phone testing', async () => {
  const { svc } = setup();
  const a = await svc.ensureUser('a', { deviceHash: 'shared', accountCreatedAt: T0 });
  await svc.ensureUser('c', { deviceHash: 'shared', accountCreatedAt: T0 });
  await svc.setConfig({ blockSameDevice: false });
  await svc.applyCode('c', a.code, {});
  assert.equal((await svc.overview('c')).state, 'applied');
});

test('limiter: proxy IP is never used for per-user lockouts (no ipHash → no ip key)', async () => {
  const { clientIp } = require('../referral/util');
  const req = { get: () => '', ip: '10.0.0.1' };
  assert.equal(clientIp(req), '');
});

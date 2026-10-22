'use strict';
// Creates test fixtures so you can exercise the full flow immediately.
//
//   Real accounts (recommended): sign in on 3 test Google accounts, copy their UIDs from
//   Firebase Console → Authentication, then:
//     node scripts/seed_referral_test_data.js --referrer <uid> --eligible <uid> --used <uid>
//
//   Without arguments it seeds 3 fake users (useful for admin-page demos & API tests).
//
// Result:
//   referrer  → owns the fixed test code GIFT-TEST22
//   eligible  → fresh user, zero orders  (can apply GIFT-TEST22, gets ₹50 off)
//   used      → already redeemed their one-time discount (applying again must fail)
const { initFirebase } = require('../referral/firebase');
const { FirestoreStore } = require('../referral/store');
const { createService, COLLECTIONS: C } = require('../referral/service');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const TEST_CODE = 'GIFT-TEST22';

(async () => {
  const fb = initFirebase();
  if (!fb) { console.error('Set FIREBASE_SERVICE_ACCOUNT first.'); process.exit(1); }
  const store = new FirestoreStore(fb.db);
  const service = createService({ store });
  const ids = { referrer: arg('referrer', 'seed_referrer'), eligible: arg('eligible', 'seed_eligible'), used: arg('used', 'seed_used') };
  const now = Date.now();

  // Testing setup: any account may claim, and two accounts on one phone are allowed.
  // Turn "Block same phone" back ON in the admin page before going live.
  await service.setConfig({ eligibleAccountsCreatedAfter: null, blockSameDevice: false });
  for (const [role, uid] of Object.entries(ids)) {
    await service.ensureUser(uid, { email: `${role}@test.local`, name: `Test ${role}`, accountCreatedAt: now, deviceHash: `seed_dev_${role}` });
  }
  // Give the referrer the fixed, easy-to-type code.
  const ref = await store.get(C.USERS, ids.referrer);
  if (ref.code !== TEST_CODE) {
    await store.set(C.CODES, TEST_CODE, { uid: ids.referrer, code: TEST_CODE, blocked: false, createdAt: now });
    await store.set(C.USERS, ids.referrer, { ...ref, code: TEST_CODE });
  }
  // "Used" user: apply + redeem through the real code path.
  const used = await store.get(C.USERS, ids.used);
  if (used.state !== 'redeemed') {
    await service.applyCode(ids.used, TEST_CODE, {});
    await service.redeemCod(ids.used, 500, 'GK_SEED_USED');
  }
  console.log('Seed complete:', { testCode: TEST_CODE, ...ids });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

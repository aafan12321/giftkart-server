'use strict';
// One-off, idempotent migration: gives every existing Firebase Auth user a referral code.
//   FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/backfill_referral_codes.js
// Safe to re-run. Add --set-cutoff if you want pre-existing accounts to be unable to
// claim the first-order discount (old orders carry no user id, so they may have ordered).
const { initFirebase } = require('../referral/firebase');
const { FirestoreStore } = require('../referral/store');
const { createService } = require('../referral/service');

(async () => {
  const fb = initFirebase();
  if (!fb) { console.error('Set FIREBASE_SERVICE_ACCOUNT first.'); process.exit(1); }
  const service = createService({ store: new FirestoreStore(fb.db) });

  // Off by default so existing accounts (and your own test accounts) CAN use codes.
  if (process.argv.includes('--set-cutoff')) {
    await service.setConfig({ eligibleAccountsCreatedAfter: Date.now() });
    console.log('Cut-off set to now: accounts created before this moment cannot claim the discount.');
  }

  let created = 0, seen = 0, token;
  do {
    const page = await fb.admin.auth().listUsers(1000, token);
    for (const u of page.users) {
      seen++;
      const before = await fb.db.collection('referral_users').doc(u.uid).get();
      if (before.exists) continue;
      await service.ensureUser(u.uid, {
        email: u.email || '', name: u.displayName || '', accountCreatedAt: Date.parse(u.metadata.creationTime),
      });
      created++;
    }
    token = page.pageToken;
  } while (token);
  console.log(`Done. Users scanned: ${seen}, new codes created: ${created}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

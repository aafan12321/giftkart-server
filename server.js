'use strict';
const Razorpay = require('razorpay');
const { Resend } = require('resend');
const { createReferralModule } = require('./referral');
const { createApp, VERSION } = require('./app');
const { getFirestore } = require('./payments/firebase');
const { FirestoreStore, MemoryStore } = require('./payments/store');
const { createMailer } = require('./payments/email');

// ── Secrets / settings: environment variables only ───────────────────────────
const env = process.env;
const config = {
  razorpayKeyId: env.RAZORPAY_KEY_ID,
  razorpayKeySecret: env.RAZORPAY_KEY_SECRET,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  notifyEmail: env.NOTIFY_EMAIL,
  fromEmail: env.FROM_EMAIL,
  reconcileIntervalMin: Number(env.RECONCILE_INTERVAL_MIN || 5),
  reconcileLookbackHours: Number(env.RECONCILE_LOOKBACK_HOURS || 6),
  orphanGraceMin: Number(env.ORPHAN_GRACE_MIN || 5),
  disableJobs: env.DISABLE_JOBS === '1',
};

const razorpay = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret });
const resend = new Resend(env.RESEND_API_KEY);
const mailer = createMailer({ resend, from: config.fromEmail, to: config.notifyEmail, alertTo: env.ALERT_EMAIL || config.notifyEmail });

// Referral module (needs FIREBASE_SERVICE_ACCOUNT; inert without it) - unchanged.
const referral = createReferralModule({ razorpay });

// Durable payment ledger shares the same Firebase project/service account.
let store;
const fb = getFirestore(env);
if (fb) store = new FirestoreStore(fb.db, fb.FieldValue);
else {
  console.error('🚨 FIREBASE_SERVICE_ACCOUNT missing/invalid: using NON-DURABLE in-memory ledger. Payment recovery guarantees are OFF.');
  store = new MemoryStore();
}

const { app, startJobs } = createApp({ razorpay, store, mailer, referral, config });
const PORT = env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GiftKart Server ${VERSION} on port ${PORT} (durable=${store.durable}, webhook=${!!config.webhookSecret})`);
  startJobs();
});

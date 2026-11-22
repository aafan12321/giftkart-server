'use strict';
const express = require('express');
const Razorpay = require('razorpay');
const { Resend } = require('resend');
const { createReferralModule } = require('./referral');
const { createApp, VERSION } = require('./app');
const { getFirestore } = require('./payments/firebase');
const { FirestoreStore, MemoryStore } = require('./payments/store');
const { createMailer } = require('./payments/email');

// ── Secrets / settings: environment variables only ───────────────────────────
const env = process.env;
const isProd = env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT;
const commit = (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'cli-or-unknown';

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

const config = {
  razorpayKeyId: env.RAZORPAY_KEY_ID,
  razorpayKeySecret: env.RAZORPAY_KEY_SECRET,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  notifyEmail: env.NOTIFY_EMAIL,
  fromEmail: env.FROM_EMAIL,
  reconcileIntervalMin: num(env.RECONCILE_INTERVAL_MIN, 5),
  reconcileLookbackHours: num(env.RECONCILE_LOOKBACK_HOURS, 6),
  orphanGraceMin: num(env.ORPHAN_GRACE_MIN, 5),
  disableJobs: env.DISABLE_JOBS === '1',
};

// ── Fail fast, with a message that names the variable (never prints values) ──
const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`🚨 Cannot start: missing required environment variable(s): ${missing.join(', ')}`);
  console.error('   Set them in Railway > your service > Variables, then redeploy.');
  process.exit(1);
}
if (!config.webhookSecret) {
  console.error('⚠️  RAZORPAY_WEBHOOK_SECRET not set: the payment webhook is DISABLED. Payments rely on the app calling back and on the reconcile job.');
}
if (!config.notifyEmail || !config.fromEmail) {
  console.error('⚠️  NOTIFY_EMAIL / FROM_EMAIL not set: order emails cannot be sent.');
}

const razorpay = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret });

// A missing RESEND_API_KEY must never take payments down (new Resend(undefined) throws).
let resend;
if (env.RESEND_API_KEY) {
  resend = new Resend(env.RESEND_API_KEY);
} else {
  console.error('⚠️  RESEND_API_KEY not set: emails are DISABLED (payments and orders keep working).');
  resend = {
    emails: {
      send: async () => ({ data: null, error: { name: 'missing_api_key', message: 'RESEND_API_KEY not set' } }),
    },
  };
}
const mailer = createMailer({ resend, from: config.fromEmail, to: config.notifyEmail, alertTo: env.ALERT_EMAIL || config.notifyEmail });

// Referral module (needs FIREBASE_SERVICE_ACCOUNT; inert without it) - unchanged.
const referral = createReferralModule({ razorpay });

// Durable payment ledger shares the same Firebase project/service account.
let store;
const fb = getFirestore(env);
if (fb) {
  store = new FirestoreStore(fb.db, fb.FieldValue);
} else if (isProd && env.ALLOW_MEMORY_STORE !== '1') {
  // A memory ledger is wiped on every restart/redeploy: real payments could be lost.
  // Railway keeps the previous (working) deployment running when this one exits.
  console.error('🚨 Cannot start: FIREBASE_SERVICE_ACCOUNT is missing or invalid, so the durable payment ledger is unavailable.');
  console.error('   Fix the variable. (Emergency override: set ALLOW_MEMORY_STORE=1 - payment recovery is then OFF.)');
  process.exit(1);
} else {
  console.error('🚨 FIREBASE_SERVICE_ACCOUNT missing/invalid: using NON-DURABLE in-memory ledger. Payment recovery guarantees are OFF.');
  store = new MemoryStore();
}

const { app, startJobs } = createApp({ razorpay, store, mailer, referral, config });
app.disable('x-powered-by');

// Health check lives on a thin outer app so it answers even if app.js has a catch-all 404 or
// auth middleware. It touches nothing external (a Firestore blip must not fail a deploy).
const root = express();
root.disable('x-powered-by');
root.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, version: VERSION, commit, durable: !!store.durable, uptimeSec: Math.round(process.uptime()) });
});
root.use(app);

let stopJobs = null;
let shuttingDown = false;

const PORT = env.PORT || 3000;
const server = root.listen(PORT, () => {
  console.log(`🚀 GiftKart Server ${VERSION} (commit ${commit}) on port ${PORT} (durable=${store.durable}, webhook=${!!config.webhookSecret}, node=${process.version})`);
  stopJobs = startJobs();
});

// Railway's proxy keeps connections alive ~60s; Node's default (5s) closes them first and causes sporadic 502s.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

// ── Graceful shutdown (Railway sends SIGTERM on every redeploy) ──────────────
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Shutting down (${reason})...`);
  try {
    if (typeof stopJobs === 'function') stopJobs();
  } catch (e) {
    console.error('stopJobs failed:', e && e.message);
  }
  const force = setTimeout(() => {
    console.error('Forced exit after 10s');
    process.exit(code || 1);
  }, 10 * 1000);
  force.unref();
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(code);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A stray rejected promise (e.g. a failed email) must be logged, not silently kill payments.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
// After an uncaught exception the process state is unknown: exit and let Railway restart it.
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException', 1);
});

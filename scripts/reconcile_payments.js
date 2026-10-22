#!/usr/bin/env node
'use strict';
/*
 * Finds Razorpay payments that were CAPTURED but have no order in Firestore.
 *
 *   node scripts/reconcile_payments.js --days 60 --out orphans.csv
 *   node scripts/reconcile_payments.js --days 60 --create-orders          (from stored intent only)
 *   node scripts/reconcile_payments.js --days 60 --create-orders --create-minimal
 *
 * Env (set in your own PowerShell session; never commit them):
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 *   FIREBASE_SERVICE_ACCOUNT_FILE=C:\path\serviceAccount.json   (or FIREBASE_SERVICE_ACCOUNT)
 *
 * Default is READ-ONLY. Orders are only written with --create-orders.
 * No emails are sent by this script.
 */
const fs = require('fs');
const Razorpay = require('razorpay');
const { getFirestore } = require('../payments/firebase');
const { FirestoreStore } = require('../payments/store');
const { createPaymentsService } = require('../payments/service');
const { orderIdFor } = require('../payments/ids');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return !v || v.startsWith('--') ? true : v;
}
const days = Number(arg('days', 30));
const outFile = String(arg('out', 'orphaned_payments.csv'));
const create = !!arg('create-orders', false);
const createMinimal = !!arg('create-minimal', false);

const csvCell = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;

(async () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  const env = { ...process.env };
  if (!env.FIREBASE_SERVICE_ACCOUNT && env.FIREBASE_SERVICE_ACCOUNT_FILE) env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
  const fb = getFirestore(env);
  if (!fb) throw new Error('Firebase service account missing/invalid');
  const store = new FirestoreStore(fb.db, fb.FieldValue);
  const razorpay = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  const mailer = { sendOrderEmail: async () => true, sendAlert: async () => true };
  const service = createPaymentsService({ razorpay, store, mailer, referral: { enabled: false }, config: {} });

  const to = Math.floor(Date.now() / 1000); const from = to - days * 86400;
  const captured = [];
  for (let skip = 0; ; skip += 100) {
    const r = await razorpay.payments.all({ from, to, count: 100, skip });
    const items = r.items || [];
    captured.push(...items.filter((p) => p.status === 'captured'));
    if (items.length < 100) break;
  }
  console.log(`Razorpay captured payments in last ${days} days: ${captured.length}`);

  const rows = []; let created = 0;
  for (const p of captured) {
    const orderId = p.order_id ? orderIdFor(p.order_id) : null;
    const pdoc = p.order_id ? await store.getPayment(p.order_id) : null;
    const byPayment = await fb.db.collection('orders').where('paymentId', '==', p.id).limit(1).get();
    const byId = orderId ? await store.getOrder(orderId) : null;
    const hasOrder = !byPayment.empty || !!byId;
    if (hasOrder) continue;
    let ours = !!pdoc;
    if (!ours && p.order_id) { try { const o = await razorpay.orders.fetch(p.order_id); ours = !!(o.notes && (o.notes.referral_discount !== undefined || o.notes.app)); } catch (_) {} }
    const hasIntent = !!(pdoc && pdoc.intent && pdoc.intent.order);
    let action = ours ? (hasIntent ? 'can_auto_create' : 'needs_manual_contact') : 'not_from_app';
    if (create && ours && (hasIntent || createMinimal)) {
      const res = await service.handlePaid(p, hasIntent ? 'reconcile-script' : 'reconcile-script');
      if (res && !res.pending) { created += 1; action = hasIntent ? 'ORDER_CREATED_full' : 'ORDER_CREATED_minimal_contact_customer'; }
    }
    rows.push([p.id, p.order_id, (p.amount / 100).toFixed(2), new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), p.contact, p.email, p.method, hasIntent ? 'yes' : 'no', action]);
  }
  const header = ['payment_id', 'razorpay_order_id', 'amount_inr', 'paid_at_ist', 'contact', 'email', 'method', 'has_stored_order_details', 'action'];
  fs.writeFileSync(outFile, [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'));
  console.log(`Orphaned captured payments (paid, no order): ${rows.length}`);
  console.log(`Orders created by this run: ${created}`);
  console.log(`CSV written: ${outFile}`);
  if (rows.length && !create) console.log('Read-only run. Re-run with --create-orders to create orders where details are stored.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

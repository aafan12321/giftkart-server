'use strict';
const { initFirebase } = require('./firebase');
const { FirestoreStore } = require('./store');
const { createService, ReferralError } = require('./service');
const { createReferralRouter, createAuthenticator, sendError } = require('./routes');
const { createAdminRouter } = require('./admin');

// Builds the whole referral module. Returns { enabled:false } when Firebase
// credentials are missing, so the rest of the server keeps working untouched.
function createReferralModule({ razorpay }) {
  const fb = initFirebase();
  if (!fb) {
    console.warn('⚠️  Referral disabled: FIREBASE_SERVICE_ACCOUNT not set');
    return { enabled: false, ReferralError, sendError };
  }
  const { admin, db } = fb;
  const paymentChecker = async (rzpOrderId) => {
    const r = await razorpay.orders.fetchPayments(rzpOrderId);
    return (r.items || []).some((p) => p.status === 'captured' || p.status === 'authorized');
  };
  const service = createService({ store: new FirestoreStore(db), paymentChecker });
  const authenticate = createAuthenticator({
    service,
    verifyToken: (t) => admin.auth().verifyIdToken(t),
    getAccountCreatedAt: async (uid) => {
      try { return Date.parse((await admin.auth().getUser(uid)).metadata.creationTime); } catch (_) { return Date.now(); }
    },
  });
  return {
    enabled: true, service, authenticate, ReferralError, sendError,
    router: createReferralRouter({ service, authenticate }),
    adminRouter: createAdminRouter({ service, adminKey: process.env.ADMIN_API_KEY || '' }),
  };
}
module.exports = { createReferralModule };

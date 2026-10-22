'use strict';
// Reads the service-account JSON from FIREBASE_SERVICE_ACCOUNT (raw JSON or base64).
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  let cred;
  try { cred = JSON.parse(raw); } catch {
    try { cred = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON/base64');
      return null;
    }
  }
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred) });
  const db = admin.firestore();
  try { db.settings({ ignoreUndefinedProperties: true }); } catch (_) { /* already set */ }
  return { admin, db };
}
module.exports = { initFirebase };

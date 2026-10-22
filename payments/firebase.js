'use strict';
// Returns a Firestore instance using the SAME service account the referral
// module already uses (FIREBASE_SERVICE_ACCOUNT, raw JSON or base64 JSON).
// Safe if the referral module already initialised the default app.
function parseServiceAccount(raw) {
  if (!raw) return null;
  let txt = raw.trim();
  if (!txt.startsWith('{')) {
    try { txt = Buffer.from(txt, 'base64').toString('utf8'); } catch (_) { return null; }
  }
  try {
    const sa = JSON.parse(txt);
    if (sa.private_key && sa.private_key.includes('\\n')) {
      sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    }
    return sa;
  } catch (_) { return null; }
}

function getFirestore(env = process.env) {
  let admin;
  try { admin = require('firebase-admin'); } catch (_) { return null; }
  let app = null;
  try { app = admin.app(); } catch (_) { /* no default app yet */ }
  if (!app) {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    if (!sa) return null;
    app = admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return { db: admin.firestore(app), FieldValue: admin.firestore.FieldValue };
}
module.exports = { getFirestore, parseServiceAccount };

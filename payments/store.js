'use strict';
// Durable payment ledger. Two implementations with identical semantics:
//   FirestoreStore  - production (Firebase Admin SDK, same project as the app)
//   MemoryStore     - tests / fallback when FIREBASE_SERVICE_ACCOUNT is absent
//
// Collections (all server-only; Firestore rules keep everything not listed
// in the rules file closed to clients):
//   payments/{razorpay_order_id}   one record per payment attempt-group
//   orders/{GK...}                 the customer-visible order (same shape the app writes)
//   payment_events/{id}            raw webhook/alert log
//   cod_keys/{client_key}          COD idempotency

class MemoryStore {
  constructor() {
    this.durable = false;
    this.payments = new Map(); this.orders = new Map();
    this.events = new Map(); this.codKeys = new Map();
    this.failOrderWrites = false; // test hook
  }
  serverTime() { return new Date(); }
  async getPayment(id) { const v = this.payments.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }
  async setPayment(id, data) { this.payments.set(id, { ...(this.payments.get(id) || {}), ...clone(data) }); }
  async updatePayment(id, patch) { return this.setPayment(id, patch); }
  async getOrder(id) { const v = this.orders.get(id); return v ? clone(v) : null; }
  async mergeOrder(id, data) {
    if (this.failOrderWrites) throw new Error('simulated order write failure');
    this.orders.set(id, { ...(this.orders.get(id) || {}), ...clone(data) });
  }
  async transactPayment(id, orderId, fn) {
    const existing = this.payments.get(id) ? clone(this.payments.get(id)) : null;
    const existingOrder = orderId && this.orders.get(orderId) ? clone(this.orders.get(orderId)) : null;
    const plan = fn(existing, existingOrder) || {};
    if (plan.order && this.failOrderWrites) throw new Error('simulated order write failure');
    if (plan.payment) this.payments.set(id, { ...(existing || {}), ...clone(plan.payment) });
    if (plan.order && !(plan.order.mode === 'create-if-absent' && existingOrder)) {
      this.orders.set(plan.order.id, { ...(existingOrder || {}), ...clone(plan.order.data) });
    }
    return plan.result;
  }
  async claimNotify(id, kind, staleMs) {
    const ex = this.payments.get(id) || {};
    if (ex.emailClaim && ex.emailClaim.kind === kind && Date.now() - ex.emailClaim.at < staleMs) return false;
    this.payments.set(id, { ...ex, emailClaim: { kind, at: Date.now() } });
    return true;
  }
  async listPendingEmail(limit = 25) {
    const out = [];
    for (const [id, d] of this.payments) if (d.emailPending === true) out.push({ id, data: clone(d) });
    return out.slice(0, limit);
  }
  async addEvent(eventId, data) {
    const ex = this.events.get(eventId);
    if (ex) return { isNew: false, status: ex.status };
    this.events.set(eventId, { status: 'received', ...clone(data) });
    return { isNew: true, status: 'received' };
  }
  async setEventStatus(eventId, status) {
    const ex = this.events.get(eventId); if (ex) ex.status = status;
  }
  async getCodKey(key) { const v = this.codKeys.get(key); return v ? clone(v) : null; }
  async setCodKey(key, data) { this.codKeys.set(key, clone(data)); }
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

class FirestoreStore {
  constructor(db, FieldValue) {
    this.durable = true; this.db = db; this.FieldValue = FieldValue;
  }
  serverTime() { return this.FieldValue.serverTimestamp(); }
  _p(id) { return this.db.collection('payments').doc(id); }
  _o(id) { return this.db.collection('orders').doc(id); }
  _e(id) { return this.db.collection('payment_events').doc(String(id).replace(/[\/\s]/g, '_').slice(0, 200)); }
  async getPayment(id) { const s = await this._p(id).get(); return s.exists ? s.data() : null; }
  async setPayment(id, data) { await this._p(id).set(data, { merge: true }); }
  async updatePayment(id, patch) { await this._p(id).set(patch, { merge: true }); }
  async getOrder(id) { const s = await this._o(id).get(); return s.exists ? s.data() : null; }
  async mergeOrder(id, data) { await this._o(id).set(data, { merge: true }); }
  async transactPayment(id, orderId, fn) {
    return this.db.runTransaction(async (tx) => {
      const pSnap = await tx.get(this._p(id));
      const oSnap = orderId ? await tx.get(this._o(orderId)) : null;
      const existing = pSnap.exists ? pSnap.data() : null;
      const existingOrder = oSnap && oSnap.exists ? oSnap.data() : null;
      const plan = fn(existing, existingOrder) || {};
      if (plan.payment) tx.set(this._p(id), plan.payment, { merge: true });
      if (plan.order && !(plan.order.mode === 'create-if-absent' && existingOrder)) {
        tx.set(this._o(plan.order.id), plan.order.data, { merge: true });
      }
      return plan.result;
    });
  }
  async claimNotify(id, kind, staleMs) {
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this._p(id));
      const ex = snap.exists ? snap.data() : {};
      if (ex.emailClaim && ex.emailClaim.kind === kind && Date.now() - ex.emailClaim.at < staleMs) return false;
      tx.set(this._p(id), { emailClaim: { kind, at: Date.now() } }, { merge: true });
      return true;
    });
  }
  async listPendingEmail(limit = 25) {
    const q = await this.db.collection('payments').where('emailPending', '==', true).limit(limit).get();
    return q.docs.map((d) => ({ id: d.id, data: d.data() }));
  }
  async addEvent(eventId, data) {
    const ref = this._e(eventId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) return { isNew: false, status: s.data().status };
      tx.set(ref, { status: 'received', receivedAt: Date.now(), ...data });
      return { isNew: true, status: 'received' };
    });
  }
  async setEventStatus(eventId, status) {
    await this._e(eventId).set({ status, updatedAt: Date.now() }, { merge: true });
  }
  async getCodKey(key) { const s = await this.db.collection('cod_keys').doc(key).get(); return s.exists ? s.data() : null; }
  async setCodKey(key, data) { await this.db.collection('cod_keys').doc(key).set({ ...data, at: Date.now() }); }
}

module.exports = { MemoryStore, FirestoreStore };

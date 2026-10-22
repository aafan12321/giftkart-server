'use strict';
// Thin storage layer so the business rules can be unit-tested without Firestore.
// Both implementations expose: get/set/create/list/runTransaction.

class FirestoreStore {
  constructor(db) { this.db = db; }
  ref(c, i) { return this.db.collection(c).doc(i); }
  async get(c, i) { const s = await this.ref(c, i).get(); return s.exists ? s.data() : null; }
  async set(c, i, d, o) { await this.ref(c, i).set(d, o || {}); }
  async create(c, i, d) { await this.ref(c, i).create(d); }
  async list(c, limit = 2000) {
    const s = await this.db.collection(c).limit(limit).get();
    return s.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  // Firestore transactions retry on contention; fn must have no side effects
  // and must do all reads before any write.
  runTransaction(fn) {
    return this.db.runTransaction(async (t) => fn({
      get: async (c, i) => { const s = await t.get(this.ref(c, i)); return s.exists ? s.data() : null; },
      set: (c, i, d, o) => { t.set(this.ref(c, i), d, o || {}); },
      create: (c, i, d) => { t.create(this.ref(c, i), d); },
    }));
  }
}

class MemoryStore {
  constructor() { this.data = new Map(); this._lock = Promise.resolve(); }
  _k(c, i) { return `${c}/${i}`; }
  _c(v) { return v == null ? null : structuredClone(v); }
  async get(c, i) { return this._c(this.data.get(this._k(c, i))); }
  async set(c, i, d, o = {}) {
    const k = this._k(c, i); const prev = this.data.get(k);
    this.data.set(k, o.merge && prev ? { ...prev, ...structuredClone(d) } : structuredClone(d));
  }
  async create(c, i, d) {
    if (this.data.has(this._k(c, i))) throw Object.assign(new Error('exists'), { code: 6 });
    await this.set(c, i, d);
  }
  async list(c) {
    const out = []; const p = `${c}/`;
    for (const [k, v] of this.data) if (k.startsWith(p)) out.push({ id: k.slice(p.length), ...structuredClone(v) });
    return out;
  }
  // Serialised: transactions never interleave, writes apply only if fn resolves.
  runTransaction(fn) {
    const run = async () => {
      const writes = [];
      const tx = {
        get: (c, i) => this.get(c, i),
        set: (c, i, d, o) => { writes.push(['set', c, i, d, o]); },
        create: (c, i, d) => {
          if (this.data.has(this._k(c, i))) throw Object.assign(new Error('exists'), { code: 6 });
          writes.push(['set', c, i, d, {}]);
        },
      };
      const res = await fn(tx);
      for (const [, c, i, d, o] of writes) await this.set(c, i, d, o);
      return res;
    };
    const p = this._lock.then(run);
    this._lock = p.catch(() => {});
    return p;
  }
}

module.exports = { FirestoreStore, MemoryStore };

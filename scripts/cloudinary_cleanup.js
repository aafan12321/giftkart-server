#!/usr/bin/env node
'use strict';
/*
 * Cloudinary audit + safe cleanup. DRY-RUN by default.
 *
 *   node scripts/cloudinary_cleanup.js --report cloudinary_assets.csv
 *   node scripts/cloudinary_cleanup.js --prefix customer-photos --older-than-days 180 --delete --confirm
 *
 * Env: CLOUDINARY_CLOUD_NAME (doftoomx), CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * (Admin API secret stays on YOUR PC. Never put it in the app.)
 *
 * Deleting customer photos is permanent. Only delete photos of orders that are
 * delivered/closed. Without --delete --confirm nothing is changed.
 */
const fs = require('fs');
const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'doftoomx';
const key = process.env.CLOUDINARY_API_KEY; const secret = process.env.CLOUDINARY_API_SECRET;
if (!key || !secret) { console.error('Set CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return !v || v.startsWith('--') ? true : v; };
const prefix = arg('prefix', ''); const olderDays = Number(arg('older-than-days', 0));
const bigBytes = Number(arg('big-kb', 1500)) * 1024; const doDelete = !!arg('delete', false) && !!arg('confirm', false);
const report = String(arg('report', 'cloudinary_assets.csv'));

async function api(path, opts = {}) {
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}${path}`, { ...opts, headers: { Authorization: auth, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  const usage = await api('/usage');
  console.log('Usage now:', JSON.stringify({ plan: usage.plan, credits: usage.credits, bandwidth: usage.bandwidth, storage: usage.storage, transformations: usage.transformations }));
  const assets = [];
  for (const type of ['image', 'video']) {
    let cursor = '';
    do {
      const q = `?max_results=500${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}${cursor ? `&next_cursor=${cursor}` : ''}`;
      const r = await api(`/resources/${type}/upload${q}`);
      for (const a of r.resources || []) assets.push({ ...a, rtype: type });
      cursor = r.next_cursor || '';
    } while (cursor);
  }
  const seen = new Map(); const rows = []; const toDelete = [];
  const now = Date.now();
  for (const a of assets) {
    const ageDays = Math.floor((now - Date.parse(a.created_at)) / 86400000);
    const sig = `${a.bytes}|${a.width}|${a.height}`;
    const dup = seen.has(sig); seen.set(sig, true);
    const flags = [];
    if (a.bytes > bigBytes) flags.push('oversize');
    if (dup) flags.push('possible_duplicate');
    if (olderDays && ageDays >= olderDays) flags.push('older_than_threshold');
    rows.push([a.public_id, a.rtype, a.format, a.bytes, a.width, a.height, a.created_at, ageDays, flags.join('|')]);
    if (olderDays && ageDays >= olderDays) toDelete.push({ id: a.public_id, type: a.rtype });
  }
  const head = ['public_id', 'type', 'format', 'bytes', 'width', 'height', 'created_at', 'age_days', 'flags'];
  fs.writeFileSync(report, [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'));
  const totalMB = (assets.reduce((s, a) => s + a.bytes, 0) / 1048576).toFixed(1);
  console.log(`Assets: ${assets.length} (${totalMB} MB). Oversize: ${rows.filter((r) => r[8].includes('oversize')).length}. Report: ${report}`);
  console.log(`Candidates for deletion (prefix="${prefix}", older than ${olderDays}d): ${toDelete.length}`);
  if (!doDelete) { console.log('DRY RUN: nothing deleted. Add --delete --confirm to delete the candidates.'); return; }
  for (const type of ['image', 'video']) {
    const ids = toDelete.filter((d) => d.type === type).map((d) => d.id);
    for (let i = 0; i < ids.length; i += 100) {
      const body = new URLSearchParams(); ids.slice(i, i + 100).forEach((id) => body.append('public_ids[]', id));
      await api(`/resources/${type}/upload`, { method: 'DELETE', body });
      console.log(`Deleted ${Math.min(i + 100, ids.length)}/${ids.length} ${type}s`);
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

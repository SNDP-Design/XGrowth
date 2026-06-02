#!/usr/bin/env node
/**
 * Export every XGrowth signup + their product profile to users.csv
 *
 * Setup (one time):
 *   1. Firebase Console → Project settings (gear) → Service accounts
 *      → "Generate new private key" → save the file as:
 *        scripts/serviceAccountKey.json
 *   2. cd scripts && npm install
 *
 * Run (anytime):
 *   cd scripts && npm run export
 *   → writes scripts/users.csv
 *
 * The service account key is git-ignored — never commit it.
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(KEY_PATH)) {
  console.error('\n❌ Missing scripts/serviceAccountKey.json');
  console.error('   Firebase Console → Project settings → Service accounts');
  console.error('   → Generate new private key → save it as scripts/serviceAccountKey.json\n');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(KEY_PATH)),
});

const db = admin.firestore();

// CSV-escape a single value (wrap in quotes, double internal quotes, collapse newlines)
function csv(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toISOString().slice(0, 16).replace('T', ' ');
}

async function main() {
  // 1. Pull every Auth user (paginated, 1000 per page)
  const authUsers = [];
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    authUsers.push(...res.users);
    pageToken = res.pageToken;
  } while (pageToken);

  // 2. Join each with their Firestore profile
  const rows = [];
  for (const u of authUsers) {
    let pp = {};
    try {
      const snap = await db.collection('users').doc(u.uid).get();
      pp = (snap.exists && snap.data()?.productProfile) || {};
    } catch (e) {
      // user has no doc yet — leave product fields blank
    }
    const competitors = Array.isArray(pp.competitors)
      ? pp.competitors.map(c => c.website).filter(Boolean).join(' | ')
      : '';
    rows.push([
      u.email || '',
      u.displayName || '',
      fmtDate(u.metadata?.creationTime),
      fmtDate(u.metadata?.lastSignInTime),
      pp.name || '',
      pp.stage || '',
      pp.website || '',
      pp.bio || '',
      competitors,
      u.uid,
    ]);
  }

  // 3. Sort newest signup first
  rows.sort((a, b) => (b[2] || '').localeCompare(a[2] || ''));

  // 4. Write CSV
  const header = ['email', 'name', 'signed_up', 'last_sign_in', 'product_name', 'stage', 'website', 'what_it_does', 'competitors', 'uid'];
  const out = [header, ...rows].map(r => r.map(csv).join(',')).join('\n');
  const outPath = path.join(__dirname, 'users.csv');
  fs.writeFileSync(outPath, out, 'utf8');

  console.log(`\n✅ Exported ${rows.length} users → ${outPath}\n`);
  // Quick console summary of the most recent signups
  console.log('Most recent signups:');
  rows.slice(0, 10).forEach(r => {
    console.log(`  ${r[2] || '—'}  ${r[0] || '(no email)'}  ${r[4] ? '· ' + r[4] : ''}`);
  });
  console.log('');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

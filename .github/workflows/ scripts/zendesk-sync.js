const fetch = require('node-fetch');
const admin = require('firebase-admin');

// ── Config ────────────────────────────────────────────────────────
const ZD_DOMAIN     = 'tracksupport.zendesk.com';
const ZD_EMAIL      = process.env.ZD_EMAIL;
const ZD_TOKEN      = process.env.ZD_TOKEN;
const ZD_AUTH       = 'Basic ' + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString('base64');
const ZD_BRAND_NAME = 'GPSandTrack Support';

// ── Firebase Admin ────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

// ── Save to Firestore in batches ──────────────────────────────────
async function saveBatch(col, docs){
  const chunks = [];
  for(let i = 0; i < docs.length; i += 400) chunks.push(docs.slice(i, i+400));
  for(const chunk of chunks){
    const batch = db.batch();
    chunk.forEach(d => batch.set(db.collection(col).doc(d.id), d, { merge: true }));
    await batch.commit();
  }
}

// ── Zendesk fetch ─────────────────────────────────────────────────
async function getZdBrandId(){
  try{
    const res = await fetch(`https://${ZD_DOMAIN}/api/v2/brands.json`, {
      headers: { 'Authorization': ZD_AUTH, 'Content-Type': 'application/json' },
    });
    if(!res.ok){ console.warn('ZD brands lookup failed:', res.status); return null; }
    const data = await res.json();
    const match = (data.brands || []).find(b => (b.name || '').trim().toLowerCase() === ZD_BRAND_NAME.trim().toLowerCase());
    if(!match){ console.warn(`ZD brand "${ZD_BRAND_NAME}" not found — fetching all pending tickets instead`); return null; }
    return match.id;
  }catch(e){ console.warn('ZD brands lookup error:', e.message); return null; }
}

async function fetchZdPendingTickets(brandId){
  let all = [];
  let url = brandId
    ? `https://${ZD_DOMAIN}/api/v2/search.json?query=${encodeURIComponent(`type:ticket status:pending brand:${brandId}`)}&per_page=100`
    : `https://${ZD_DOMAIN}/api/v2/tickets.json?status=pending&per_page=100`;
  while(url){
    const res = await fetch(url, { headers: { 'Authorization': ZD_AUTH, 'Content-Type': 'application/json' } });
    if(!res.ok){ console.warn('ZD ticket fetch failed:', res.status); break; }
    const data = await res.json();
    const rows = data.results || data.tickets || [];
    all = all.concat(rows.map(t => ({
      id: 'zd' + t.id,
      ticket: String(t.id),
      status: 'pending',
      subject: (t.subject || '').slice(0, 100),
      requester: String(t.requester_id || ''),
      assignee: String(t.assignee_id || ''),
      updated: t.updated_at || '',
      created: t.created_at || '',
    })));
    url = data.next_page || null;
  }
  return all;
}

// ── Main ──────────────────────────────────────────────────────────
async function main(){
  console.log('=== Zendesk Sync Started ===', new Date().toISOString());

  if(!ZD_EMAIL || !ZD_TOKEN){
    console.log('ZD_EMAIL/ZD_TOKEN not set — nothing to do');
    process.exit(0);
  }

  const brandId = await getZdBrandId();
  const tickets = await fetchZdPendingTickets(brandId);

  if(tickets.length === 0){
    console.log('Fetched 0 pending tickets this run — leaving zd_tickets untouched (likely a transient API issue, not genuinely zero)');
    process.exit(0);
  }

  const existingSnap = await db.collection('zd_tickets').get();
  const existingById = {};
  existingSnap.docs.forEach(d => { existingById[d.id] = d.data(); });

  // Carry over the manual "last followed up" timestamp — the API has no
  // concept of it, so without this every sync would wipe that tracking.
  const docs = tickets.map(t => ({
    ...t,
    lastFollowUp: existingById[t.id] ? (existingById[t.id].lastFollowUp || null) : null,
  }));
  await saveBatch('zd_tickets', docs);

  // Tickets that were pending last run but aren't anymore have been
  // resolved/closed on Zendesk — remove them so they stop showing as pending.
  const freshIds = new Set(docs.map(d => d.id));
  const resolvedIds = existingSnap.docs.map(d => d.id).filter(id => !freshIds.has(id));
  if(resolvedIds.length){
    const chunks = [];
    for(let i = 0; i < resolvedIds.length; i += 400) chunks.push(resolvedIds.slice(i, i+400));
    for(const chunk of chunks){
      const batch = db.batch();
      chunk.forEach(id => batch.delete(db.collection('zd_tickets').doc(id)));
      await batch.commit();
    }
    console.log(`Removed ${resolvedIds.length} resolved tickets`);
  }

  console.log(`Synced ${docs.length} pending tickets`);
  console.log('=== Zendesk Sync Complete ===', new Date().toISOString());
  process.exit(0);
}

main().catch(e => {
  console.error('Zendesk sync failed:', e.message);
  process.exit(1);
});

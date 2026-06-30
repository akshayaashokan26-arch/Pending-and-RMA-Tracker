const fetch = require('node-fetch');
const tough = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const admin = require('firebase-admin');

// ── Config ────────────────────────────────────────────────────────
const PORTAL_USER = process.env.PORTAL_USER;
const PORTAL_PASS = process.env.PORTAL_PASS;
const BASE_URL    = 'https://sievaportal.com/job-scheduler';
const LOGIN_URL   = `${BASE_URL}/login/login.php`;
const RMA_URL     = `${BASE_URL}/pagelayout/rma/Data/showRMAData_withGreen.php`;
const SHIP_URL    = `${BASE_URL}/pagelayout/rma/Data/showOrderData.php`;

// Cookie jar for session management
const cookieJar = new tough.CookieJar();
const fetchWithCookies = fetchCookie(fetch, cookieJar);

// ── Firebase Admin ────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────
function uid(){ return 'r' + Date.now() + Math.random().toString(36).slice(2,6); }

function inferWarranty(startDate){
  if(!startDate) return 'Unknown';
  const d = new Date(startDate);
  if(isNaN(d)) return 'Unknown';
  return (Date.now() - d) / (864e5 * 365) <= 1 ? 'Warranty' : 'No Warranty';
}

function inferAction(raw){
  if(!raw) return '';
  const l = raw.toLowerCase();
  if(l.includes('replacement device sent') || l.includes('replacement sent')) return 'Replacement Device Sent';
  if(l.includes('advance')) return 'Advance Replacement';
  if(l.includes('returned to customer') || l.includes('device returned')) return 'Device Returned to Customer';
  if(l.includes('battery')) return 'Battery Replaced';
  return raw.slice(0, 50);
}

function inferTestResult(raw){
  if(!raw) return '';
  const l = raw.toLowerCase();
  if(l.includes('pass')) return 'Pass';
  if(l.includes('fail')) return 'Fail';
  return '';
}

function gf(row, ...keys){
  for(const k of keys){
    const v = row[k];
    if(v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    // case-insensitive fallback
    const lk = k.toLowerCase();
    for(const rk of Object.keys(row)){
      if(rk.toLowerCase() === lk && row[rk] !== undefined && String(row[rk]).trim())
        return String(row[rk]).trim();
    }
  }
  return '';
}

// ── Save to Firestore in batches ──────────────────────────────────
async function saveBatch(col, docs){
  const chunks = [];
  for(let i = 0; i < docs.length; i += 400) chunks.push(docs.slice(i, i+400));
  for(const chunk of chunks){
    const batch = db.batch();
    chunk.forEach(d => {
      const ref = db.collection(col).doc(d.id);
      batch.set(ref, d, { merge: true }); // merge preserves checklist progress
    });
    await batch.commit();
    console.log(`  Saved ${chunk.length} to ${col}`);
  }
}

// ── Login ─────────────────────────────────────────────────────────
async function login(){
  console.log('Logging in to sievaportal.com...');
  const res = await fetchWithCookies(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `user=${encodeURIComponent(PORTAL_USER)}&pass=${encodeURIComponent(PORTAL_PASS)}&url=&submit=Log+In`,
    redirect: 'follow',
  });
  const body = await res.text();
  if(body.includes('logout') || body.includes('dashboard') || body.includes('job-scheduler')){
    console.log('✓ Login successful');
    return true;
  }
  if(body.includes('invalid') || body.includes('incorrect')){
    throw new Error('Login failed — invalid credentials');
  }
  // Check if we got redirected to a logged-in page
  if(res.url && !res.url.includes('login')){
    console.log('✓ Login successful (redirected)');
    return true;
  }
  console.log('Login response URL:', res.url);
  console.log('Login body preview:', body.slice(0, 200));
  throw new Error('Login failed — unexpected response');
}

// ── Fetch one RMA tab ─────────────────────────────────────────────
async function fetchRMATab(status, label){
  console.log(`Fetching ${label} (rma_status=${status})...`);
  const res = await fetchWithCookies(RMA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `rma_status=${status}`,
  });
  if(!res.ok) throw new Error(`${label} fetch failed: ${res.status}`);
  const text = await res.text();
  try{
    const parsed = JSON.parse(text);
    if(Array.isArray(parsed)) return parsed;
    if(parsed.data) return parsed.data;
    if(parsed.aaData) return parsed.aaData;
    return [];
  }catch(e){
    console.warn(`Parse error for ${label}:`, text.slice(0, 100));
    return [];
  }
}

// ── Fetch shipping orders ─────────────────────────────────────────
async function fetchShipping(){
  console.log('Fetching shipping orders...');
  // Try both possible endpoints
  const endpoints = [
    `${BASE_URL}/pagelayout/rma/Data/showOrderData.php`,
    `${BASE_URL}/pagelayout/shipping/Data/showOrderData.php`,
    `${BASE_URL}/pagelayout/rma/Data/getOrders.php`,
  ];
  for(const url of endpoints){
    try{
      const res = await fetchWithCookies(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: 'draw=1&start=0&length=-1',
      });
      if(!res.ok) continue;
      const text = await res.text();
      const parsed = JSON.parse(text);
      if(Array.isArray(parsed)) return parsed;
      if(parsed.data) return parsed.data;
      if(parsed.aaData) return parsed.aaData;
    }catch(e){ continue; }
  }
  console.log('Could not fetch shipping orders automatically — will use bookmarklet data');
  return [];
}

// ── Map RMA row ───────────────────────────────────────────────────
function mapRMARow(row, stage){
  const sd = gf(row, 'start_date_from_db', 'start_date__from_db_', 'startDate', 'start_date');
  let warranty = inferWarranty(sd);
  const uw = gf(row, 'under_warranty', 'underwarranty');
  if(uw === 'Yes') warranty = 'Warranty';
  if(uw === 'No')  warranty = 'No Warranty';

  const actionRaw = gf(row, 'action_taken_by_tech_agents', 'action_taken_by_tech_agents_', 'action_taken');
  const dsRaw     = gf(row, 'device_status', 'devicestatus');
  const ticket    = gf(row, 'ticket_no', 'ticket_number', 'ticket').slice(0,20);
  const imei      = gf(row, 'imei', 'IMEI').slice(0,20);

  if(!ticket) return null;

  return {
    ticket,
    date:        gf(row, 'ticket_date', 'date').slice(0,10),
    customer:    gf(row, 'customer_name', 'customer').slice(0,50),
    client:      gf(row, 'client').slice(0,30),
    device:      gf(row, 'device_type', 'device').slice(0,20),
    imei,
    startDate:   sd.slice(0,10),
    warranty,
    testResult:  inferTestResult(dsRaw),
    devStatus:   inferAction(actionRaw),
    underWarranty: uw,
    newImei:     gf(row, 'add_imei', 'new_imei').slice(0,20),
    tracking:    gf(row, 'tracking_no_', 'tracking_no', 'tracking_num', 'return_tracking_number').slice(0,30),
    notes:       gf(row, 'comment_s_', 'comments', 'additional_comments').slice(0,150),
    reason:      gf(row, 'agent_comments', 'comment_technical_support').slice(0,100),
    stage,
    syncedAt:    new Date().toISOString(),
  };
}

// ── Map shipping row ──────────────────────────────────────────────
function mapShipRow(row){
  const ticket = gf(row, 'ticket', 'ticket_number').replace(/[#\/].*/,'').trim().slice(0,20);
  if(!ticket) return null;
  return {
    ticket,
    date:    gf(row, 'date').slice(0,10),
    status:  (gf(row, 'status') || 'PENDING').toUpperCase(),
    owner:   gf(row, 'owner_createdby', 'owner', 'created_by').slice(0,40),
    devices: gf(row, 'devices').slice(0,100),
    name:    gf(row, 'name').slice(0,50),
    address: gf(row, 'address').slice(0,150),
    type:    gf(row, 'type').slice(0,20),
    ship:    gf(row, 'ship').slice(0,30),
    syncedAt: new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────
async function main(){
  console.log('=== RMA Sync Started ===', new Date().toISOString());

  // Login
  await login();

  // Fetch RMA tabs
  const [deviceStatus, completed] = await Promise.all([
    fetchRMATab(3, 'Device Status'),
    fetchRMATab(1, 'Completed'),
  ]);

  console.log(`Device Status: ${deviceStatus.length} rows`);
  console.log(`Completed: ${completed.length} rows`);

  // Get existing records to preserve checklist progress
  const existingSnap = await db.collection('rma_records').get();
  const existing = {};
  existingSnap.docs.forEach(d => {
    const data = d.data();
    existing[data.ticket + '_' + data.imei] = { id: d.id, cl: data.cl || {} };
  });

  // Map and merge
  const rmaMap = {};

  [...deviceStatus.map(r=>mapRMARow(r,'Device Status')), ...completed.map(r=>mapRMARow(r,'Completed'))]
    .filter(Boolean)
    .forEach(r => {
      const key = r.ticket + '_' + r.imei;
      const ex = existing[key];
      rmaMap[key] = {
        id:  ex ? ex.id : uid(),
        cl:  ex ? ex.cl : {},  // preserve checklist
        ...r,
      };
    });

  const rmaDocs = Object.values(rmaMap);
  console.log(`Total unique RMA records: ${rmaDocs.length}`);
  await saveBatch('rma_records', rmaDocs);

  // Fetch & save shipping orders
  const shipRows = await fetchShipping();
  if(shipRows.length > 0){
    const existingShipSnap = await db.collection('ship_orders').get();
    const existingShip = {};
    existingShipSnap.docs.forEach(d => { existingShip[d.data().ticket + '_' + d.data().date] = d.id; });
    const shipDocs = shipRows.map(mapShipRow).filter(Boolean).map(s => ({
      id: existingShip[s.ticket+'_'+s.date] || uid(),
      ...s,
    }));
    console.log(`Shipping orders: ${shipDocs.length}`);
    await saveBatch('ship_orders', shipDocs);
  }

  console.log('=== Sync Complete ===', new Date().toISOString());
  process.exit(0);
}

main().catch(e => {
  console.error('Sync failed:', e.message);
  process.exit(1);
});

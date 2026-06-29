const fetch = require('node-fetch');
const tough = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const admin = require('firebase-admin');

const PORTAL_USER = process.env.PORTAL_USER;
const PORTAL_PASS = process.env.PORTAL_PASS;
const BASE_URL    = 'https://sievaportal.com/job-scheduler';
const LOGIN_URL   = `${BASE_URL}/login/login.php`;
const RMA_URL     = `${BASE_URL}/pagelayout/rma/Data/showRMAData_withGreen.php`;

const cookieJar = new tough.CookieJar();
const fetchWithCookies = fetchCookie(fetch, cookieJar);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

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
  if(l.includes('battery')) return

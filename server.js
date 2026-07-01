// ============================================================
// server.js — Backend Alert Engine (GUSERA LTD)
//
// Apa yang dilakukan server ini:
// 1. Simpan "push subscription" tiap device yang mengaktifkan alert
//    (dikirim dari browser lewat Push API).
// 2. Tiap 5 menit (cron), scan H1 XAU/USD pakai logika yang SAMA
//    dengan frontend (analysis.js), lalu cek apakah signal valid.
// 3. Kalau signal valid & belum pernah dikirim → kirim Web Push
//    ke semua device yang subscribe. Push ini akan sampai walau
//    app ditutup / layar terkunci, SELAMA device masih menyala &
//    terkoneksi internet (ini batas fisik semua sistem push —
//    device yang benar-benar mati tidak bisa menerima apa pun).
//
// Cara pakai:
//   1) npm install
//   2) npm run gen-vapid   → salin hasilnya ke .env
//   3) isi .env (lihat .env.example)
//   4) npm start
//   5) deploy ke hosting yang selalu on (Render / Railway / VPS / Fly.io)
//      -- JANGAN dijalankan cuma di laptop sendiri, karena kalau laptop
//         mati, cron ikut berhenti.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_CONTACT_EMAIL,
  TWELVE_DATA_API_KEY,
  API_SYMBOL,
  PORT,
  ALLOWED_ORIGIN,
} = process.env;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('❌ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diisi di .env. Jalankan: npm run gen-vapid');
  process.exit(1);
}
if (!TWELVE_DATA_API_KEY) {
  console.error('❌ TWELVE_DATA_API_KEY belum diisi di .env');
  process.exit(1);
}

webpush.setVapidDetails(
  `mailto:${VAPID_CONTACT_EMAIL || 'admin@example.com'}`,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const { runAnalysisCycle } = require('./analysis');

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

// ── Penyimpanan subscription sederhana (file JSON). ──
// Untuk skala lebih besar / multi-instance, ganti dengan database (Postgres/Redis dll).
const DB_FILE = path.join(__dirname, 'subscriptions.json');

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { subscriptions: [], lastSignature: null };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ── Routes ──

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const exists = db.subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    db.subscriptions.push(sub);
    saveDB(db);
    console.log(`✅ New subscriber. Total: ${db.subscriptions.length}`);
  }
  res.status(201).json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  db.subscriptions = db.subscriptions.filter(s => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    subscribers: db.subscriptions.length,
    lastSignature: db.lastSignature,
    symbol: API_SYMBOL || 'XAU/USD',
  });
});

// Endpoint buat test manual kirim notifikasi (opsional, bantu debug).
app.post('/api/test-push', async (req, res) => {
  await broadcast('🔔 Test Notification', 'Backend alert engine is connected and working.');
  res.json({ ok: true, sent: db.subscriptions.length });
});

// ── Kirim push ke semua subscriber ──
async function broadcast(title, body, extra = {}) {
  const payload = JSON.stringify({ title, body, ...extra });
  const stillValid = [];

  for (const sub of db.subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      // 404/410 = subscription sudah tidak valid (uninstall/expired) → buang dari list
      if (err.statusCode !== 404 && err.statusCode !== 410) {
        stillValid.push(sub);
      }
      console.warn('Push failed for one subscriber:', err.statusCode || err.message);
    }
  }
  db.subscriptions = stillValid;
  saveDB(db);
}

// ── Scan siklus: dipanggil oleh cron tiap 5 menit ──
async function scanCycle() {
  try {
    const symbol = API_SYMBOL || 'XAU/USD';
    const result = await runAnalysisCycle(TWELVE_DATA_API_KEY, symbol);
    if (!result) {
      console.log(`[${new Date().toISOString()}] No valid signal.`);
      return;
    }
    if (result.signature === db.lastSignature) {
      console.log(`[${new Date().toISOString()}] Signal unchanged, skip notify.`);
      return;
    }

    db.lastSignature = result.signature;
    saveDB(db);

    const isBuy = result.trend === 'up';
    const title = `${isBuy ? '🟢 BUY' : '🔴 SELL'} Signal — XAU/USD`;
    const strongTag = result.confirmation.highProbability ? '🔥 Strong' : '✅ Valid';
    const body = `${strongTag} displacement (${Math.round(result.confirmation.bodyPercent * 100)}%) · Swing ${result.swingLow.toFixed(2)}–${result.swingHigh.toFixed(2)} · EMA aligned`;

    console.log(`[${new Date().toISOString()}] 🚨 ${title} — ${body}`);
    await broadcast(title, body, { url: '/' });
  } catch (err) {
    console.error('scanCycle error:', err.message);
  }
}

// Cron tiap 5 menit — samakan dengan POLL_INTERVAL_MS di frontend.
cron.schedule('*/5 * * * *', scanCycle);

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 GUSERA Alert Backend running on port ${port}`);
  console.log(`   Subscribers loaded: ${db.subscriptions.length}`);
  // Jalankan satu scan langsung saat startup supaya tidak nunggu 5 menit pertama.
  scanCycle();
});

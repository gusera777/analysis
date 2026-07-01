// ============================================================
// api.js — API Config & Fetch
// Konfigurasi instrumen + fetch candle H1 dari Twelve Data
// ============================================================

const TWELVE_DATA_API_KEY = 'bbdd38f627f748409e30077b748e5098';

// Jumlah candle kiri/kanan H1 untuk validasi pivot swing.
// N=3 → sensitif cukup untuk menangkap struktur H1 tanpa noise berlebih.
const SWING_N = 3;

// SMC Displacement thresholds (body/range H1)
const DISPLACEMENT_THRESHOLD = 0.55; // minimum valid displacement
const STRONG_DISPLACEMENT = 0.70; // strong / high probability

const PAIR_CONFIG = {
XAUUSD: { contractSize: 100, pipSize: 0.01, label: 'XAU/USD (Gold)', source: 'twelvedata', apiSymbol: 'XAU/USD' },
};

function getPairConfig(){
return PAIR_CONFIG[document.getElementById('pair').value];
}

function decimalsFor(pipSize){
if(pipSize >= 0.01) return 2;
return 4;
}

// ── Fetch candle H1 dari Twelve Data ──
// Hasil selalu ascending by time (oldest → newest).
async function fetchCandlesH1(cfg){
if(!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'PASTE_API_KEY_HERE'){
throw new Error('Twelve Data API key is not set.');
}
// 220 candle H1 — minimal 200 untuk EMA 200 + buffer swing detection
const limit = 220;
const symbol = encodeURIComponent(cfg.apiSymbol);
const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=${limit}&apikey=${TWELVE_DATA_API_KEY}`;

const res = await fetch(url);
const data = await res.json();
if(data.status === 'error' || !data.values){
throw new Error(data.message || 'Failed to fetch Twelve Data');
}

const candles = data.values.map(v => ({
time: new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
open: parseFloat(v.open),
high: parseFloat(v.high),
low: parseFloat(v.low),
close: parseFloat(v.close),
}));
candles.sort((a, b) => a.time - b.time); // ascending
return candles;
}

// ============================================================
// analysis.js — Analysis & Calculation
// Deteksi swing H1, SMC confirmation, EMA 200 filter
// ============================================================

// ── Deteksi swing pivot H1 + trend dari 2 pivot terakhir ──
//
// swingHigh = pivot high TERTINGGI dari 40 candle terakhir yang terkonfirmasi
// swingLow = pivot low TERENDAH dari 40 candle terakhir yang terkonfirmasi
//
// Trend ditentukan dari urutan 2 pivot terakhir by time:
// HH+HL = uptrend, LH+LL = downtrend, selain itu = ranging.
function analyzeSwings(candles, n){
const highs = [], lows = [];

// Scan semua pivot yang sudah terkonfirmasi (kecuali n candle paling akhir
// yang belum punya n candle di kanan untuk validasi)
for(let i = n; i < candles.length - n; i++){
const c = candles[i];
let isHigh = true, isLow = true;
for(let j = i - n; j <= i + n; j++){
if(j === i) continue;
if(candles[j].high >= c.high){ isHigh = false; }
if(candles[j].low <= c.low) { isLow = false; }
if(!isHigh && !isLow) break;
}
if(isHigh) highs.push({ value: c.high, time: c.time, idx: i });
if(isLow) lows.push({ value: c.low, time: c.time, idx: i });
}

if(!highs.length || !lows.length) return { swingHigh: null, swingLow: null, trend: null };

// Dari pivot yang ditemukan, ambil 40 candle terakhir sebagai "recent window"
const recentFrom = candles.length - 1 - 40;

const recentHighs = highs.filter(p => p.idx >= recentFrom);
const recentLows = lows.filter(p => p.idx >= recentFrom);

// swingHigh = nilai TERTINGGI dari semua pivot high di window terbaru
// swingLow = nilai TERENDAH dari semua pivot low di window terbaru
// Fallback ke seluruh list jika window terlalu sedikit
const poolH = recentHighs.length ? recentHighs : highs;
const poolL = recentLows.length ? recentLows : lows;

const swingHigh = poolH.reduce((best, p) => p.value > best.value ? p : best);
const swingLow = poolL.reduce((best, p) => p.value < best.value ? p : best);

// Trend: dari 2 pivot terakhir BY TIME (bukan by value)
let trend = null;
if(highs.length >= 2 && lows.length >= 2){
const h1v = highs[highs.length - 2].value, h2v = highs[highs.length - 1].value;
const l1v = lows[lows.length - 2].value, l2v = lows[lows.length - 1].value;
if(h2v > h1v && l2v > l1v) trend = 'up';
else if(h2v < h1v && l2v < l1v) trend = 'down';
else trend = 'range';
}

return { swingHigh, swingLow, trend };
}

// ── SMC Confirmation: cek displacement H1 searah bias ──
// Displacement = candle impulsif (body besar) menutup kuat searah trend.
// Scan 5 candle H1 terakhir yang sudah closed, ambil yang terkuat.
function getCandleConfirmation(candles, trend){
if(!candles || candles.length < 3)
return { confirmed: false, reason: 'Not enough H1 candle data.' };
if(trend !== 'up' && trend !== 'down')
return { confirmed: false, reason: 'No clear trend to confirm.' };

const lastClosed = candles.length - 2; // candle closed terakhir (bukan candle live)
let bestBodyPct = 0, bestDisplacement = null;

for(let i = Math.max(1, lastClosed - 4); i <= lastClosed; i++){
const c = candles[i];
const range = c.high - c.low;
if(range <= 0) continue;
const body = Math.abs(c.close - c.open);
const bodyPct = body / range;
const bullish = c.close > c.open;
const dirMatch = (trend === 'up' && bullish) || (trend === 'down' && !bullish);
if(dirMatch && bodyPct >= DISPLACEMENT_THRESHOLD && bodyPct > bestBodyPct){
bestBodyPct = bodyPct;
bestDisplacement = { candle: c, bodyPct, bullish };
}
}

if(!bestDisplacement){
return {
confirmed: false,
reason: `No H1 displacement found. Wait for an impulsive candle (body ≥${Math.round(DISPLACEMENT_THRESHOLD * 100)}%) closing ${trend === 'up' ? 'bullish' : 'bearish'}.`,
bodyPercent: 0,
};
}

return {
confirmed: true,
highProbability: bestBodyPct >= STRONG_DISPLACEMENT,
bodyPercent: bestBodyPct,
isBullish: bestDisplacement.bullish,
time: bestDisplacement.candle.time,
reason: '',
};
}

// ── EMA 200 — filter trend utama ──
// Hitung EMA 200 dari array close price (ascending).
// Jika candle < 200, gunakan semua data yang tersedia (EMA N).
// Return: { ema, period, aboveEma, lastClose }
function calcEMA200(candles){
const closes = candles.map(c => c.close);
const period = Math.min(200, closes.length);
if(period < 2) return null;

// Seed: SMA dari `period` candle pertama
let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
const k = 2 / (period + 1);

for(let i = period; i < closes.length; i++){
ema = closes[i] * k + ema * (1 - k);
}

const lastClose = closes[closes.length - 1];
return {
ema: parseFloat(ema.toFixed(2)),
period,
aboveEma: lastClose > ema, // price di atas EMA → bullish bias
lastClose,
};
}

// ============================================================
// ui.js — UI Logic
// State, event handlers, calc, autoFill, reset, copy, toast
// ============================================================

let lastText = '';
let candleConfirmed = false;
let lastH1Candles = null; // candle H1 terakhir yang difetch
let lastEMA200 = null; // hasil kalkulasi EMA 200 terakhir

// ── Helpers ──

function fmtMoney(n){
return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(t){
return new Date(t).toLocaleString('en-US', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}

// ── Pair change ──

function onPairChange(){
const status = document.getElementById('swingStatus');
status.className = 'status-bar idle';
status.textContent = 'Powered by Zep Sabbath';
document.getElementById('autoBtn').disabled = false;
lastEMA200 = null;
updateAnalyzeButtonState();
}

// ============================================================
// validity.js — Gatekeeper: hanya loloskan 1 signal yang BENAR-BENAR valid
// Syarat wajib (semua harus terpenuhi):
//  1) Swing High/Low sudah terisi & valid (hi > lo)
//  2) Trend jelas (up/down) — bukan ranging / belum terdeteksi
//  3) H1 candle sudah di-fetch & SMC displacement CONFIRMED
//  4) EMA200 selaras dengan arah trend (tidak mismatch)
// Jika salah satu gagal → tombol Analisis dikunci (disabled).
// ============================================================

function computeSignalValidity(){
const hiEl = document.getElementById('hi');
const loEl = document.getElementById('lo');
const trEl = document.getElementById('trend');

if(!hiEl || !loEl || !trEl){
return { valid: false, reason: 'Form belum siap.' };
}

const hi = parseFloat(hiEl.value);
const lo = parseFloat(loEl.value);
const tr = trEl.value;

if(isNaN(hi) || isNaN(lo) || hi <= lo){
return { valid: false, reason: 'Swing High/Low belum valid. Tap "Generate Data".' };
}
if(tr !== 'up' && tr !== 'down'){
return { valid: false, reason: 'Trend belum jelas / market sedang ranging.' };
}
if(!lastH1Candles){
return { valid: false, reason: 'H1 candle data belum di-fetch. Tap "Generate Data".' };
}

const confirmation = getCandleConfirmation(lastH1Candles, tr);
if(!confirmation.confirmed){
return { valid: false, reason: confirmation.reason || 'SMC displacement belum terkonfirmasi.' };
}

const emaOk = !!lastEMA200 && ((tr === 'up' && lastEMA200.aboveEma) || (tr === 'down' && !lastEMA200.aboveEma));
if(!emaOk){
return { valid: false, reason: 'EMA200 tidak selaras dengan trend (mismatch).' };
}

return { valid: true, reason: '', confirmation, emaOk };
}

// Cari tombol Analisis tanpa bergantung pada id tertentu di HTML,
// supaya tetap jalan walau id tombolnya bukan "analyzeBtn"/"calcBtn".
function findAnalyzeButton(){
return document.getElementById('analyzeBtn')
|| document.getElementById('calcBtn')
|| document.getElementById('runBtn')
|| document.querySelector('[onclick*="calc("]')
|| document.querySelector('[data-action="calc"]');
}

function updateAnalyzeButtonState(){
const btn = findAnalyzeButton();
const note = document.getElementById('gateNote');
const { valid, reason } = computeSignalValidity();

if(btn){
btn.disabled = !valid;
btn.title = valid ? 'Run Analysis' : ('Signal belum valid: ' + reason);
}
if(note){
note.textContent = valid ? '' : `🔒 ${reason}`;
note.classList.toggle('blocked', !valid);
}
}

// Pantau perubahan input manual (hi/lo/trend/spr/stophunt/rrTarget/modal/risk)
// supaya status tombol selalu up-to-date.
function attachValidityListeners(){
['hi','lo','trend','spr','stophunt','rrTarget','modal','risk'].forEach(id => {
const el = document.getElementById(id);
if(!el) return;
el.addEventListener('input', updateAnalyzeButtonState);
el.addEventListener('change', updateAnalyzeButtonState);
});
}

// ── Dropdown Market Watch ──
// Diisi otomatis setelah deteksi trend.
// 'range' dibuat disabled — strategi fib tidak cocok saat sideways.
function setTrendOption(trendValue){
const sel = document.getElementById('trend');
sel.innerHTML = '';
const opt = document.createElement('option');
if(trendValue === 'up'){
opt.value = 'up'; opt.textContent = '📈 Uptrend';
} else if(trendValue === 'down'){
opt.value = 'down'; opt.textContent = '📉 Downtrend';
} else {
opt.value = 'range'; opt.textContent = '↔️ Ranging (sideways)'; opt.disabled = true;
}
sel.appendChild(opt);
sel.value = opt.value;
}

// ── Generate Data ──

async function autoFillSwing(){
const cfg = getPairConfig();
const btn = document.getElementById('autoBtn');
const status = document.getElementById('swingStatus');

btn.disabled = true;
const origHTML = btn.innerHTML;
btn.innerHTML = '<span style="width:13px;height:13px;border:2px solid rgba(0,212,160,0.25);border-top-color:var(--up);border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;flex-shrink:0"></span> Fetching H1 Data…';
if(!document.getElementById('_spin_style')){
const s = document.createElement('style');
s.id = '_spin_style';
s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(s);
}
status.className = 'status-bar simple';
status.textContent = 'Fetching H1 candle data…';
candleConfirmed = false;
lastH1Candles = null;

try{
const candles = await fetchCandlesH1(cfg);
const { swingHigh, swingLow, trend } = analyzeSwings(candles, SWING_N);

if(!swingHigh || !swingLow){
status.className = 'status-bar err simple';
status.textContent = '⚠️ No swing formed yet (not enough H1 data). Try again later.';
return;
}

document.getElementById('hi').value = swingHigh.value;
document.getElementById('lo').value = swingLow.value;

if(trend === 'up') setTrendOption('up');
else if(trend === 'down') setTrendOption('down');
else if(trend === 'range') setTrendOption('range');

const confirmation = getCandleConfirmation(candles, trend);
lastH1Candles = candles;
candleConfirmed = false; // konfirmasi final dihitung ulang saat Analyze

// ── EMA 200 filter ──
lastEMA200 = calcEMA200(candles);

status.className = 'status-bar';
status.innerHTML = buildSwingResultHTML(swingHigh, swingLow, trend, confirmation, lastEMA200, decimalsFor(cfg.pipSize));

} catch(err){
status.className = 'status-bar err simple';
status.textContent = '❌ ' + err.message;
} finally {
btn.disabled = false;
btn.innerHTML = origHTML;
updateAnalyzeButtonState();
}
}

// ── Bangun tampilan hasil swing/trend/EMA/confirmation dalam bentuk baris + badge ──
// (menggantikan teks satu baris panjang yang dipisah "|" — lebih enak dibaca).
function badgeHTML(text, tone){
return `<span class="result-badge tone-${tone}">${text}</span>`;
}

function buildSwingResultHTML(swingHigh, swingLow, trend, confirmation, ema, dec){
const badges = [];

// ── Trend badge ──
if(trend === 'up') badges.push(badgeHTML('📈 Uptrend (auto)', 'up'));
else if(trend === 'down') badges.push(badgeHTML('📉 Downtrend (auto)', 'down'));
else if(trend === 'range') badges.push(badgeHTML('↔️ Ranging — wait for breakout', 'info'));
else badges.push(badgeHTML('⚠️ Not enough pivot data', 'muted'));

// ── EMA badge ──
if(ema){
const emaLabel = ema.period < 200 ? `EMA ${ema.period}` : 'EMA 200';
const emaDir = ema.aboveEma ? 'Above EMA (Bullish)' : 'Below EMA (Bearish)';
const emaMatch = (trend === 'up' && ema.aboveEma) || (trend === 'down' && !ema.aboveEma);
const emaTone = (trend === 'up' || trend === 'down') ? (emaMatch ? 'up' : 'warn') : 'muted';
badges.push(badgeHTML(`${emaLabel} ${ema.ema.toFixed(2)} · ${emaDir}`, emaTone));
if((trend === 'up' || trend === 'down') && !emaMatch){
badges.push(badgeHTML('⚠️ Trend vs EMA mismatch', 'warn'));
}
}

// ── Displacement confirmation badge ──
if(trend === 'up' || trend === 'down'){
if(confirmation.confirmed){
badges.push(badgeHTML(
confirmation.highProbability ? '🔥 Strong Displacement' : '✅ Displacement Valid',
'up'
));
} else {
badges.push(badgeHTML('⏳ Displacement pending', 'muted'));
}
}

return `
<div class="swing-result-rows">
<div class="swing-result-row">
<span class="swing-result-label">Swing High</span>
<span class="swing-result-value">${swingHigh.value.toFixed(dec)}<span class="swing-result-time">${fmtTime(swingHigh.time)}</span></span>
</div>
<div class="swing-result-row">
<span class="swing-result-label">Swing Low</span>
<span class="swing-result-value">${swingLow.value.toFixed(dec)}<span class="swing-result-time">${fmtTime(swingLow.time)}</span></span>
</div>
</div>
<div class="swing-result-badges">${badges.join('')}</div>
`;
}

// ── Zone Card HTML ──

function zoneCard(z, idx, dec, rr1, rr2, rr3){
const colors = ['#5B9CF6','#D4A843','#FF4E6A'];
const bgColors = ['rgba(91,156,246,0.07)','rgba(212,168,67,0.07)','rgba(255,78,106,0.07)'];
const borders = ['rgba(91,156,246,0.18)','rgba(212,168,67,0.18)','rgba(255,78,106,0.18)'];
const c = colors[idx];
const bg = bgColors[idx];
const bd = borders[idx];
return `
<div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:14px 16px;margin-bottom:10px">
<div style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;color:${c};text-transform:uppercase;margin-bottom:10px;opacity:0.9">${z.priority}&nbsp;&nbsp;${z.label}</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
<span style="font-family:'Inter',sans-serif;font-size:11px;color:#4A5260;font-weight:500;letter-spacing:0.5px;text-transform:uppercase">Entry Price</span>
<span style="font-family:'JetBrains Mono',monospace;font-size:21px;font-weight:700;color:#F0EDE8;letter-spacing:-0.5px">${z.entry.toFixed(dec)}</span>
</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.05)">
<span style="font-family:'Inter',sans-serif;font-size:11px;color:#4A5260;font-weight:500;letter-spacing:0.5px;text-transform:uppercase">Lot Size</span>
<span style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;color:${c}">${z.lotSize.toFixed(2)}</span>
</div>
<div style="display:flex;flex-direction:column;gap:5px;font-family:'JetBrains Mono',monospace;font-size:12px">
<div style="display:flex;justify-content:space-between;align-items:baseline">
<span style="color:#4A5260">TP 1</span>
<span style="color:#00D4A0">${z.tp1.toFixed(dec)}&nbsp;<span style="color:#2A3040;font-size:10px">RR 1:${rr1}</span></span>
</div>
<div style="display:flex;justify-content:space-between;align-items:baseline">
<span style="color:#4A5260">TP 2</span>
<span style="color:#00D4A0">${z.tp2.toFixed(dec)}&nbsp;<span style="color:#2A3040;font-size:10px">RR 1:${rr2}</span></span>
</div>
<div style="display:flex;justify-content:space-between;align-items:baseline">
<span style="color:#4A5260">TP 3</span>
<span style="color:#00D4A0">${z.tp3.toFixed(dec)}&nbsp;<span style="color:#2A3040;font-size:10px">RR 1:${rr3}</span></span>
</div>
</div>
</div>`;
}

// ── Run Analysis ──

function calc(){
const hi = parseFloat(document.getElementById('hi').value);
const lo = parseFloat(document.getElementById('lo').value);
const out = document.getElementById('out');
const cfg = getPairConfig();

if(isNaN(hi) || isNaN(lo) || hi <= lo){
out.innerHTML = 'Please, Generate Data...';
return;
}

const tr = document.getElementById('trend').value;
if(tr === 'range'){
out.innerHTML = 'Market is currently Ranging (sideways). This strategy is not recommended while ranging — wait for a breakout & a new swing to form.';
return;
}
if(tr !== 'up' && tr !== 'down'){
out.innerHTML = 'Market Watch Cannot Detect.';
return;
}

const rg = hi - lo;
const spreadPrice = (parseFloat(document.getElementById('spr').value) || 0) * cfg.pipSize;
const stopHuntPrice = (parseFloat(document.getElementById('stophunt').value) || 0) * cfg.pipSize;

let f50, f61, f78, sl;
if(tr === 'up'){
f50 = hi - rg * .5; f61 = hi - rg * .618; f78 = hi - rg * .786;
sl = lo - spreadPrice - stopHuntPrice;
} else {
f50 = lo + rg * .5; f61 = lo + rg * .618; f78 = lo + rg * .786;
sl = hi + spreadPrice + stopHuntPrice;
}

// SMC Confirmation: displacement H1 searah bias
const confirmation = getCandleConfirmation(lastH1Candles, tr);
candleConfirmed = confirmation.confirmed;
if(!candleConfirmed){
out.innerHTML = `⏳ SMC Confirmation Pending<br><br><span style="color:#8B92A0;font-size:13px">${confirmation.reason || 'Please run Generate Data first.'}</span>`;
return;
}

// ── EMA 200 filter: validasi trend selaras EMA ──
const emaOk = lastEMA200 && ((tr === 'up' && lastEMA200.aboveEma) || (tr === 'down' && !lastEMA200.aboveEma));
const emaLabel = lastEMA200 ? (lastEMA200.period < 200 ? `EMA ${lastEMA200.period}` : 'EMA 200') : 'EMA 200';
const emaValue = lastEMA200 ? lastEMA200.ema.toFixed(2) : 'N/A';

// Signal HANYA dianggap benar-benar valid jika EMA200 juga selaras dengan trend.
// Mismatch = signal ditolak sepenuhnya, bukan sekadar warning.
if(!emaOk){
out.innerHTML = `🚫 Signal Not Valid<br><br><span style="color:#8B92A0;font-size:13px">${lastEMA200 ? `Price is ${lastEMA200.aboveEma ? 'above' : 'below'} ${emaLabel} (${emaValue}), which contradicts the detected ${tr === 'up' ? 'uptrend' : 'downtrend'}.` : `${emaLabel} not available — run Generate Data first.`} Wait for EMA and trend to align before entering.</span>`;
updateAnalyzeButtonState();
return;
}

const emaStatus = `✅ Price ${lastEMA200.aboveEma ? 'above' : 'below'} ${emaLabel} (${emaValue}) — Trend confirmed`;
const probabilityTag = confirmation.highProbability
? '🔥 Strong Displacement (High Probability)'
: '✅ Displacement Confirmed';

const dec = decimalsFor(cfg.pipSize);
const rrTarget = parseFloat(document.getElementById('rrTarget').value) || 1.5;
const dir = (tr === 'up') ? 1 : -1;

const m = parseFloat(document.getElementById('modal').value) || 0;
const r = parseFloat(document.getElementById('risk').value) || 0;
const riskUsd = m * r / 100;
const remainingBalance = m - riskUsd;

const sprPips = parseFloat(document.getElementById('spr').value) || 0;
const stophuntPips = parseFloat(document.getElementById('stophunt').value) || 0;

// 3 Zone Entry: Fib 50%, 61.8%, 78.6% — masing-masing punya SL distance, TP, dan lot size sendiri
const zones = [
{ label: 'Zone A — Fib 50.0%', entry: f50, priority: '🔵 Conservative' },
{ label: 'Zone B — Fib 61.8%', entry: f61, priority: '🟡 Optimal' },
{ label: 'Zone C — Fib 78.6%', entry: f78, priority: '🔴 Aggressive' },
];

zones.forEach(z => {
z.slDist = Math.abs(z.entry - sl);
z.lotSize = z.slDist > 0 ? riskUsd / (z.slDist * cfg.contractSize) : 0;
z.tp1 = z.entry + dir * z.slDist * rrTarget;
z.tp2 = z.entry + dir * z.slDist * (rrTarget + 1);
z.tp3 = z.entry + dir * z.slDist * (rrTarget + 2);
});

const rr1 = rrTarget.toFixed(1);
const rr2 = (rrTarget + 1).toFixed(1);
const rr3 = (rrTarget + 2).toFixed(1);

// ── Plain text (copy) ──
lastText =
`🗓️ Roadmap ${cfg.label} — H1

💰 Money Management
Balance : ${fmtMoney(m)}
Risk : ${r}%
Risk (USD) : ${riskUsd.toFixed(2)}
Remaining Bal : ${fmtMoney(remainingBalance)}

🏷️ Instrument : ${cfg.label}
📊 Market Watch : ${tr === 'up' ? '📈 Uptrend' : '📉 Downtrend'}

🕯️ SMC Confirmation: ${probabilityTag} (H1 displacement body ${Math.round(confirmation.bodyPercent * 100)}%)

📐 ${emaLabel} Filter : ${emaValue} — ${emaOk ? '✅ Trend Aligned' : '⚠️ Mismatch — caution'}

🛑 Stop Loss : ${sl.toFixed(dec)}
↳ Spread Buffer : ${sprPips} pips
↳ Stop Hunt : ${stophuntPips} pips

📍 Zone Entry
${zones.map(z =>
`${z.priority} ${z.label}
Entry : ${z.entry.toFixed(dec)}
Lot Size : ${z.lotSize.toFixed(2)}
TP1 : ${z.tp1.toFixed(dec)} (RR 1:${rr1})
TP2 : ${z.tp2.toFixed(dec)} (RR 1:${rr2})
TP3 : ${z.tp3.toFixed(dec)} (RR 1:${rr3})`
).join('\n\n')}`;

// ── HTML output ──
out.innerHTML =
`<b style="color:gold">💰 Money Management</b>
<hr>
<table style="width:100%;font-size:14px;border-collapse:collapse">
<tr><td style="color:#bbb;padding:3px 0">Balance</td><td style="text-align:right;color:#fff">${fmtMoney(m)}</td></tr>
<tr><td style="color:#bbb;padding:3px 0">Risk</td><td style="text-align:right;color:#fff">${r}%</td></tr>
<tr><td style="color:#bbb;padding:3px 0">Risk (USD)</td><td style="text-align:right;color:#fff">${riskUsd.toFixed(2)}</td></tr>
<tr><td style="color:#bbb;padding:3px 0">Remaining Balance</td><td style="text-align:right;color:#fff">${fmtMoney(remainingBalance)}</td></tr>
</table>
<hr>
<b style="color:gold">🏷️ Instrument</b><br>
<span style="color:#fff">${cfg.label} &nbsp;|&nbsp; ${tr === 'up' ? '📈 Uptrend' : '📉 Downtrend'}</span>
<hr>
<b style="color:#aaa">🕯️ SMC Confirmation</b><br>
<span style="color:#ccc">${probabilityTag}</span> <span style="color:#666;font-size:12px">(H1 displacement body ${Math.round(confirmation.bodyPercent * 100)}%)</span>
<hr>
<b style="color:${emaOk ? '#1ED888' : '#E0A53C'}">📐 ${emaLabel} Filter</b><br>
<span style="color:${emaOk ? '#1ED888' : '#E0A53C'}">${emaStatus}</span>
<hr>
<b style="color:#ff7676">🛑 Stop Loss</b>: <span style="color:#ff9a9a;font-family:var(--font-mono)">${sl.toFixed(dec)}</span>
<div style="margin-top:5px;font-family:var(--font-mono);font-size:11px;color:#4A5260">
↳ Spread Buffer: <span style="color:#6A7280">${sprPips} pips</span>
&nbsp;&nbsp;|&nbsp;&nbsp;
↳ Stop Hunt: <span style="color:#6A7280">${stophuntPips} pips</span>
</div>
<hr>
<b style="color:gold">📍 Zone Entry</b>
<div style="margin-top:10px">${zones.map((z, i) => zoneCard(z, i, dec, rr1, rr2, rr3)).join('')}</div>`;

// ── Simpan ke History (hanya signal yang benar-benar valid sampai di titik ini) ──
addHistoryEntry({
time: fmtTime(Date.now()),
instrument: cfg.label,
trend: tr,
highProbability: confirmation.highProbability,
bodyPercent: confirmation.bodyPercent,
emaOk: true,
html: out.innerHTML,
text: lastText,
});

updateAnalyzeButtonState();
}

// ============================================================
// history.js — History Analisis (localStorage, persist antar sesi)
// Menyimpan setiap signal yang BENAR-BENAR valid (lolos semua gate:
// swing valid, trend jelas, SMC confirmed, EMA200 selaras).
// ============================================================

const HISTORY_KEY = 'xauusd_analysis_history';
const HISTORY_MAX = 25;

function loadHistory(){
try{
const raw = localStorage.getItem(HISTORY_KEY);
return raw ? JSON.parse(raw) : [];
} catch(e){
return [];
}
}

function saveHistoryList(list){
try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }
catch(e){ /* storage unavailable, ignore silently */ }
}

function addHistoryEntry(entry){
const list = loadHistory();
list.unshift(entry); // terbaru di atas
if(list.length > HISTORY_MAX) list.length = HISTORY_MAX;
saveHistoryList(list);
renderHistory();
}

function clearHistory(){
if(!loadHistory().length){
showToast('History is already empty');
return;
}
saveHistoryList([]);
renderHistory();
showToast('History cleared');
}

function viewHistoryEntry(idx){
const list = loadHistory();
const h = list[idx];
if(!h) return;
document.getElementById('out').innerHTML = h.html;
lastText = h.text;
showToast('Loaded from history — ' + h.time);
}

function renderHistory(){
const listEl = document.getElementById('historyList');
const countEl = document.getElementById('historyCount');
if(!listEl) return;
const list = loadHistory();

if(countEl) countEl.textContent = String(list.length);

if(!list.length){
listEl.innerHTML = '<div class="history-empty">Belum ada history.<br>Signal valid akan otomatis tersimpan di sini.</div>';
return;
}

listEl.innerHTML = list.map((h, i) => `
<div class="history-item" data-idx="${i}">
<div class="history-item-main">
<div class="history-item-title">
<span class="${h.trend === 'up' ? 'dir-up' : 'dir-down'}">${h.trend === 'up' ? '📈 Uptrend' : '📉 Downtrend'}</span>
<span>${h.instrument || ''}</span>
</div>
<div class="history-item-meta">
<span>${h.time}</span>
<span class="history-badge ${h.highProbability ? 'strong' : 'valid'}">${h.highProbability ? '🔥 Strong' : '✅ Valid'} ${Math.round((h.bodyPercent || 0) * 100)}%</span>
<span>EMA ✅</span>
</div>
</div>
<button type="button" class="history-item-view" data-idx="${i}">View</button>
</div>
`).join('');

listEl.querySelectorAll('.history-item').forEach(row => {
row.addEventListener('click', () => viewHistoryEntry(parseInt(row.getAttribute('data-idx'), 10)));
});
listEl.querySelectorAll('.history-item-view').forEach(btn => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
viewHistoryEntry(parseInt(btn.getAttribute('data-idx'), 10));
});
});
}

// ── Download History (.txt — human-readable export) ──

function downloadHistory(){
const list = loadHistory();
if(!list.length){
showToast('No history to download');
return;
}

const stampReadable = new Date().toLocaleString('en-US', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
const header =
`TRADER CERDAS INDONESIA — Analysis History Export
Generated : ${stampReadable}
Records   : ${list.length}
${'='.repeat(64)}

`;

const body = list.map((h, i) => {
const idxLabel = `#${list.length - i}`;
const trendLabel = h.trend === 'up' ? 'UPTREND' : 'DOWNTREND';
const probLabel = h.highProbability ? 'STRONG' : 'VALID';
return `${idxLabel}  ${h.time}  |  ${h.instrument || ''}  |  ${trendLabel}  |  ${probLabel} (${Math.round((h.bodyPercent || 0) * 100)}% displacement)
${'-'.repeat(64)}
${h.text}
`;
}).join(`
${'='.repeat(64)}

`);

const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' });
const url = URL.createObjectURL(blob);
const stampFile = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const a = document.createElement('a');
a.href = url;
a.download = `trader-cerdas-history-${stampFile}.txt`;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
showToast('History downloaded');
}

// Wire tombol Download & Clear pada Card History (elemen statis di HTML).
function attachHistoryControls(){
const dlBtn = document.getElementById('downloadHistoryBtn');
const clBtn = document.getElementById('clearHistoryBtn');
if(dlBtn) dlBtn.addEventListener('click', downloadHistory);
if(clBtn) clBtn.addEventListener('click', clearHistory);
}

// ============================================================
// alerts.js — Live Signal Alerts
//
// DUA MODE:
//  • SERVER-BACKED (rekomendasi) — service worker + Web Push.
//    Backend (lihat /backend) scan H1 tiap 5 menit di server dan
//    kirim push notification ke device ini lewat browser push service.
//    Notifikasi tetap muncul walau app ditutup / layar terkunci,
//    selama device menyala & terkoneksi internet.
//  • LOCAL POLLING (fallback) — dipakai otomatis kalau BACKEND_URL
//    belum diisi / backend tidak bisa dihubungi. setInterval di tab
//    ini yang scan tiap 5 menit; berhenti kalau tab/app ditutup.
// ============================================================

// Isi dengan URL backend kamu setelah di-deploy, contoh:
// const BACKEND_URL = 'https://gusera-alert-backend.onrender.com';
const BACKEND_URL = '';

// Isi dengan VAPID_PUBLIC_KEY hasil `npm run gen-vapid` di backend.
const VAPID_PUBLIC_KEY = '';

const LIVE_ALERT_KEY = 'xauusd_live_alert_enabled';
const LAST_NOTIFIED_KEY = 'xauusd_last_notified_signal';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 menit — samakan dengan cron backend

let liveAlertTimer = null;
let swRegistration = null;

function isNotificationSupported(){
return 'Notification' in window;
}
function isPushSupported(){
return 'serviceWorker' in navigator && 'PushManager' in window;
}
function isBackendConfigured(){
return !!(BACKEND_URL && VAPID_PUBLIC_KEY);
}

function urlBase64ToUint8Array(base64String){
const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
const rawData = atob(base64);
const outputArray = new Uint8Array(rawData.length);
for(let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
return outputArray;
}

async function registerServiceWorker(){
if(!('serviceWorker' in navigator)) return null;
try{
swRegistration = await navigator.serviceWorker.register('service-worker.js');
navigator.serviceWorker.addEventListener('message', (e) => {
if(e.data && e.data.type === 'RESUBSCRIBE_PUSH') subscribeToPush().catch(() => {});
});
return swRegistration;
} catch(e){
console.warn('Service worker registration failed:', e);
return null;
}
}

async function subscribeToPush(){
if(!swRegistration) swRegistration = await navigator.serviceWorker.ready;
let subscription = await swRegistration.pushManager.getSubscription();
if(!subscription){
subscription = await swRegistration.pushManager.subscribe({
userVisibleOnly: true,
applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
});
}
await fetch(`${BACKEND_URL}/api/subscribe`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(subscription),
});
return subscription;
}

async function unsubscribeFromPush(){
if(!swRegistration) return;
const subscription = await swRegistration.pushManager.getSubscription();
if(!subscription) return;
try{
await fetch(`${BACKEND_URL}/api/unsubscribe`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ endpoint: subscription.endpoint }),
});
} catch(e){ /* backend mungkin sedang down, tetap lanjut unsubscribe lokal */ }
await subscription.unsubscribe();
}

async function onLiveAlertToggle(){
const toggle = document.getElementById('liveAlertToggle');
const sub = document.getElementById('liveAlertSub');
const modeTag = document.getElementById('liveAlertMode');
if(!toggle) return;

if(toggle.checked){
if(!isNotificationSupported()){
toggle.checked = false;
showToast('Browser ini tidak mendukung notifikasi sistem');
return;
}

let perm = Notification.permission;
if(perm === 'default'){
perm = await Notification.requestPermission();
}
if(perm !== 'granted'){
toggle.checked = false;
showToast('Izin notifikasi ditolak — aktifkan lewat pengaturan browser');
return;
}

localStorage.setItem(LIVE_ALERT_KEY, '1');

if(isBackendConfigured() && isPushSupported()){
try{
await registerServiceWorker();
await subscribeToPush();
if(sub) sub.textContent = 'Aktif — server scan H1 tiap 5 menit, tetap jalan saat app ditutup/terkunci';
if(modeTag){ modeTag.textContent = 'SERVER-BACKED'; modeTag.className = 'alert-mode-tag mode-server'; }
showToast('Live Signal Alerts diaktifkan (server-backed)');
} catch(e){
console.warn('Push subscribe failed, falling back to local polling:', e);
startLiveAlerts();
if(sub) sub.textContent = 'Aktif (mode lokal) — auto-scan H1 tiap 5 menit selama tab terbuka';
if(modeTag){ modeTag.textContent = 'LOCAL'; modeTag.className = 'alert-mode-tag mode-local'; }
showToast('Backend tidak terhubung — pakai mode lokal');
}
} else {
startLiveAlerts();
if(sub) sub.textContent = 'Aktif (mode lokal) — Auto-scan setiap 5 menit selama tab terbuka';
if(modeTag){ modeTag.textContent = 'LOCAL'; modeTag.className = 'alert-mode-tag mode-local'; }
showToast('Live Signal Alerts diaktifkan (mode lokal)');
}

} else {
localStorage.setItem(LIVE_ALERT_KEY, '0');
if(sub) sub.textContent = 'Auto-scan H1 & notifikasi saat signal valid muncul';
if(modeTag){ modeTag.textContent = 'OFF'; modeTag.className = 'alert-mode-tag mode-off'; }
showToast('Live Signal Alerts dimatikan');
stopLiveAlerts();
if(isBackendConfigured()) unsubscribeFromPush().catch(() => {});
}
}

function startLiveAlerts(){
if(liveAlertTimer) return;
scanForSignal();
liveAlertTimer = setInterval(scanForSignal, POLL_INTERVAL_MS);
}

function stopLiveAlerts(){
if(liveAlertTimer){
clearInterval(liveAlertTimer);
liveAlertTimer = null;
}
}

async function scanForSignal(){
const btn = document.getElementById('autoBtn');
if(btn && btn.disabled) return;
try{
await autoFillSwing();
maybeNotifyValidSignal();
} catch(e){
// autoFillSwing sudah handle error-nya sendiri lewat swingStatus
}
}

function maybeNotifyValidSignal(){
const result = computeSignalValidity();
if(!result.valid) return;

const trEl = document.getElementById('trend');
const tr = trEl ? trEl.value : null;
const confirmation = result.confirmation;

const signature = `${tr}|${confirmation.time}|${Math.round(confirmation.bodyPercent * 100)}`;
const lastSig = localStorage.getItem(LAST_NOTIFIED_KEY);
if(signature === lastSig) return;

localStorage.setItem(LAST_NOTIFIED_KEY, signature);
fireSignalNotification(tr, confirmation);
}

function fireSignalNotification(tr, confirmation){
const cfg = getPairConfig();
const hi = document.getElementById('hi').value;
const lo = document.getElementById('lo').value;
const isBuy = tr === 'up';

const title = `${isBuy ? '🟢 BUY' : '🔴 SELL'} Signal — ${cfg.label}`;
const strongTag = confirmation.highProbability ? '🔥 Strong' : '✅ Valid';
const body = `${strongTag} displacement (${Math.round(confirmation.bodyPercent * 100)}%) · Swing ${lo}–${hi} · EMA200 aligned`;

try{
const n = new Notification(title, {
body,
icon: 'logo.png',
tag: 'xauusd-signal',
renotify: true,
});
n.onclick = () => { window.focus(); n.close(); };
} catch(e){
showToast(title + ' — ' + body);
}
}

// Resume state saat halaman di-load ulang.
async function restoreLiveAlertState(){
const toggle = document.getElementById('liveAlertToggle');
const sub = document.getElementById('liveAlertSub');
const modeTag = document.getElementById('liveAlertMode');
if(!toggle) return;

if(isBackendConfigured() && isPushSupported()){
await registerServiceWorker();
}

const wasEnabled = localStorage.getItem(LIVE_ALERT_KEY) === '1';
if(wasEnabled && isNotificationSupported() && Notification.permission === 'granted'){
toggle.checked = true;

if(isBackendConfigured() && isPushSupported()){
try{
const existing = await swRegistration.pushManager.getSubscription();
if(existing){
if(sub) sub.textContent = 'Aktif — server scan H1 tiap 5 menit, tetap jalan saat app ditutup/terkunci';
if(modeTag){ modeTag.textContent = 'SERVER-BACKED'; modeTag.className = 'alert-mode-tag mode-server'; }
return;
}
await subscribeToPush();
if(sub) sub.textContent = 'Aktif — server scan H1 tiap 5 menit, tetap jalan saat app ditutup/terkunci';
if(modeTag){ modeTag.textContent = 'SERVER-BACKED'; modeTag.className = 'alert-mode-tag mode-server'; }
return;
} catch(e){ /* fallback ke lokal di bawah */ }
}

if(sub) sub.textContent = 'Aktif (mode lokal) — auto-scan H1 tiap 5 menit selama tab terbuka';
if(modeTag){ modeTag.textContent = 'LOCAL'; modeTag.className = 'alert-mode-tag mode-local'; }
startLiveAlerts();
} else if(wasEnabled){
localStorage.setItem(LIVE_ALERT_KEY, '0');
}
}

// ── Reset ──

function resetForm(){
document.getElementById('pair').value = 'XAUUSD';

const trendSel = document.getElementById('trend');
trendSel.innerHTML = '<option value="" disabled selected>Update ⇢ Generate Data</option>';

document.getElementById('hi').value = '';
document.getElementById('lo').value = '';
document.getElementById('modal').value = '10000';
document.getElementById('risk').value = '1';
document.getElementById('spr').value = '30';
document.getElementById('stophunt').value = '500';
document.getElementById('rrTarget').value = '1.5';
document.getElementById('out').innerHTML = 'Waiting for analysis — tap <strong style="color:#D4A843">Run Analysis</strong> to begin.';
lastText = '';
candleConfirmed = false;
lastH1Candles = null;
lastEMA200 = null;
onPairChange();
updateAnalyzeButtonState();
}

// ── Copy ──

function copyResult(){
if(!lastText){
showToast('No analysis results yet. Please tap Analyze first.');
return;
}
if(navigator.clipboard && navigator.clipboard.writeText){
navigator.clipboard.writeText(lastText).then(() => showToast('Copied to clipboard!')).catch(fallbackCopy);
} else {
fallbackCopy();
}
}

function fallbackCopy(){
const ta = document.createElement('textarea');
ta.value = lastText;
ta.style.cssText = 'position:fixed;opacity:0';
document.body.appendChild(ta);
ta.focus(); ta.select();
try{
document.execCommand('copy');
showToast('Copied to clipboard!');
} catch(e){
showToast('Copy failed');
}
document.body.removeChild(ta);
}

// ── Toast ──

function showToast(msg){
const t = document.getElementById('toast');
t.textContent = msg;
t.classList.add('show');
setTimeout(() => t.classList.remove('show'), 1800);
}

// ── Init ──
onPairChange();
attachValidityListeners();
attachHistoryControls();
renderHistory();
updateAnalyzeButtonState();
restoreLiveAlertState();

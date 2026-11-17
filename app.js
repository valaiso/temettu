'use strict';

// Yerelde (node dev.mjs) /api, GitHub Pages'te Supabase fonksiyonu kullanılır.
const API = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? '/api'
  : 'https://jqmfvinbzgqyitqquzdc.supabase.co/functions/v1/TEMETTU';

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const COLORS = ['#8ec5f5', '#f5c451', '#f08a6c', '#8fd694', '#c49cf5', '#5fd3c9', '#f59cc8', '#d9c07a', '#7aa8ff', '#ffb36b', '#b5e48c', '#e9a3ff'];
const DAY = 86400000;
const CACHE_TTL = 6 * 3600 * 1000;

// ---------- Depolama ----------
const store = {
  get(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* özel pencere vb. */ } },
};
const state = Object.assign(
  { holdings: [], cur: 'USD', filter: 'ALL', growthMode: 'value', range: '1Y' },
  store.get('temettu.state', {}),
);
delete state.chart;
delete state.tax; // eski sürümdeki elle girilen stopaj ayarı artık kullanılmıyor
const cache = Object.assign({ data: {}, fx: null, fxHist: [], at: 0 }, store.get('temettu.cache', {}));
// dataChanged: hisse/adet değiştiyse true (buluta gönderilir); yalnızca görünüm tercihi değiştiyse false.
function save(dataChanged = true) {
  if (dataChanged) state.updatedAt = Date.now();
  store.set('temettu.state', state);
  if (dataChanged) schedulePush();
}
const saveCache = () => store.set('temettu.cache', cache);

// ---------- Tarih yardımcıları (ISO YYYY-MM-DD, UTC hesap) ----------
const today = () => new Date().toLocaleDateString('en-CA');
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const addYears = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10); };
const monthKey = (iso) => iso.slice(0, 7);
const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const trDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });

// ---------- Biçimlendirme ----------
const fmtCache = {};
function money(v, cur, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  const k = cur + digits;
  fmtCache[k] ||= new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return fmtCache[k].format(v);
}
const qtyFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 6 });
const short = (sym) => sym.replace(/\.IS$/, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseNum = (s) => Number(String(s).trim().replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));

function toCur(value, from, to = state.cur) {
  if (from === to) return value;
  const fx = cache.fx;
  if (!fx) return NaN;
  if (from === 'USD' && to === 'TRY') return value * fx;
  if (from === 'TRY' && to === 'USD') return value / fx;
  return NaN;
}

// ---------- Veri ----------
async function api(params, fresh = false) {
  const res = await fetch(`${API}?${new URLSearchParams(params)}`, { cache: fresh ? 'reload' : 'default' });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'sunucu hatası');
  return j;
}

async function refresh(symbols = state.holdings.map((h) => h.symbol), force = false) {
  const need = force ? symbols : symbols.filter((s) => !cache.data[s] || !cache.data[s].px || Date.now() - (cache.data[s].fetchedAt || 0) > CACHE_TTL);
  if (!need.length) return;
  setStatus('Veriler güncelleniyor…');
  try {
    const j = await api({ symbols: need.join(','), v: 2 }, force); // v: yanıt biçimi değişince eski tarayıcı önbelleğini atlamak için
    const now = Date.now();
    for (const [s, d] of Object.entries(j.data)) cache.data[s] = { ...d, fetchedAt: now };
    if (j.fx?.USDTRY) cache.fx = j.fx.USDTRY;
    if (j.fx?.USDTRY_HIST?.length) cache.fxHist = j.fx.USDTRY_HIST;
    cache.at = now;
    saveCache();
    const missing = need.filter((s) => !j.data[s]);
    setStatus(`Güncellendi: ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` +
      (cache.fx ? ` · USD/TRY ${cache.fx.toFixed(2).replace('.', ',')}` : '') +
      (missing.length ? ` · veri bulunamadı: ${missing.join(', ')}` : ''));
  } catch (e) {
    setStatus(`Veri alınamadı (${e.message}). Kayıtlı veriler gösteriliyor.`);
  }
  render();
}

function setStatus(text) { document.getElementById('status').textContent = text; }

// ---------- Hesap ----------
// Stopaj oranları ödeme tarihine göre otomatik uygulanır. Mevzuat değişirse yalnızca bu tablo güncellenir.
//  - BIST: 9286 sayılı Cumhurbaşkanı Kararı (RG 22.12.2024) ile %10 → %15.
//  - BIST yatırım ortaklıkları (GYO, GSYO, menkul kıymet YO): %0.
//  - ABD: Türkiye–ABD çifte vergilendirme anlaşması, W-8BEN veren bireysel yatırımcı için %20.
const TAX_RULES = {
  TR: [{ from: '0000-01-01', rate: 10 }, { from: '2024-12-22', rate: 15 }],
  US: [{ from: '0000-01-01', rate: 20 }],
};
const INVESTMENT_TRUST = /yat[iı]r[iı]m\s+ortakl[iı][gğ][iı]|\bG(YO|SYO)\b/i;
function isInvestmentTrust(h) {
  return h.market === 'TR' && (INVESTMENT_TRUST.test(cache.data[h.symbol]?.name || h.name || '') || /GYO$/.test(short(h.symbol)));
}
function taxRate(h, iso = today()) {
  if (isInvestmentTrust(h)) return 0;
  let rate = 0;
  for (const r of TAX_RULES[h.market] || []) if (iso >= r.from) rate = r.rate;
  return rate;
}
const net = (h, iso) => 1 - taxRate(h, iso) / 100;
const curOf = (h) => cache.data[h.symbol]?.currency || (h.market === 'TR' ? 'TRY' : 'USD');

function qtyAt(h, iso) {
  let q = 0;
  for (const e of h.log) { if (e.d <= iso) q = e.q; else break; }
  return q;
}

// Her temettü: ex-tarihi, hisse başı tutar ve (tahmini) ödeme tarihi.
function events(h) {
  const info = cache.data[h.symbol];
  if (!info) return [];
  const list = info.divs.map((d) => {
    const pay = d.pay || (info.nextPay && info.nextEx === d.ex ? info.nextPay : null);
    return { ex: d.ex, amt: d.amt, pay: pay || addDays(d.ex, info.lag), payKnown: !!pay };
  });
  // Açıklanmış ama grafikte henüz görünmeyen bir sonraki temettü (tutar = son tutar, tahmini).
  const last = list.at(-1);
  if (info.nextEx && last && info.nextEx > last.ex && Date.parse(info.nextEx) - Date.parse(last.ex) > 20 * DAY) {
    list.push({ ex: info.nextEx, amt: last.amt, pay: info.nextPay || addDays(info.nextEx, info.lag), payKnown: !!info.nextPay, estAmt: true });
  }
  return list;
}

// Ödemesi gerçekleşmiş ve ex-tarihinden önce elde tutulan hisseler için alınan net temettüler.
function received(h, until = today()) {
  const out = [];
  for (const e of events(h)) {
    if (e.pay > until) continue;
    const held = qtyAt(h, addDays(e.ex, -1));
    if (held > 0) out.push({ pay: e.pay, value: held * e.amt * net(h, e.pay) });
  }
  return out;
}

// Önümüzdeki 12 ay: son bir yıllık temettü döngüsü ileri taşınır.
function projection(h) {
  const evs = events(h);
  if (!evs.length) return [];
  const t = today();
  const last = evs.at(-1);
  if (last.ex < addDays(t, -400)) return []; // bir yılı aşkın süredir temettü yok
  const cycle = evs.filter((e) => e.ex > addDays(last.ex, -350));
  const regular = cycle.length >= 3;
  const latestReal = [...cycle].reverse().find((e) => !e.estAmt) || last;
  const byMonth = new Map();
  for (const e of cycle) {
    let pay = e.pay, shifted = false;
    while (pay <= t) { pay = addYears(pay, 1); shifted = true; }
    const amt = shifted && regular ? latestReal.amt : e.amt;
    byMonth.set(Number(pay.slice(5, 7)), { pay, ex: shifted ? null : e.ex, amt, est: shifted || e.estAmt || !e.payKnown });
  }
  return [...byMonth.values()].sort((a, b) => a.pay.localeCompare(b.pay));
}

// O gün bilinen son bir yıllık temettü döngüsünden hisse başı yıllık temettü (projection ile aynı mantık,
// böylece grafiğin bugünkü değeri "Yıllık beklenen" ile örtüşür ve ex-tarihi kaymaları sıçrama yapmaz).
function annualPerShare(evs, iso) {
  let i = evs.length - 1;
  while (i >= 0 && evs[i].ex > iso) i--;
  if (i < 0) return 0;
  const last = evs[i];
  if (last.ex < addDays(iso, -400)) return 0;
  const from = addDays(last.ex, -350);
  let n = 0, s = 0;
  for (let j = i; j >= 0 && evs[j].ex > from; j--) { n++; s += evs[j].amt; }
  return n >= 3 ? last.amt * n : s;
}

const visible = () => state.holdings.filter((h) => state.filter === 'ALL' || h.market === state.filter);

// ---------- Görünüm ----------
function render() {
  const hs = visible();
  const t = today();
  const nowMonth = new Date().getMonth() + 1;

  for (const id of ['filter', 'cur']) {
    const v = { filter: state.filter, cur: state.cur }[id];
    document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }
  document.getElementById('eyebrow').textContent = { ALL: 'DIVIDEND INVESTING', US: 'DIVIDEND INVESTING · ABD', TR: 'DIVIDEND INVESTING · BIST' }[state.filter];

  const proj = new Map(hs.map((h) => [h.symbol, projection(h)]));
  const filled = new Set();
  hs.forEach((h) => qtyAt(h, t) > 0 && proj.get(h.symbol).forEach((p) => filled.add(Number(p.pay.slice(5, 7)))));
  document.getElementById('subtitle').textContent = `${hs.length} kalem · 12 ayın ${filled.size}'${suffix(filled.size)} dolu`;

  // Takvim
  const cal = document.getElementById('cal');
  let html = `<div class="h first">HİSSE</div>` + MONTHS.map((m, i) => `<div class="h${i + 1 === nowMonth ? ' now' : ''}">${m}</div>`).join('');
  const totals = new Array(13).fill(0);
  if (!hs.length) html += `<div class="emptyrow">Yukarıdaki arama kutusundan hisse, ETF veya fon ekleyin.</div>`;
  for (const h of hs) {
    const color = colorOf(h);
    const cur = curOf(h);
    const q = qtyAt(h, t);
    const byM = new Map(proj.get(h.symbol).map((p) => [Number(p.pay.slice(5, 7)), p]));
    html += `<div class="name" style="color:${color}"><i style="background:${color}"></i>${esc(short(h.symbol))}</div>`;
    for (let m = 1; m <= 12; m++) {
      const p = byM.get(m);
      const cls = `cell${m === nowMonth ? ' now' : ''}`;
      if (!p) { html += `<div class="${cls}"><span class="tiny"></span></div>`; continue; }
      const val = q * p.amt * net(h, p.pay);
      totals[m] += toCur(val, cur);
      const tip = `<b>${esc(short(h.symbol))}</b> · ${MONTHS[m - 1]}<br>Ödeme: ${p.est ? '~' : ''}${trDate(p.pay)}${p.ex ? `<br>Ex-tarih: ${trDate(p.ex)}` : ''}<br>Hisse başı: ${money(p.amt, cur, 4)}<br>Net (${qtyFmt.format(q)} adet, %${taxRate(h, p.pay)} stopaj): <b>${money(val, cur)}</b>${p.est ? '<br><i>tahmini</i>' : ''}`;
      html += `<div class="${cls}"><span class="dot" style="background:${color}" data-tip="${esc(tip)}"></span><span class="amt">${money(val, cur)}</span></div>`;
    }
  }
  if (hs.length) {
    html += `<div class="tot first">TOPLAM</div>` + totals.slice(1).map((v, i) => `<div class="tot">${v ? money(v, state.cur) : ''}</div>`).join('');
  }
  cal.innerHTML = html;

  // Özet
  const yearStart = `${t.slice(0, 4)}-01-01`;
  let annual = 0, thisYear = 0, total = 0;
  for (const h of hs) {
    const cur = curOf(h), q = qtyAt(h, t);
    for (const p of proj.get(h.symbol)) annual += toCur(q * p.amt * net(h, p.pay), cur);
    for (const r of received(h)) { const v = toCur(r.value, cur); total += v; if (r.pay >= yearStart) thisYear += v; }
  }
  document.getElementById('stats').innerHTML = [
    ['Yıllık beklenen (net)', annual], ['Aylık ortalama', annual / 12], [`${t.slice(0, 4)} alınan`, thisYear], ['Toplam alınan', total],
  ].map(([k, v]) => `<div class="panel stat"><div class="k">${k}</div><div class="v">${money(v, state.cur)}</div></div>`).join('');

  // Kartlar
  document.getElementById('cards').innerHTML = hs.map((h) => {
    const cur = curOf(h), info = cache.data[h.symbol], q = qtyAt(h, t);
    const got = received(h).reduce((s, r) => s + r.value, 0);
    const yr = proj.get(h.symbol).reduce((s, p) => s + q * p.amt * net(h, p.pay), 0);
    const yieldPct = info?.price && yr ? (yr / (q * info.price)) * 100 : null;
    return `<div class="panel card" data-sym="${esc(h.symbol)}">
      <button class="x" data-act="remove" title="Kaldır">×</button>
      <div class="hd"><span class="badge" style="background:${colorOf(h)}">${esc(short(h.symbol).slice(0, 5))}</span>
        <div style="min-width:0"><div class="tk">${esc(short(h.symbol))}</div><div class="nm">${esc(info?.name || h.name || '')}</div></div></div>
      <div class="row">
        <div><div class="k">Adet</div><div class="qty"><input value="${qtyFmt.format(q)}" inputmode="decimal" data-act="qty" aria-label="${esc(h.symbol)} adet">
          <svg viewBox="0 0 24 24" fill="none" stroke="${q > 0 ? 'var(--green)' : 'var(--faint)'}" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/></svg></div></div>
        <div class="r"><div class="k">Alınan temettü</div><div class="v gold">${money(got, cur)}</div></div>
      </div>
      <div class="ft"><span>Yıllık ${money(yr, cur)}${yieldPct ? ` · %${yieldPct.toFixed(2).replace('.', ',')}` : ''} · Stopaj %${taxRate(h)}</span>
        <label title="İlk alış tarihi">İlk alış <input type="date" value="${h.log[0]?.d || t}" max="${t}" data-act="since"></label></div>
      ${!info ? '<div class="err">Veri yok; Ayarlar → Verileri yenile.</div>'
        : !proj.get(h.symbol).length ? `<div class="err">${info.divs.length ? `Son temettü ${trDate(info.divs.at(-1).ex)}; son bir yılda dağıtım yok.` : 'Temettü geçmişi bulunamadı.'}</div>` : ''}
    </div>`;
  }).join('');

  renderChart(hs);
  renderTax();
}

// "12 ayın 4'ü / 6'sı / 12'si dolu"
const suffix = (n) => ({ 0: 'ı', 1: 'i', 2: 'si', 3: 'ü', 4: 'ü', 5: 'i', 6: 'sı', 7: 'si', 8: 'i', 9: 'u', 10: 'u', 11: 'i', 12: 'si' })[n];
function colorOf(h) { return COLORS[state.holdings.indexOf(h) % COLORS.length]; }

// ---------- Grafikler ----------
const charts = {};
function drawChart(id, config, cur) {
  config.options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#c7cad1', boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y, cur)}` } },
    },
    scales: {
      x: { stacked: config.type === 'bar', ticks: { color: '#8a909b', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } },
      y: { stacked: config.type === 'bar', beginAtZero: config.type === 'bar', ticks: { color: '#8a909b', callback: (v) => money(v, cur, Math.abs(v) >= 100 ? 0 : 2) }, grid: { color: 'rgba(255,255,255,.06)' } },
    },
  };
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function renderChart(hs) {
  if (typeof Chart === 'undefined') { document.getElementById('chartNote').textContent = 'Grafik kütüphanesi yüklenemedi.'; return; }
  renderMonthly(hs);
  renderGrowth(hs);
}

function renderMonthly(hs) {
  const t = today();
  const firstLog = hs.map((h) => h.log[0]?.d).filter(Boolean).sort()[0] || t;
  const nowKey = monthKey(t);
  let start = monthKey(firstLog);
  if (start < addMonths(nowKey, -23)) start = addMonths(nowKey, -23);
  if (start > addMonths(nowKey, -5)) start = addMonths(nowKey, -5);
  const end = addMonths(nowKey, 11);
  const keys = [];
  for (let k = start; k <= end; k = addMonths(k, 1)) keys.push(k);
  const got = Object.fromEntries(keys.map((k) => [k, 0]));
  const exp = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const h of hs) {
    const c = curOf(h), q = qtyAt(h, t);
    for (const r of received(h)) if (r.pay.slice(0, 7) in got) got[r.pay.slice(0, 7)] += toCur(r.value, c);
    for (const p of projection(h)) { const k = monthKey(p.pay); if (k in exp && p.pay > t) exp[k] += toCur(q * p.amt * net(h, p.pay), c); }
  }
  drawChart('chart', {
    type: 'bar',
    data: {
      labels: keys.map((k) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`),
      datasets: [
        { label: 'Alınan', data: keys.map((k) => got[k]), backgroundColor: '#f2c14e', borderRadius: 5, stack: 's' },
        { label: 'Beklenen', data: keys.map((k) => exp[k]), backgroundColor: 'rgba(242,193,78,.28)', borderColor: 'rgba(242,193,78,.6)', borderWidth: 1, borderRadius: 5, stack: 's' },
      ],
    },
  }, state.cur);
  document.getElementById('chartNote').textContent = 'Koyu çubuk: ödemesi gerçekleşmiş temettü. Açık çubuk: mevcut adetlerle beklenen. Karışık para birimleri güncel USD/TRY kuruyla çevrilir.';
}

// Tarihe göre sıralı [[iso, değer], ...] dizisinde o güne kadarki son değer.
function lastAt(arr, iso) {
  if (!arr?.length) return null;
  if (arr[0][0] > iso) return arr[0][1];
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid][0] <= iso) lo = mid; else hi = mid - 1; }
  return arr[lo][1];
}
const fxAt = (iso) => lastAt(cache.fxHist, iso) || cache.fx;
function convAt(value, from, iso, to = state.cur) {
  if (from === to) return value;
  const fx = fxAt(iso);
  if (!fx) return NaN;
  if (from === 'USD' && to === 'TRY') return value * fx;
  if (from === 'TRY' && to === 'USD') return value / fx;
  return NaN;
}

const RANGES = [['1H', 7], ['1A', 30], ['3A', 91], ['6A', 182], ['1Y', 365], ['3Y', 1095], ['5Y', 1826], ['ALL', null]];

// Gün gün: yatırılan para (adet eklemeleri o günün fiyatıyla), portföy değeri, alınan temettü ve yıllık temettü geliri.
function growthSeries(hs) {
  const t = today();
  let first = hs.map((h) => h.log[0]?.d).filter(Boolean).sort()[0];
  if (!first || first > t) return [];
  if (first < addDays(t, -3650)) first = addDays(t, -3650);
  const flows = [];
  for (const h of hs) {
    const info = cache.data[h.symbol], c = curOf(h);
    let prev = 0;
    for (const e of h.log) {
      const d = e.d < first ? first : e.d;
      const p = lastAt(info?.px, d);
      if (p) flows.push({ d, v: convAt((e.q - prev) * p, c, d) });
      prev = e.q;
    }
  }
  flows.sort((a, b) => a.d.localeCompare(b.d));
  const rec = hs.flatMap((h) => received(h).map((r) => ({ d: r.pay, v: convAt(r.value, curOf(h), r.pay) }))).sort((a, b) => a.d.localeCompare(b.d));
  const evsBy = new Map(hs.map((h) => [h.symbol, events(h).filter((e) => !e.estAmt)]));
  const out = [];
  let fi = 0, ri = 0, invested = 0, divs = 0;
  for (let d = first; d <= t; d = addDays(d, 1)) {
    while (fi < flows.length && flows[fi].d <= d) invested += flows[fi++].v || 0;
    while (ri < rec.length && rec[ri].d <= d) divs += rec[ri++].v || 0;
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if ((wd === 0 || wd === 6) && d !== t && d !== first) continue; // hafta sonları atlanır
    let value = 0, income = 0;
    for (const h of hs) {
      const q = qtyAt(h, d);
      if (!(q > 0)) continue;
      const info = cache.data[h.symbol], c = curOf(h);
      const p = lastAt(info?.px, d);
      if (p) value += convAt(q * p, c, d);
      income += convAt(q * annualPerShare(evsBy.get(h.symbol), d) * net(h, d), c, d);
    }
    out.push({ d, invested, value, divs, income });
  }
  return out;
}

function renderGrowth(hs) {
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.range));
  document.querySelectorAll('#growthMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.growthMode));
  const all = growthSeries(hs);
  const days = RANGES.find((r) => r[0] === state.range)?.[1];
  const from = days ? addDays(today(), -days) : '0000';
  const s = all.filter((x) => x.d >= from);
  const sum = document.getElementById('growthSummary');
  const note = document.getElementById('growthNote');
  const cur = state.cur;
  const labels = s.map((x) => new Date(x.d + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', ...(days && days <= 182 ? {} : { year: '2-digit' }) }));
  const line = (label, data, rgb, fill = false) => ({
    label, data, borderColor: `rgb(${rgb})`, backgroundColor: fill ? `rgba(${rgb},.10)` : 'transparent',
    fill, pointRadius: s.length < 40 ? 2 : 0, borderWidth: 2, tension: .15,
  });
  if (!s.length) {
    sum.innerHTML = '';
    note.textContent = 'Grafik için en az bir kalem ekleyin.';
    drawChart('growth', { type: 'line', data: { labels: [], datasets: [] } }, cur);
    return;
  }
  const a = s[0], b = s.at(-1);
  const sign = (v) => (v >= 0 ? '+' : '');
  if (state.growthMode === 'income') {
    const ch = b.income - a.income;
    sum.innerHTML = `<span>Yıllık temettü geliri <b>${money(b.income, cur)}</b></span>` +
      `<span class="${ch >= 0 ? 'up' : 'down'}">Bu aralıkta ${sign(ch)}${money(ch, cur)}</span>` +
      `<span>Aralıkta alınan <b>${money(b.divs - a.divs, cur)}</b></span>`;
    drawChart('growth', { type: 'line', data: { labels, datasets: [
      line('Yıllık temettü geliri', s.map((x) => x.income), '242,193,78', true),
      line('Toplam alınan temettü', s.map((x) => x.divs), '127,209,139'),
    ] } }, cur);
    note.textContent = 'Altın çizgi: o günkü adetlerinizle bir yılda alacağınız net temettü; eklemeler ve temettü artışlarıyla yükselir. Yeşil çizgi: o güne kadar hesabınıza geçen net temettülerin toplamı.';
  } else {
    const gain = (x) => x.value + x.divs - x.invested;
    const total = gain(b), period = gain(b) - gain(a);
    const periodBase = a.value + (b.invested - a.invested);
    const pct = (v, d) => (d > 0 ? `%${((v / d) * 100).toFixed(2).replace('.', ',')}` : '—');
    sum.innerHTML = `<span>Değer + temettü <b>${money(b.value + b.divs, cur)}</b></span>` +
      `<span class="${period >= 0 ? 'up' : 'down'}">Bu aralıkta ${sign(period)}${money(period, cur)} (${pct(period, periodBase)})</span>` +
      `<span class="${total >= 0 ? 'up' : 'down'}">Toplam getiri ${sign(total)}${money(total, cur)} (${pct(total, b.invested)})</span>`;
    drawChart('growth', { type: 'line', data: { labels, datasets: [
      line('Değer + alınan temettü', s.map((x) => x.value + x.divs), '127,209,139', true),
      line('Portföy değeri', s.map((x) => x.value), '232,93,155'),
      line('Yatırılan (eklemeler)', s.map((x) => x.invested), '220,224,232'),
    ] } }, cur);
    note.textContent = 'Beyaz: eklediğiniz para (adet artışları o günün kapanış fiyatıyla). Pembe: portföyün piyasa değeri. Yeşil: değer + bugüne kadar alınan net temettüler; beyaz çizginin üstünde kalan kısım kazancınızdır. Geçmiş değerler o günün USD/TRY kuruyla çevrilir.';
  }
}

// ---------- ABD temettü vergi beyanı ----------
// Türkiye'de stopaja tabi olmayan menkul sermaye iratlarının (yurt dışı temettü dahil) beyan sınırı, GVK 86/1-d.
// Her yıl Aralık sonunda Gelir Vergisi Genel Tebliği ile açıklanır; yeni yılın tutarı açıklanınca buraya bir satır eklenir.
const DECLARE_LIMITS = { 2025: 18000, 2026: 22000 };

function renderTax() {
  const box = document.getElementById('taxbox');
  const t = today(), y = Number(t.slice(0, 4));
  const known = Object.keys(DECLARE_LIMITS).map(Number).sort((a, b) => a - b);
  const latest = known.at(-1);
  const us = state.holdings.filter((h) => h.market === 'US');
  const rows = [y - 1, y].map((year) => {
    let gross = 0, withheld = 0;
    for (const h of us) {
      const c = curOf(h);
      for (const e of events(h)) {
        if (e.pay > t || !e.pay.startsWith(String(year))) continue;
        const held = qtyAt(h, addDays(e.ex, -1));
        if (!(held > 0)) continue;
        const g = convAt(held * e.amt, c, e.pay, 'TRY');
        gross += g;
        withheld += (g * taxRate(h, e.pay)) / 100;
      }
    }
    const limit = DECLARE_LIMITS[year];
    const lim = limit ?? DECLARE_LIMITS[latest];
    const status = !gross ? '<span class="muted">Bu yıl ABD temettüsü yok</span>'
      : gross > lim ? `<span class="down">Sınır aşıldı · ${year + 1} Mart'ta beyan gerekir</span>`
      : `<span class="up">Sınırın altında · beyan gerekmez (kalan ${money(lim - gross, 'TRY', 0)})</span>`;
    return `<tr><td><b>${year}</b>${year === y ? ' <span class="muted">(devam ediyor)</span>' : ''}</td>
      <td>${limit ? money(limit, 'TRY', 0) : `${money(lim, 'TRY', 0)} <span class="muted">(${year} tutarı henüz açıklanmadı, ${latest} tutarı)</span>`}</td>
      <td>${money(gross, 'TRY')}</td><td>${money(withheld, 'TRY')}</td><td>${status}</td></tr>`;
  }).join('');
  box.innerHTML = `<h2>ABD hisse / ETF temettüsü: vergi beyan sınırı</h2>
    <p class="note big">ABD temettüleri Türkiye'de stopaja tabi olmadığı için <b>tevkifata tabi olmayan menkul sermaye iradı</b> sayılır. Bir yılda elde edilen
      brüt tutarın TL karşılığı (diğer stopajsız menkul ve gayrimenkul sermaye iratlarıyla birlikte) beyan sınırını aşarsa, tamamı ertesi yılın Mart ayında
      yıllık gelir vergisi beyannamesiyle beyan edilir. ABD'de kesilen %20 vergi, Türkiye'de hesaplanan vergiden mahsup edilir. Yurt dışı temettüde %50 istisna uygulanmaz.</p>
    <div class="tablewrap"><table class="tax">
      <thead><tr><th>Gelir yılı</th><th>Beyan sınırı</th><th>Brüt ABD temettün</th><th>ABD'de kesilen</th><th>Durum</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="note">Beyan sınırları: ${known.map((k) => `${k}: ${money(DECLARE_LIMITS[k], 'TRY', 0)}`).join(' · ')} (GVK 86/1-d). Yeni yılın tutarı her yıl Aralık sonunda açıklanır.
      TL karşılıkları ödeme günündeki USD/TRY kuruyla yaklaşık hesaplanır; beyanda TCMB döviz alış kuru kullanılır. Bu bölüm bilgilendirme amaçlıdır; kesin durum için mali müşavirinize danışın.</p>`;
}

// ---------- Etkileşim ----------
function bindSeg(id, key) {
  document.getElementById(id).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    state[key] = v; save(false); render();
  });
}
bindSeg('filter', 'filter');
bindSeg('cur', 'cur');
bindSeg('growthMode', 'growthMode');
bindSeg('range', 'range');

// Arama
const qInput = document.getElementById('q');
const resultsBox = document.getElementById('results');
let searchTimer, searchSeq = 0, lastResults = [];
qInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = qInput.value.trim();
  if (q.length < 2) { resultsBox.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    resultsBox.hidden = false;
    resultsBox.innerHTML = '<div class="empty">Aranıyor…</div>';
    try {
      const j = await api({ q });
      if (seq !== searchSeq) return;
      lastResults = j.results;
      resultsBox.innerHTML = j.results.length
        ? j.results.map((r, i) => `<button data-i="${i}"><b>${esc(short(r.symbol))}</b><span class="nm">${esc(r.name)}</span>
            <span class="chip">${r.type === 'EQUITY' ? 'Hisse' : r.type === 'ETF' ? 'ETF' : 'Fon'}</span>
            <span class="chip ${r.market === 'TR' ? 'tr' : 'us'}">${r.market === 'TR' ? 'BIST' : 'ABD'}</span></button>`).join('')
        : '<div class="empty">Sonuç yok. ABD için sembol (KO), BIST için kod (TUPRS) deneyin.</div>';
    } catch (e) {
      if (seq === searchSeq) resultsBox.innerHTML = `<div class="empty">Arama yapılamadı: ${esc(e.message)}</div>`;
    }
  }, 300);
});
resultsBox.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  showAddForm(lastResults[Number(b.dataset.i)]);
  resultsBox.hidden = true;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) resultsBox.hidden = true; });
qInput.addEventListener('focus', () => { if (resultsBox.innerHTML && qInput.value.trim().length >= 2) resultsBox.hidden = false; });

function showAddForm(r) {
  const box = document.getElementById('addForm');
  const existing = state.holdings.find((h) => h.symbol === r.symbol);
  box.hidden = false;
  box.innerHTML = `<div class="who"><b>${esc(short(r.symbol))}</b> <span class="chip ${r.market === 'TR' ? 'tr' : 'us'}">${r.market === 'TR' ? 'BIST' : 'ABD'}</span><div>${esc(r.name)}</div></div>
    <label>ADET<input id="addQty" inputmode="decimal" placeholder="ör. 2,5" value="${existing ? qtyFmt.format(qtyAt(existing, today())) : ''}"></label>
    <label>İLK ALIŞ TARİHİ<input id="addDate" type="date" value="${existing?.log[0]?.d || today()}" max="${today()}"></label>
    <button class="btn primary" id="addOk">${existing ? 'Güncelle' : 'Ekle'}</button>
    <button class="btn" id="addCancel">Vazgeç</button>`;
  const qtyEl = document.getElementById('addQty');
  qtyEl.focus();
  const submit = () => {
    const q = parseNum(qtyEl.value);
    if (!(q >= 0) || !qtyEl.value.trim()) { qtyEl.focus(); return; }
    const d = document.getElementById('addDate').value || today();
    if (existing) setQty(existing, q);
    else state.holdings.push({ symbol: r.symbol, name: r.name, market: r.market, type: r.type, log: [{ d, q }] });
    save();
    box.hidden = true; qInput.value = '';
    render();
    refresh([r.symbol]);
  };
  document.getElementById('addOk').onclick = submit;
  qtyEl.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  document.getElementById('addCancel').onclick = () => { box.hidden = true; };
}

// Adet değişikliği bugünün tarihiyle kaydedilir; böylece geçmiş günler bozulmaz.
function setQty(h, q) {
  const t = today();
  if (qtyAt(h, t) === q) return;
  const i = h.log.findIndex((e) => e.d === t);
  if (i >= 0) h.log[i].q = q; else { h.log.push({ d: t, q }); h.log.sort((a, b) => a.d.localeCompare(b.d)); }
}

const cards = document.getElementById('cards');
cards.addEventListener('change', (e) => {
  const card = e.target.closest('.card');
  const h = state.holdings.find((x) => x.symbol === card?.dataset.sym);
  if (!h) return;
  if (e.target.dataset.act === 'qty') {
    const q = parseNum(e.target.value);
    if (q >= 0) setQty(h, q);
  } else if (e.target.dataset.act === 'since' && e.target.value) {
    // İlk alış tarihini taşı: ondan önceki kayıtlar silinir.
    const d = e.target.value;
    const q0 = h.log[0].q;
    h.log = h.log.filter((x) => x.d > d);
    h.log.unshift({ d, q: q0 });
  }
  save(); render();
});
cards.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.act === 'qty') e.target.blur(); });
cards.addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'remove') return;
  const sym = e.target.closest('.card').dataset.sym;
  if (!confirm(`${short(sym)} portföyden kaldırılsın mı? Geçmiş kayıtları da silinir.`)) return;
  state.holdings = state.holdings.filter((h) => h.symbol !== sym);
  save(); render();
});

// Takvim ipucu
const tip = document.getElementById('tip');
document.getElementById('cal').addEventListener('mousemove', (e) => {
  const d = e.target.closest('[data-tip]');
  if (!d) { tip.hidden = true; return; }
  tip.innerHTML = d.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});
document.getElementById('cal').addEventListener('mouseleave', () => { tip.hidden = true; });

// Ayarlar
document.getElementById('refresh').addEventListener('click', () => refresh(undefined, true));
document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `temettu-yedek-${today()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
document.getElementById('import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.holdings)) throw new Error('geçersiz dosya');
    Object.assign(state, data);
    save(); render(); refresh();
    setStatus(`${data.holdings.length} kalem yüklendi.`);
  } catch (err) { setStatus(`Yedek yüklenemedi: ${err.message}`); }
  e.target.value = '';
});

// ---------- Bulut eşitleme (Supabase, Analiz sitesindeki hesapla) ----------
// Hisseler ve adet geçmişi kullanıcının temettu_state satırında tutulur; en son değişen cihaz kazanır.
const SB_URL = 'https://jqmfvinbzgqyitqquzdc.supabase.co';
const SB_KEY = 'sb_publishable_uw979hCwS6xyLRTexQX55A_ZqgWidDs'; // tarayıcı için herkese açık anahtar; veriyi RLS korur
const sb = window.supabase?.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
let syncUser = null, pulled = false, pushTimer;
const syncBtn = document.getElementById('syncBtn');

function setSync(text, kind = '') {
  syncBtn.textContent = text;
  syncBtn.className = `btn sync ${kind}`;
}

function schedulePush() {
  if (!sb || !syncUser || !pulled) return;
  clearTimeout(pushTimer);
  setSync('Kaydediliyor…');
  pushTimer = setTimeout(push, 800);
}

async function push() {
  if (!state.updatedAt) state.updatedAt = Date.now();
  const { error } = await sb.from('temettu_state').upsert({
    user_id: syncUser.id,
    state: { holdings: state.holdings, updatedAt: state.updatedAt },
    updated_at: new Date(state.updatedAt).toISOString(),
  });
  setSync(error ? 'Eşitlenemedi' : '☁ Eşitlendi', error ? 'err' : 'ok');
  if (error) setStatus(`Bulut eşitleme hatası: ${error.message}`);
}

async function pull() {
  if (!sb || !syncUser) return;
  const { data, error } = await sb.from('temettu_state').select('state').maybeSingle();
  if (error) { setSync('Eşitlenemedi', 'err'); setStatus(`Bulut eşitleme hatası: ${error.message}`); return; }
  const remote = data?.state;
  const firstTime = !pulled;
  pulled = true;
  const localT = state.updatedAt || 0, remoteT = remote?.updatedAt || 0;
  let useRemote = remote && remoteT > localT;
  // Bu cihaz daha önce hiç eşitlenmediyse ve iki tarafta da farklı veri varsa kullanıcıya sor.
  if (firstTime && remote && !state.syncedOnce && state.holdings.length && remote.holdings?.length &&
      JSON.stringify(remote.holdings) !== JSON.stringify(state.holdings)) {
    useRemote = confirm(`Buluttaki portföy (${remote.holdings.length} kalem) ile bu cihazdaki (${state.holdings.length} kalem) farklı.\n\nTamam: buluttakini kullan\nİptal: bu cihazdakini buluta yükle`);
    if (!useRemote) state.updatedAt = Date.now();
  }
  state.syncedOnce = true;
  if (useRemote) {
    state.holdings = remote.holdings || [];
    state.updatedAt = remoteT;
    store.set('temettu.state', state);
    setSync('☁ Eşitlendi', 'ok');
    render();
    refresh();
  } else if (!remote || localT > remoteT || state.updatedAt > remoteT) {
    store.set('temettu.state', state);
    await push();
  } else {
    store.set('temettu.state', state);
    setSync('☁ Eşitlendi', 'ok');
  }
}

function showLogin() {
  const box = document.getElementById('loginForm');
  box.hidden = false;
  box.innerHTML = `<div class="who"><b>Giriş yap</b><div>Analiz sitesindeki hesabınla gir; portföyün telefon ve bilgisayar arasında otomatik eşitlenir.</div></div>
    <label>E-POSTA<input id="lgEmail" type="email" autocomplete="username"></label>
    <label>ŞİFRE<input id="lgPass" type="password" autocomplete="current-password"></label>
    <button class="btn primary" id="lgOk">Giriş</button>
    <button class="btn" id="lgCancel">Vazgeç</button>
    <div class="err" id="lgErr" style="flex-basis:100%"></div>`;
  const go = async () => {
    const email = document.getElementById('lgEmail').value.trim();
    const password = document.getElementById('lgPass').value;
    if (!email || !password) return;
    document.getElementById('lgErr').textContent = 'Giriş yapılıyor…';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { document.getElementById('lgErr').textContent = `Giriş yapılamadı: ${error.message}`; return; }
    box.hidden = true;
  };
  document.getElementById('lgOk').onclick = go;
  document.getElementById('lgPass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  document.getElementById('lgCancel').onclick = () => { box.hidden = true; };
  document.getElementById('lgEmail').focus();
}

if (!sb) {
  setSync('Eşitleme yok', 'err');
} else {
  setSync('Giriş yap');
  syncBtn.addEventListener('click', async () => {
    if (!syncUser) return showLogin();
    if (confirm(`${syncUser.email} hesabından çıkış yapılsın mı? Veriler bu cihazda kalır.`)) await sb.auth.signOut();
  });
  sb.auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    const changed = user?.id !== syncUser?.id;
    syncUser = user;
    if (!user) { pulled = false; setSync('Giriş yap'); return; }
    syncBtn.title = user.email;
    if (changed) setTimeout(pull, 0); // auth olayının içinden doğrudan sorgu atılmaz
  });
  // Sekmeye geri dönüldüğünde diğer cihazdaki değişiklikleri al.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && syncUser) pull(); });
}

// İlk çizim: önce kayıtlı veriyle, sonra güncel veriyle.
render();
refresh();

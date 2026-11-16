'use strict';

// Yerelde (node dev.mjs) /api, GitHub Pages'te Supabase fonksiyonu kullanılır.
const API = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? '/api'
  : 'https://jqmfvinbzgqyitqquzdc.supabase.co/functions/v1/temettu';

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
  { holdings: [], cur: 'USD', filter: 'ALL', chart: 'monthly' },
  store.get('temettu.state', {}),
);
delete state.tax; // eski sürümdeki elle girilen stopaj ayarı artık kullanılmıyor
const cache = Object.assign({ data: {}, fx: null, at: 0 }, store.get('temettu.cache', {}));
const save = () => store.set('temettu.state', state);
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
  const need = force ? symbols : symbols.filter((s) => !cache.data[s] || Date.now() - (cache.data[s].fetchedAt || 0) > CACHE_TTL);
  if (!need.length) return;
  setStatus('Veriler güncelleniyor…');
  try {
    const j = await api({ symbols: need.join(',') }, force);
    const now = Date.now();
    for (const [s, d] of Object.entries(j.data)) cache.data[s] = { ...d, fetchedAt: now };
    if (j.fx?.USDTRY) cache.fx = j.fx.USDTRY;
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

  for (const id of ['filter', 'cur', 'chartMode']) {
    const v = { filter: state.filter, cur: state.cur, chartMode: state.chart }[id];
    document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }
  document.getElementById('eyebrow').textContent = { ALL: 'TEMETTÜ PORTFÖYÜ', US: 'ABD PORTFÖYÜ', TR: 'BIST PORTFÖYÜ' }[state.filter];

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
}

// "12 ayın 4'ü / 6'sı / 12'si dolu"
const suffix = (n) => ({ 0: 'ı', 1: 'i', 2: 'si', 3: 'ü', 4: 'ü', 5: 'i', 6: 'sı', 7: 'si', 8: 'i', 9: 'u', 10: 'u', 11: 'i', 12: 'si' })[n];
function colorOf(h) { return COLORS[state.holdings.indexOf(h) % COLORS.length]; }

// ---------- Grafik ----------
let chart;
function renderChart(hs) {
  const canvas = document.getElementById('chart');
  const note = document.getElementById('chartNote');
  if (typeof Chart === 'undefined') { note.textContent = 'Grafik kütüphanesi yüklenemedi.'; return; }
  const t = today();
  const cur = state.cur;
  const tickFmt = (v) => money(v, cur, Math.abs(v) >= 100 ? 0 : 2);
  let config;

  if (state.chart === 'monthly') {
    document.getElementById('chartTitle').textContent = 'Aylık temettü geliri';
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
    config = {
      type: 'bar',
      data: {
        labels: keys.map((k) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`),
        datasets: [
          { label: 'Alınan', data: keys.map((k) => got[k]), backgroundColor: '#f2c14e', borderRadius: 5, stack: 's' },
          { label: 'Beklenen', data: keys.map((k) => exp[k]), backgroundColor: 'rgba(242,193,78,.28)', borderColor: 'rgba(242,193,78,.6)', borderWidth: 1, borderRadius: 5, stack: 's' },
        ],
      },
    };
    note.textContent = 'Koyu çubuk: ödemesi gerçekleşmiş temettü. Açık çubuk: mevcut adetlerle beklenen. Karışık para birimleri güncel USD/TRY kuruyla çevrilir.';
  } else {
    document.getElementById('chartTitle').textContent = 'Günlük gelişim';
    const firstLog = hs.map((h) => h.log[0]?.d).filter(Boolean).sort()[0] || t;
    let start = firstLog < addDays(t, -1095) ? addDays(t, -1095) : firstLog;
    if (start > addDays(t, -30)) start = addDays(t, -30);
    const labels = [], annual = [], cum = [];
    const rec = hs.flatMap((h) => received(h).map((r) => ({ pay: r.pay, v: toCur(r.value, curOf(h)) }))).sort((a, b) => a.pay.localeCompare(b.pay));
    const evsBy = new Map(hs.map((h) => [h.symbol, events(h).filter((e) => !e.estAmt)]));
    let ri = 0, run = 0;
    for (let d = start; d <= t; d = addDays(d, 1)) {
      while (ri < rec.length && rec[ri].pay <= d) run += rec[ri++].v || 0;
      let a = 0;
      for (const h of hs) { const q = qtyAt(h, d); if (q > 0) a += toCur(q * annualPerShare(evsBy.get(h.symbol), d) * net(h, d), curOf(h)); }
      labels.push(d); annual.push(a); cum.push(run);
    }
    config = {
      type: 'line',
      data: {
        labels: labels.map((d) => new Date(d + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: '2-digit' })),
        datasets: [
          { label: 'Yıllık temettü geliri', data: annual, borderColor: '#f2c14e', backgroundColor: 'rgba(242,193,78,.12)', fill: true, tension: .2, pointRadius: 0, borderWidth: 2, stepped: true },
          { label: 'Toplam alınan', data: cum, borderColor: '#7fd18b', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 2, stepped: true },
        ],
      },
    };
    note.textContent = 'Altın çizgi: o günkü adetlerinizle bir yılda alacağınız net temettü (o güne kadar açıklanan son bir yıllık temettülerle). Yeşil çizgi: bugüne kadar alınan toplam. Adet değiştirdikçe gün gün kaydedilir.';
  }

  config.options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#c7cad1', boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y, cur)}` } },
    },
    scales: {
      x: { stacked: true, ticks: { color: '#8a909b', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
      y: { stacked: config.type === 'bar', beginAtZero: true, ticks: { color: '#8a909b', callback: tickFmt }, grid: { color: 'rgba(255,255,255,.06)' } },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart(canvas, config);
}

// ---------- Etkileşim ----------
function bindSeg(id, key) {
  document.getElementById(id).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    state[key] = v; save(); render();
  });
}
bindSeg('filter', 'filter');
bindSeg('cur', 'cur');
bindSeg('chartMode', 'chart');

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

// İlk çizim: önce kayıtlı veriyle, sonra güncel veriyle.
render();
refresh();

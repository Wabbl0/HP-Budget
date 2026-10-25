'use strict';

const VERSION = '0.1.0';
const STORE_KEY = 'hpbudget.v1';

// Budgets are in cents. "fixed" = bills reserved out of the daily allowance.
const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', emoji: '🛒', budget: 25000, kind: 'flexible' },
  { id: 'food', name: 'Food out', emoji: '🍔', budget: 8000, kind: 'flexible' },
  { id: 'out', name: 'Going out', emoji: '🍺', budget: 10000, kind: 'flexible' },
  { id: 'transport', name: 'Transport', emoji: '🚇', budget: 3000, kind: 'flexible' },
  { id: 'subs', name: 'Subs', emoji: '📱', budget: 10000, kind: 'fixed' },
  { id: 'home', name: 'Home', emoji: '🏠', budget: 0, kind: 'flexible' },
  { id: 'other', name: 'Other', emoji: '✨', budget: 0, kind: 'flexible' },
  { id: 'casino', name: 'Casino', emoji: '🎲', budget: 0, kind: 'flexible' },
  { id: 'rent', name: 'Rent', emoji: '🔑', budget: 40000, kind: 'fixed' },
  { id: 'phone', name: 'Phone+net', emoji: '📶', budget: 5700, kind: 'fixed' },
  { id: 'utilities', name: 'Power+ins', emoji: '⚡', budget: 4400, kind: 'fixed' },
];

const INCOME_SOURCES = [
  { id: 'salary', name: 'Salary', emoji: '💼' },
  { id: 'family', name: 'Family', emoji: '👪' },
  { id: 'kela', name: 'Kela', emoji: '🏛️' },
  { id: 'gift', name: 'Gift', emoji: '🎁' },
  { id: 'income_other', name: 'Other', emoji: '💰' },
];

const TYPE_LABEL = { expense: 'Spend', income: 'Income', refund: 'Refund' };

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const thisMonth = () => today().slice(0, 7);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmt(cents, { sign = false, dec = true } = {}) {
  const neg = cents < 0;
  const a = Math.abs(Math.round(cents));
  const int = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  let s = int + (dec ? ',' + pad(a % 100) : '') + ' €';
  if (neg) s = '-' + s;
  else if (sign) s = '+' + s;
  return s;
}

function parseAmount(str) {
  const n = parseFloat(String(str).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function monthLabel(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function shiftMonth(mk, delta) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function dayLabel(iso) {
  if (iso === today()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === isoDate(y)) return 'Yesterday';
  const [Y, M, D] = iso.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---------- state ----------
function defaultState() {
  return {
    v: 1,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    tx: [],
    settings: { sound: true, startHP: null },
    use: {},
    lastBackup: null,
  };
}

function migrate(s) {
  const d = defaultState();
  return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* fall through to defaults */ }
  return defaultState();
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('⚠️ Could not save. Export a backup now!', { kind: 'bad' });
  }
}

const expenseCat = (id) => state.categories.find((c) => c.id === id);
const anyCat = (id) => expenseCat(id) || INCOME_SOURCES.find((c) => c.id === id) || { id, name: 'Unknown', emoji: '❔', budget: 0 };

// ---------- money math ----------
function stats(mk = thisMonth()) {
  const byCat = {};
  let spent = 0, income = 0, refunds = 0;
  for (const t of state.tx) {
    if (!t.date.startsWith(mk)) continue;
    if (t.type === 'expense') { spent += t.amount; byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount; }
    else if (t.type === 'refund') { refunds += t.amount; byCat[t.categoryId] = (byCat[t.categoryId] || 0) - t.amount; }
    else if (t.type === 'income') income += t.amount;
  }
  const planned = state.categories.reduce((s, c) => s + c.budget, 0);
  const base = state.settings.startHP == null ? planned : state.settings.startHP;
  const max = base + income;
  const remaining = max - spent + refunds;
  return { mk, byCat, spent, income, refunds, planned, base, max, remaining };
}

// Daily allowance: what's left after reserving unpaid fixed bills, spread over the days left (today included).
function daily(s) {
  const now = new Date();
  const t = today();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - now.getDate() + 1;
  let unpaidFixed = 0;
  for (const c of state.categories) if (c.kind === 'fixed') unpaidFixed += Math.max(0, c.budget - (s.byCat[c.id] || 0));
  let spentToday = 0;
  for (const x of state.tx) {
    if (x.date !== t) continue;
    const c = expenseCat(x.categoryId);
    if (!c || c.kind !== 'flexible') continue;
    if (x.type === 'expense') spentToday += x.amount;
    else if (x.type === 'refund') spentToday -= x.amount;
  }
  const pool = s.remaining + spentToday - unpaidFixed;
  const perDay = Math.floor(pool / daysLeft);
  return { perDay, todayLeft: perDay - spentToday, daysLeft, unpaidFixed };
}

const pctOf = (spent, budget) => (budget > 0 ? (spent / budget) * 100 : spent > 0 ? Infinity : 0);
const barClass = (p) => (p > 100 ? 'over' : p >= 80 ? 'warn' : '');

// ---------- sound (synthesized 8-bit) ----------
let ac = null;
function audio() {
  if (!state.settings.sound) return null;
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { return null; }
  return ac;
}

function tone(freq, dur, { type = 'square', vol = 0.06, to = null, at = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, vol = 0.12) {
  const a = audio();
  if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = vol;
  src.buffer = buf;
  src.connect(g).connect(a.destination);
  src.start();
}

const sfx = {
  key: () => tone(880, 0.035, { vol: 0.025 }),
  back: () => tone(440, 0.04, { vol: 0.025 }),
  err: () => tone(160, 0.18, { type: 'sawtooth', vol: 0.05, to: 90 }),
  hit: (cents) => {
    const big = cents >= 5000;
    noise(big ? 0.25 : 0.12, big ? 0.18 : 0.1);
    tone(big ? 220 : 330, big ? 0.35 : 0.18, { vol: 0.07, to: 60 });
  },
  coin: () => {
    tone(988, 0.08, { vol: 0.05 });
    tone(1319, 0.3, { vol: 0.05, at: 0.08 });
  },
  heal: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.07, at: i * 0.06 }));
  },
  warn: () => {
    tone(600, 0.1, { vol: 0.05, at: 0 });
    tone(600, 0.1, { vol: 0.05, at: 0.15 });
  },
};

// ---------- effects ----------
const fxLayer = $('#fx');

function flash(kind) {
  const f = $('#flash');
  f.className = '';
  void f.offsetWidth;
  f.className = kind;
}

function shake(px) {
  if (reducedMotion()) return;
  const app = $('#app');
  app.style.setProperty('--s', px + 'px');
  app.classList.remove('shake');
  void app.offsetWidth;
  app.classList.add('shake');
}

function floatText(text, cls, x, y, size) {
  const el = document.createElement('div');
  el.className = 'dmg ' + cls;
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.fontSize = size + 'px';
  fxLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function banner(text, color) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  if (color) el.style.color = color;
  fxLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function coins(fromEl, n = 14) {
  if (reducedMotion()) return;
  const r = fromEl.getBoundingClientRect();
  const hp = $('#hp').getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'coin';
    const x = r.left + r.width / 2 + (Math.random() - 0.5) * r.width * 0.6;
    const y = r.top + r.height / 2;
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    const tx = hp.left + Math.random() * hp.width;
    const ty = hp.top + hp.height / 2;
    c.style.setProperty('--dx', tx - x + 'px');
    c.style.setProperty('--dy', ty - y + 'px');
    c.style.animationDelay = i * 25 + 'ms';
    fxLayer.appendChild(c);
    c.addEventListener('animationend', () => c.remove());
  }
}

function hpAnchor() {
  const r = $('#hp').getBoundingClientRect();
  return { x: r.left + r.width * (0.35 + Math.random() * 0.3), y: r.bottom + 6 };
}

function playFx(type, cents, btn) {
  const { x, y } = hpAnchor();
  const size = Math.min(34, 16 + Math.log10(Math.max(cents, 100) / 100) * 9);
  if (type === 'expense') {
    const crit = cents >= 5000;
    floatText('-' + fmt(cents), crit ? 'crit' : '', x, y, crit ? size + 4 : size);
    flash('hit');
    shake(Math.min(14, 3 + cents / 1500));
    sfx.hit(cents);
    if (crit) banner(cents >= 20000 ? 'MEGA HIT!' : 'CRITICAL!');
  } else if (type === 'income') {
    floatText('+' + fmt(cents), 'heal', x, y, size);
    flash('heal');
    coins(btn || $('#amount'));
    sfx.coin();
    if (cents >= 20000) banner('LOOT!', 'var(--heal)');
  } else {
    floatText('+' + fmt(cents), 'refund', x, y, size);
    flash('heal');
    coins(btn || $('#amount'), 8);
    sfx.heal();
  }
}

// ---------- toasts ----------
function toast(msg, { kind = '', actions = [], ms = 3500 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<div class="msg">${msg}</div>`;
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', () => { a.run(); close(); });
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 2) box.firstChild.remove();
  let timer = setTimeout(close, ms);
  function close() {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }
  return close;
}

// ---------- HUD ----------
let lastPct = null;

function renderHUD() {
  const s = stats();
  const d = daily(s);
  const pct = s.max > 0 ? Math.max(0, Math.min(100, (s.remaining / s.max) * 100)) : 0;
  const hud = $('#hud');
  const hp = $('#hp');

  $('#hp-value').textContent = fmt(s.remaining);
  $('#hp-max').textContent = '/' + fmt(s.max, { dec: false });
  hud.classList.toggle('over', s.remaining < 0);
  hud.classList.toggle('mid', pct <= 50 && pct > 20);
  hud.classList.toggle('low', pct <= 20);

  const healing = lastPct !== null && pct > lastPct;
  hp.classList.toggle('healing', healing);
  $('#hp-fill').style.width = pct + '%';
  $('#hp-ghost').style.width = pct + '%';
  lastPct = pct;
  document.documentElement.style.setProperty('--hud-h', hud.getBoundingClientRect().bottom + 'px');

  const left = d.todayLeft;
  $('#hud-sub').innerHTML =
    `<span>TODAY <b class="${left < 0 ? 'neg' : ''}">${fmt(left, { dec: left % 100 !== 0 })}</b></span>` +
    `<span>${fmt(Math.max(0, d.perDay), { dec: false })}/DAY · ${d.daysLeft}D LEFT</span>`;
}

// ---------- log view ----------
let entry = '';
let mode = 'expense';
let catOrder = orderCategories();

// Sorted by use once per launch so buttons don't jump around mid-session.
function orderCategories() {
  return state.categories
    .map((c, i) => ({ id: c.id, i }))
    .sort((a, b) => (state.use[b.id] || 0) - (state.use[a.id] || 0) || a.i - b.i)
    .map((x) => x.id);
}

function renderAmount() {
  const el = $('#amount');
  const text = entry || '0';
  $('#amount-num').textContent = text;
  $('#amount-sign').textContent = entry ? (mode === 'expense' ? '-' : '+') : '';
  el.classList.toggle('empty', !entry);
  el.classList.remove('mode-income', 'mode-refund');
  if (mode !== 'expense') el.classList.add('mode-' + mode);
  const len = text.length + (entry ? 3 : 2);
  el.style.setProperty('--amt-size', Math.min(56, Math.floor(620 / len)) + 'px');
}

function setMode(m) {
  mode = m;
  for (const b of $('#modes').children) b.classList.toggle('on', b.dataset.mode === m);
  renderCats();
  renderAmount();
}

function renderCats() {
  const s = stats();
  const box = $('#cats');
  const list = mode === 'income'
    ? INCOME_SOURCES
    : [...catOrder.map(expenseCat).filter(Boolean), ...state.categories.filter((c) => !catOrder.includes(c.id))];
  box.innerHTML = list.slice(0, 12).map((c) => {
    let bar = '';
    if (mode !== 'income' && c.budget > 0) {
      const p = pctOf(s.byCat[c.id] || 0, c.budget);
      bar = `<i class="use ${barClass(p)}" style="width:${Math.min(100, Math.max(0, p))}%"></i>`;
    }
    return `<button class="cat" data-cat="${c.id}"><span class="emo">${c.emoji}</span><span class="nm">${esc(c.name)}</span>${bar}</button>`;
  }).join('');
}

function press(k) {
  if (k === 'back') {
    entry = entry.slice(0, -1);
    sfx.back();
  } else if (k === ',') {
    if (entry.includes(',')) return nope();
    entry = (entry || '0') + ',';
    sfx.key();
  } else {
    const [int, dec] = entry.split(',');
    if (dec !== undefined ? dec.length >= 2 : (int || '').length >= 6) return nope();
    entry = entry === '0' ? k : entry + k;
    sfx.key();
  }
  renderAmount();
  const el = $('#amount');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function nope() {
  const el = $('#amount');
  el.classList.remove('nope');
  void el.offsetWidth;
  el.classList.add('nope');
  sfx.err();
}

function commit(catId, btn) {
  const amount = parseAmount(entry);
  if (!(amount > 0)) return nope();
  const before = stats();
  const tx = { id: uid(), date: today(), ts: Date.now(), amount, type: mode, categoryId: catId, note: '' };
  state.tx.push(tx);
  state.use[catId] = (state.use[catId] || 0) + 1;
  save();

  const type = mode;
  entry = '';
  setMode('expense');
  renderHUD();
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
  playFx(type, amount, btn);

  const c = anyCat(catId);
  toast(`${c.emoji} ${type === 'expense' ? '-' : '+'}${fmt(amount)} · ${esc(c.name)}`, {
    ms: 5000,
    actions: [
      { label: 'NOTE', run: () => editTx(tx.id) },
      { label: 'UNDO', run: () => undo(tx.id) },
    ],
  });
  if (type === 'expense') setTimeout(() => budgetWarning(catId, before), 700);
}

function budgetWarning(catId, before) {
  const c = expenseCat(catId);
  if (!c || c.budget <= 0) return;
  const after = stats();
  const p0 = pctOf(before.byCat[catId] || 0, c.budget);
  const p1 = pctOf(after.byCat[catId] || 0, c.budget);
  if (p0 <= 100 && p1 > 100) {
    toast(`💀 ${esc(c.name)} is over budget (${Math.round(p1)}%)`, { kind: 'bad' });
    sfx.warn();
  } else if (p0 < 80 && p1 >= 80) {
    toast(`⚠️ ${esc(c.name)} at ${Math.round(p1)}% of budget`, { kind: 'warn' });
    sfx.warn();
  }
}

function undo(id) {
  state.tx = state.tx.filter((t) => t.id !== id);
  save();
  renderAll();
}

// ---------- history view ----------
let histMonth = thisMonth();
let histFilter = 'all';

function renderHistory() {
  const v = $('#view-history');
  const used = new Set(state.tx.filter((t) => t.date.startsWith(histMonth)).map((t) => t.categoryId));
  const filterCats = [...state.categories, ...INCOME_SOURCES].filter((c) => used.has(c.id));
  if (histFilter !== 'all' && !used.has(histFilter)) histFilter = 'all';

  const items = state.tx
    .filter((t) => t.date.startsWith(histMonth) && (histFilter === 'all' || t.categoryId === histFilter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);

  let html = `
    <div class="vh">
      <h2>History</h2>
      <div class="monthnav">
        <button data-act="hprev" aria-label="Previous month">‹</button>
        <span>${monthLabel(histMonth)}</span>
        <button data-act="hnext" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="chips">
      <button class="chip ${histFilter === 'all' ? 'on' : ''}" data-filter="all">All</button>
      ${filterCats.map((c) => `<button class="chip ${histFilter === c.id ? 'on' : ''}" data-filter="${c.id}">${c.emoji} ${esc(c.name)}</button>`).join('')}
    </div>`;

  if (!items.length) {
    html += `<p class="empty-msg">No entries yet.<br>Go to ⚔️ Log and take some damage.</p>`;
  } else {
    let curDay = null;
    for (const t of items) {
      if (t.date !== curDay) {
        curDay = t.date;
        const net = items.filter((x) => x.date === curDay).reduce((s, x) => s + (x.type === 'expense' ? -x.amount : x.amount), 0);
        html += `<div class="day"><span>${dayLabel(curDay)}</span><span>${fmt(net, { sign: true })}</span></div>`;
      }
      const c = anyCat(t.categoryId);
      const sub = t.note ? esc(t.note) : TYPE_LABEL[t.type];
      html += `
        <button class="row" data-tx="${t.id}">
          <span class="emo">${c.emoji}</span>
          <span class="info"><div class="t1">${esc(c.name)}</div><div class="t2">${sub}</div></span>
          <span class="amt ${t.type}">${t.type === 'expense' ? '-' : '+'}${fmt(t.amount)}</span>
        </button>`;
    }
  }
  v.innerHTML = html;
}

// ---------- budget view ----------
let budgetMonth = thisMonth();

function renderBudget() {
  const v = $('#view-budget');
  const s = stats(budgetMonth);
  const rows = (kind) => state.categories.filter((c) => c.kind === kind).map((c) => {
    const spent = s.byCat[c.id] || 0;
    const p = pctOf(spent, c.budget);
    return `
      <button class="brow" data-edit-cat="${c.id}">
        <div class="top">
          <span class="name">${c.emoji} ${esc(c.name)}</span>
          <span class="nums">${fmt(spent, { dec: false })} / ${fmt(c.budget, { dec: false })}</span>
        </div>
        <div class="bar"><i class="${barClass(p)}" style="width:${Math.min(100, Math.max(0, p === Infinity ? 100 : p))}%"></i></div>
      </button>`;
  }).join('');

  v.innerHTML = `
    <div class="vh">
      <h2>Budget</h2>
      <div class="monthnav">
        <button data-act="bprev" aria-label="Previous month">‹</button>
        <span>${monthLabel(budgetMonth)}</span>
        <button data-act="bnext" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="card">
      <div class="kv"><span>Planned budget</span><span>${fmt(s.planned)}</span></div>
      ${s.base !== s.planned ? `<div class="kv"><span>Month starts at</span><span>${fmt(s.base)}</span></div>` : ''}
      <div class="kv"><span>+ Income</span><span style="color:var(--hp)">${fmt(s.income)}</span></div>
      <div class="kv"><span>+ Refunds</span><span style="color:var(--refund)">${fmt(s.refunds)}</span></div>
      <div class="kv"><span>− Spent</span><span style="color:var(--hp-low)">${fmt(s.spent)}</span></div>
      <div class="kv total"><span>HP left</span><span>${fmt(s.remaining)}</span></div>
    </div>
    <div class="card"><h2 class="game" style="font-size:14px;letter-spacing:.06em;margin:0 0 4px;color:var(--muted)">DAILY</h2>${rows('flexible')}</div>
    <div class="card"><h2 class="game" style="font-size:14px;letter-spacing:.06em;margin:0 0 4px;color:var(--muted)">BILLS</h2>${rows('fixed')}</div>
    <button class="btn ghost" data-act="addcat">+ Add category</button>
    <p class="note" style="margin-top:12px">Tap a category to change its budget. Bills are set aside before your daily allowance is worked out.</p>`;
}

// ---------- settings view ----------
function backupDue() {
  if (!state.tx.length) return false;
  return !state.lastBackup || Date.now() - state.lastBackup > 7 * 864e5;
}

function renderSettings() {
  const v = $('#view-settings');
  const last = state.lastBackup ? new Date(state.lastBackup).toLocaleDateString('en-GB') : 'never';
  const startHP = state.settings.startHP;
  v.innerHTML = `
    <div class="vh"><h2>Settings</h2></div>
    <div class="card">
      <div class="setting">
        <label>Sound effects<small>8-bit blips and hits</small></label>
        <button class="switch ${state.settings.sound ? 'on' : ''}" data-act="sound" aria-label="Toggle sound"></button>
      </div>
      <div class="setting">
        <label>Month starts at<small>${startHP == null ? 'Planned budget: ' + fmt(stats().planned, { dec: false }) : 'Custom amount'}. Income adds on top.</small></label>
        <button class="chip" data-act="starthp">${startHP == null ? 'Auto' : fmt(startHP, { dec: false })}</button>
      </div>
    </div>
    <div class="card">
      <div class="setting" style="padding-top:0">
        <label>Backup<small>Last backup: ${last}</small></label>
      </div>
      ${backupDue() ? '<p class="note warn">Data lives only on this phone. Export a backup weekly (save it to Files or iCloud Drive).</p>' : ''}
      <button class="btn primary" data-act="export">Export backup</button>
      <button class="btn" data-act="import">Import backup</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>
    <div class="card">
      <button class="btn danger" data-act="wipe" style="margin-top:0">Erase all data</button>
    </div>
    <p class="note" style="text-align:center">HP Budget v${VERSION} · ${state.tx.length} entries</p>`;
}

async function exportBackup() {
  const json = JSON.stringify({ app: 'hp-budget', exportedAt: new Date().toISOString(), ...state }, null, 2);
  const name = `hp-budget-${today()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    state.lastBackup = Date.now();
    save();
    renderAll();
    toast('💾 Backup exported');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Export failed: ' + esc(e.message), { kind: 'bad' });
  }
}

function importBackup(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.tx) || !Array.isArray(data.categories)) throw new Error('Not an HP Budget backup');
      if (!confirm(`Replace current data with backup (${data.tx.length} entries)?`)) return;
      delete data.app;
      delete data.exportedAt;
      state = migrate(data);
      save();
      catOrder = orderCategories();
      renderAll();
      toast('✅ Backup restored');
    } catch (e) {
      toast('Import failed: ' + esc(e.message), { kind: 'bad' });
    }
  };
  r.readAsText(file);
}

// ---------- sheets ----------
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
  return $('#sheet-body');
}

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  document.activeElement && document.activeElement.blur();
}

function catOptions(type, selected) {
  const list = type === 'income' ? INCOME_SOURCES : state.categories;
  return list.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.emoji} ${esc(c.name)}</option>`).join('');
}

function editTx(id) {
  const t = state.tx.find((x) => x.id === id);
  if (!t) return;
  let type = t.type;
  const body = openSheet(`
    <h3>Edit entry</h3>
    <div class="field"><span>Type</span>
      <div class="seg" id="e-type">
        ${['expense', 'income', 'refund'].map((k) => `<button data-type="${k}" class="${k === type ? 'on' : ''}">${TYPE_LABEL[k]}</button>`).join('')}
      </div>
    </div>
    <label class="field"><span>Amount (€)</span><input id="e-amount" inputmode="decimal" value="${(t.amount / 100).toFixed(2).replace('.', ',')}"></label>
    <label class="field"><span>Category</span><select id="e-cat">${catOptions(type, t.categoryId)}</select></label>
    <label class="field"><span>Date</span><input id="e-date" type="date" value="${t.date}"></label>
    <label class="field"><span>Note / merchant</span><input id="e-note" maxlength="80" value="${esc(t.note || '')}" placeholder="e.g. Alepa"></label>
    <div class="btnrow">
      <button class="btn danger" id="e-del">Delete</button>
      <button class="btn primary" id="e-save">Save</button>
    </div>
    <button class="btn ghost" id="e-cancel">Cancel</button>`);

  $('#e-type', body).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const was = type;
    type = b.dataset.type;
    for (const x of $('#e-type', body).children) x.classList.toggle('on', x === b);
    if ((was === 'income') !== (type === 'income')) $('#e-cat', body).innerHTML = catOptions(type);
  });
  $('#e-cancel', body).addEventListener('click', closeSheet);
  $('#e-del', body).addEventListener('click', () => {
    if (!confirm('Delete this entry?')) return;
    state.tx = state.tx.filter((x) => x.id !== id);
    save();
    closeSheet();
    renderAll();
  });
  $('#e-save', body).addEventListener('click', () => {
    const amount = parseAmount($('#e-amount', body).value);
    const date = $('#e-date', body).value;
    if (!(amount > 0)) return toast('Enter an amount above 0', { kind: 'warn' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Pick a date', { kind: 'warn' });
    Object.assign(t, { type, amount, date, categoryId: $('#e-cat', body).value, note: $('#e-note', body).value.trim() });
    save();
    closeSheet();
    renderAll();
  });
}

function editCategory(id) {
  const isNew = !id;
  const c = isNew ? { id: 'c' + Date.now().toString(36), name: '', emoji: '🏷️', budget: 0, kind: 'flexible' } : expenseCat(id);
  if (!c) return;
  const body = openSheet(`
    <h3>${isNew ? 'New category' : 'Edit category'}</h3>
    <div class="btnrow">
      <label class="field"><span>Emoji</span><input id="c-emoji" maxlength="4" value="${esc(c.emoji)}"></label>
      <label class="field"><span>Name</span><input id="c-name" maxlength="14" value="${esc(c.name)}"></label>
    </div>
    <label class="field"><span>Monthly budget (€)</span><input id="c-budget" inputmode="decimal" value="${(c.budget / 100).toFixed(0)}"></label>
    <label class="field"><span>Type</span>
      <select id="c-kind">
        <option value="flexible" ${c.kind === 'flexible' ? 'selected' : ''}>Daily spending</option>
        <option value="fixed" ${c.kind === 'fixed' ? 'selected' : ''}>Bill (set aside)</option>
      </select>
    </label>
    <button class="btn primary" id="c-save">Save</button>
    <button class="btn ghost" id="c-cancel">Cancel</button>`);
  $('#c-cancel', body).addEventListener('click', closeSheet);
  $('#c-save', body).addEventListener('click', () => {
    const budget = parseAmount($('#c-budget', body).value || '0');
    const name = $('#c-name', body).value.trim();
    if (!name) return toast('Give it a name', { kind: 'warn' });
    if (!(budget >= 0)) return toast('Budget must be a number', { kind: 'warn' });
    Object.assign(c, { name, budget, emoji: $('#c-emoji', body).value.trim() || '🏷️', kind: $('#c-kind', body).value });
    if (isNew) state.categories.push(c);
    save();
    closeSheet();
    renderAll();
  });
}

function editStartHP() {
  const cur = state.settings.startHP;
  const body = openSheet(`
    <h3>Month starts at</h3>
    <p class="note">Leave empty to start each month at your planned budget (sum of all categories). Set 0 if you'd rather fill HP only with the income you log.</p>
    <label class="field"><span>Amount (€)</span><input id="s-hp" inputmode="decimal" value="${cur == null ? '' : (cur / 100).toFixed(0)}" placeholder="Auto"></label>
    <button class="btn primary" id="s-save">Save</button>
    <button class="btn ghost" id="s-cancel">Cancel</button>`);
  $('#s-cancel', body).addEventListener('click', closeSheet);
  $('#s-save', body).addEventListener('click', () => {
    const raw = $('#s-hp', body).value.trim();
    const v = raw === '' ? null : parseAmount(raw);
    if (v !== null && !(v >= 0)) return toast('Enter a number', { kind: 'warn' });
    state.settings.startHP = v;
    save();
    closeSheet();
    renderAll();
  });
}

// ---------- navigation & render ----------
let view = 'log';

function showView(name) {
  view = name;
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('active', s.id === 'view-' + name);
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.view === name);
  renderView();
}

function renderView() {
  if (view === 'log') { renderCats(); renderAmount(); }
  else if (view === 'history') renderHistory();
  else if (view === 'budget') renderBudget();
  else if (view === 'settings') renderSettings();
}

function renderAll() {
  renderHUD();
  renderView();
  $('#backup-badge').hidden = !backupDue();
}

// ---------- events ----------
const keypad = $('#keypad');
let backTimer = null;
// iOS Safari has no vibration API; toggling a native <input switch> is the only way to get a haptic tick.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS) {
  for (const k of keypad.querySelectorAll('.key')) {
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.setAttribute('switch', '');
    sw.className = 'haptic';
    sw.tabIndex = -1;
    sw.setAttribute('aria-hidden', 'true');
    k.appendChild(sw);
  }
}
keypad.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-k]');
  if (!b) return;
  b.classList.add('down');
  press(b.dataset.k);
  if (b.dataset.k === 'back') {
    backTimer = setTimeout(() => { entry = ''; renderAmount(); sfx.err(); }, 450);
  }
});
const keyUp = () => {
  clearTimeout(backTimer);
  for (const b of keypad.querySelectorAll('.down')) b.classList.remove('down');
};
keypad.addEventListener('pointerup', keyUp);
keypad.addEventListener('pointercancel', keyUp);
keypad.addEventListener('pointerleave', keyUp);

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (b) commit(b.dataset.cat, b);
});

$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setMode(b.dataset.mode);
  sfx.key();
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) showView(b.dataset.view);
});

$('#sheet-backdrop').addEventListener('click', closeSheet);

$('#view-history').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tx]');
  if (t) return editTx(t.dataset.tx);
  const f = e.target.closest('[data-filter]');
  if (f) { histFilter = f.dataset.filter; return renderHistory(); }
  const a = e.target.closest('[data-act]');
  if (a) { histMonth = shiftMonth(histMonth, a.dataset.act === 'hprev' ? -1 : 1); renderHistory(); }
});

$('#view-budget').addEventListener('click', (e) => {
  const c = e.target.closest('[data-edit-cat]');
  if (c) return editCategory(c.dataset.editCat);
  const a = e.target.closest('[data-act]');
  if (!a) return;
  if (a.dataset.act === 'addcat') return editCategory(null);
  budgetMonth = shiftMonth(budgetMonth, a.dataset.act === 'bprev' ? -1 : 1);
  renderBudget();
});

$('#view-settings').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'sound') {
    state.settings.sound = !state.settings.sound;
    save();
    renderSettings();
    sfx.coin();
  } else if (act === 'starthp') editStartHP();
  else if (act === 'export') exportBackup();
  else if (act === 'import') $('#import-file').click();
  else if (act === 'wipe') {
    if (!confirm('Erase ALL entries and settings? Export a backup first!')) return;
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    state = defaultState();
    save();
    catOrder = orderCategories();
    renderAll();
    toast('Data erased');
  }
});

$('#view-settings').addEventListener('change', (e) => {
  if (e.target.id === 'import-file' && e.target.files[0]) importBackup(e.target.files[0]);
});

// Refresh day/month numbers when returning to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderAll();
});

// ---------- boot ----------
renderAll();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

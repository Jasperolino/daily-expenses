'use strict';
const CFG = window.APP_CONFIG || {};

/* ---------- Storage ---------- */
const CATEGORIES = [
  ['Food', '🍔'], ['Groceries', '🛒'], ['Transport', '🚌'], ['Bills', '💡'], ['Load & Internet', '📶'],
  ['Health', '💊'], ['Shopping', '🛍️'], ['Fun', '🎬'], ['Others', '✏️'],
];
const PAYMENTS = ['Cash', 'GCash', 'Maya', 'Card', 'Bank'];
const catEmoji = Object.fromEntries(CATEGORIES);

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let expenses = load('expenses', []);   // {id, amount, cat, other, pay, note, date, ts}
let noSpend = load('noSpend', []);     // ['YYYY-MM-DD']
let outbox = load('outbox', []);       // pending Google Sheets changes: {op, data}
let settings = Object.assign({
  reminderTime: '20:00', warningTime: '23:00', currency: '₱', budget: 0,
  firstDay: null, lastReminded: null, lastFinalWarned: null, lastDialog: null,
  userId: null, name: '', email: '', emailReminders: true, connected: false,
  sheetUrl: null, webAppUrl: '', lastSync: null, lastPay: 'Cash', v: 2,
}, load('settings', {}));
if (settings.currency === '$') settings.currency = '₱';   // migrate from the first version
expenses.forEach(e => { if (e.cat === 'Other') e.cat = 'Others'; });

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
const prettyDay = (k, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  parseDay(k).toLocaleDateString('en-PH', opts);
const minutesOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const monthOf = k => k.slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return dayKey(d).slice(0, 7); };
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

if (!settings.firstDay) settings.firstDay = dayKey();
save('settings', settings);

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const money = n => settings.currency + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyShort = n => settings.currency + Math.round(n).toLocaleString('en-PH');
const forDay = k => expenses.filter(e => e.date === k);
const totalFor = k => forDay(k).reduce((s, e) => s + e.amount, 0);
const monthTotal = ym => expenses.filter(e => monthOf(e.date) === ym).reduce((s, e) => s + e.amount, 0);
const isLogged = k => noSpend.includes(k) || expenses.some(e => e.date === k);
const label = e => (e.cat === 'Others' && e.other) ? e.other : e.cat;
const emojiOf = e => catEmoji[e.cat] || '✏️';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
const webAppUrl = () => (CFG.SHEETS_WEBAPP_URL || settings.webAppUrl || '').trim();

function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.classList.add('hidden'); action.fn(); };
  t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), action ? 5000 : 2600);
}

function missedDays() {
  const out = []; const today = dayKey();
  for (let i = 1; i <= 14; i++) {
    const k = addDays(today, -i);
    if (k < settings.firstDay) break;
    if (!isLogged(k)) out.push(k);
  }
  return out;
}

function streak() {
  let k = dayKey(); let n = 0;
  if (!isLogged(k)) k = addDays(k, -1);
  while (isLogged(k) && k >= settings.firstDay) { n++; k = addDays(k, -1); }
  return n;
}

/* ---------- Form state ---------- */
let selectedCat = 'Food';
let selectedPay = settings.lastPay || 'Cash';
let editingId = null;
let viewMonth = monthOf(dayKey());

function renderChips() {
  $('categoryChips').innerHTML = CATEGORIES.map(([name, emo]) =>
    `<button type="button" class="chip ${name === selectedCat ? 'active' : ''}" data-cat="${esc(name)}">${emo} ${esc(name)}</button>`).join('');
  $('payChips').innerHTML = PAYMENTS.map(p =>
    `<button type="button" class="chip ${p === selectedPay ? 'active' : ''}" data-pay="${p}">${p}</button>`).join('');
  $('otherWrap').classList.toggle('hidden', selectedCat !== 'Others');
  const recentOthers = [...new Set(expenses.filter(e => e.cat === 'Others' && e.other).sort((a, b) => b.ts - a.ts).map(e => e.other))].slice(0, 15);
  $('otherList').innerHTML = recentOthers.map(o => `<option value="${esc(o)}">`).join('');
}

function resetForm() {
  editingId = null;
  $('amount').value = ''; $('note').value = ''; $('other').value = '';
  $('date').value = dayKey();
  $('submitBtn').textContent = 'Add expense';
  $('editTitle').classList.add('hidden'); $('cancelEdit').classList.add('hidden');
  renderChips(); renderToday();
}

function startEdit(id) {
  const e = expenses.find(x => x.id === id); if (!e) return;
  editingId = id;
  selectedCat = catEmoji[e.cat] ? e.cat : 'Others';
  selectedPay = e.pay || selectedPay;
  $('amount').value = e.amount; $('date').value = e.date;
  $('other').value = e.other || (catEmoji[e.cat] ? '' : e.cat);
  $('note').value = e.note || '';
  $('submitBtn').textContent = 'Save changes';
  $('editTitle').classList.remove('hidden'); $('cancelEdit').classList.remove('hidden');
  setView('today'); renderChips(); renderToday();
  $('amount').focus();
}

/* ---------- Rendering ---------- */
function renderHeader() {
  const today = dayKey();
  $('todayLabel').textContent = prettyDay(today, { weekday: 'long', month: 'long', day: 'numeric' });
  $('todayTotal').textContent = money(totalFor(today));
  $('streak').textContent = `🔥 ${streak()}`;
  $('currencySign').textContent = settings.currency;

  const box = $('budgetBox');
  if (settings.budget > 0) {
    const spent = monthTotal(monthOf(today));
    const pct = spent / settings.budget;
    box.classList.remove('hidden');
    box.classList.toggle('near', pct >= 0.8 && pct < 1);
    box.classList.toggle('over', pct >= 1);
    $('budgetLabel').textContent = `${moneyShort(spent)} of ${moneyShort(settings.budget)} this month`;
    $('budgetLeft').textContent = pct >= 1 ? `${moneyShort(spent - settings.budget)} over!` : `${moneyShort(settings.budget - spent)} left`;
    $('budgetFill').style.width = Math.min(100, pct * 100) + '%';
  } else box.classList.add('hidden');
}

function renderToday() {
  renderHeader();
  const today = dayKey();
  const items = forDay(today).sort((a, b) => b.ts - a.ts);
  const list = $('todayList');
  if (items.length) list.innerHTML = items.map(itemHTML).join('');
  else if (noSpend.includes(today)) list.innerHTML = `<li class="nospend">✅ Marked as a no-spend day. Nice!</li>`;
  else list.innerHTML = `<li class="empty">Nothing logged yet today. Add what you spent, or tap “I spent nothing today”.${
    expenses.length ? '' : '<br><br>New here? <a href="guide.html">📖 See how the app works</a>'}</li>`;
  $('noSpendBtn').classList.toggle('hidden', items.length > 0 || noSpend.includes(today));
  document.querySelector('.hint').classList.toggle('hidden', !items.length);
}

function itemHTML(e) {
  const time = new Date(e.ts).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  const sub = [e.pay, e.note, time].filter(Boolean).map(esc).join(' · ');
  return `<li data-edit="${e.id}" class="${e.id === editingId ? 'editing' : ''}">
    <span class="emoji">${emojiOf(e)}</span>
    <div class="info"><div>${esc(label(e))}</div><div>${sub}</div></div>
    <span class="amt">${money(e.amount)}</span>
    <button class="del" data-del="${e.id}" aria-label="Delete">✕</button>
  </li>`;
}

/* Donut chart: one fixed color per category (validated palette), segments drawn in the
   fixed category order so neighbouring colors are always easy to tell apart. */
const CAT_COLORS = {
  'Food': '#2a78d6', 'Groceries': '#eb6834', 'Transport': '#1baf7a', 'Bills': '#eda100',
  'Load & Internet': '#e87ba4', 'Health': '#008300', 'Shopping': '#6250d6', 'Fun': '#e34948', 'Others': '#898781',
};
let focusCat = null;

function renderDonut(byCat, total) {
  const svg = $('donut');
  const R = 85, C = 2 * Math.PI * R, W = 20, SPACE = 8;   // W = stroke width (round caps add W/2 each end)
  const segs = CATEGORIES.map(([name]) => name).filter(n => byCat[n]);
  let html = `<circle class="track" cx="110" cy="110" r="${R}"></circle>`;
  if (segs.length === 1) {
    const n = segs[0];
    html += `<circle class="seg ${focusCat === n ? 'on' : ''}" data-focus="${esc(n)}" cx="110" cy="110" r="${R}" stroke="${CAT_COLORS[n]}" style="stroke-linecap:butt"><title>${esc(n)}: ${money(byCat[n].amt)} (100%)</title></circle>`;
  } else {
    // Every slice reserves room for its rounded caps + a gap, so even a 1% slice stays a separate dot.
    const free = C - segs.length * (W + SPACE);
    let offset = 0;
    segs.forEach(n => {
      const frac = byCat[n].amt / total;
      const len = Math.max(0.01, frac * free);
      html += `<circle class="seg ${focusCat === n ? 'on' : ''}" data-focus="${esc(n)}" cx="110" cy="110" r="${R}" stroke="${CAT_COLORS[n]}"
        stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-(offset + (W + SPACE) / 2)).toFixed(2)}"
        transform="rotate(-90 110 110)"><title>${esc(n)}: ${money(byCat[n].amt)} (${Math.round(frac * 100)}%)</title></circle>`;
      offset += len + W + SPACE;
    });
  }
  svg.innerHTML = html;
  svg.classList.toggle('focus', !!focusCat);
  const isThisMonth = viewMonth === monthOf(dayKey());
  if (focusCat && byCat[focusCat]) {
    $('donutTotal').textContent = moneyShort(byCat[focusCat].amt);
    $('donutCaption').textContent = `${focusCat} · ${Math.round(byCat[focusCat].amt / total * 100)}%`;
  } else {
    $('donutTotal').textContent = moneyShort(total);
    $('donutCaption').textContent = total ? (isThisMonth ? 'Spent this month' : 'Spent in ' + parseDay(viewMonth + '-01').toLocaleDateString('en-PH', { month: 'long' })) : 'No spending yet';
  }
}

function renderHistory() {
  const today = dayKey();

  // Month summary
  const ym = viewMonth;
  $('monthLabel').textContent = parseDay(ym + '-01').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  $('nextMonth').disabled = ym >= monthOf(today);
  const monthItems = expenses.filter(e => monthOf(e.date) === ym);
  const total = monthItems.reduce((s, e) => s + e.amount, 0);
  const daysElapsed = ym === monthOf(today) ? Number(today.slice(8)) : daysInMonth(ym);
  const third = settings.budget > 0
    ? `<div><b>${moneyShort(Math.max(0, settings.budget - total))}</b>budget left</div>`
    : `<div><b>${monthItems.length}</b>expenses</div>`;
  $('monthStats').innerHTML = `
    <div><b>${moneyShort(total)}</b>total</div>
    <div><b>${moneyShort(total / Math.max(1, daysElapsed))}</b>daily avg</div>${third}`;

  // Category breakdown (donut + legend list)
  const byCat = {};
  monthItems.forEach(e => {
    const k = catEmoji[e.cat] ? e.cat : 'Others';
    byCat[k] = byCat[k] || { amt: 0, subs: {} };
    byCat[k].amt += e.amount;
    if (k === 'Others') { const s = e.other || 'Others'; byCat[k].subs[s] = (byCat[k].subs[s] || 0) + e.amount; }
  });
  if (focusCat && !byCat[focusCat]) focusCat = null;
  renderDonut(byCat, total);
  const cats = Object.entries(byCat).sort((a, b) => b[1].amt - a[1].amt);
  $('catBreakdown').innerHTML = cats.length ? cats.map(([name, c]) => {
    const subs = name === 'Others' ? Object.entries(c.subs).sort((a, b) => b[1] - a[1]) : [];
    const subText = subs.length && !(subs.length === 1 && subs[0][0] === 'Others')
      ? `<div class="small muted" style="grid-column:1/-1">${subs.map(([s, a]) => `${esc(s)} ${moneyShort(a)}`).join(' · ')}</div>` : '';
    return `<div class="cat-row ${focusCat === name ? 'on' : ''}" data-focus="${esc(name)}">
      <span><span class="dot" style="background:${CAT_COLORS[name]}"></span>${catEmoji[name]} ${esc(name)} <span class="pct">${Math.round(c.amt / total * 100)}%</span></span>
      <b>${money(c.amt)}</b>${subText}
      <div class="meter"><div class="meter-fill" style="width:${c.amt / cats[0][1].amt * 100}%;background:${CAT_COLORS[name]}"></div></div></div>`;
  }).join('') : '<p class="empty">No expenses this month.</p>';

  // Day list / search
  const q = $('search').value.trim().toLowerCase();
  let html = '';
  if (q) {
    const hits = expenses.filter(e => [label(e), e.cat, e.note, e.pay, e.date].join(' ').toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
    const sum = hits.reduce((s, e) => s + e.amount, 0);
    html = `<p class="small muted">${hits.length} result${hits.length === 1 ? '' : 's'} · ${money(sum)}</p><ul class="list">` +
      hits.slice(0, 200).map(e => itemHTML(e).replace('<div class="info"><div>', `<div class="info"><div>${prettyDay(e.date)} · `)).join('') + '</ul>';
  } else {
    const end = ym === monthOf(today) ? today : `${ym}-${pad(daysInMonth(ym))}`;
    for (let k = end; monthOf(k) === ym; k = addDays(k, -1)) {
      if (k < settings.firstDay && !forDay(k).length) break;
      const items = forDay(k);
      const missed = !isLogged(k) && k !== today && k >= settings.firstDay;
      html += `<div class="day ${missed ? 'missed' : ''}">
        <div class="day-head"><span>${k === today ? 'Today' : k === addDays(today, -1) ? 'Yesterday' : prettyDay(k)}</span>
        <span>${missed ? '⚠️ Not logged' : money(totalFor(k))}</span></div>
        ${items.length ? `<ul class="list">${items.map(itemHTML).join('')}</ul>`
          : noSpend.includes(k) ? '<div class="items">✅ No-spend day</div>' : ''}
        ${missed ? `<button data-logday="${k}">Log this day</button> <button data-nospend="${k}">Spent nothing</button>` : ''}
      </div>`;
    }
  }
  $('historyList').innerHTML = html || '<p class="empty">No history for this month.</p>';
}

function renderSettings() {
  $('reminderTime').value = settings.reminderTime;
  $('warningTime').value = settings.warningTime;
  $('currency').value = settings.currency;
  $('budget').value = settings.budget || '';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notifyBtn').classList.toggle('hidden', perm === 'granted' || perm === 'unsupported');
  $('notifyStatus').textContent = {
    granted: `✅ Notifications are on. You'll be reminded at ${fmtTime(settings.reminderTime)} and warned at ${fmtTime(settings.warningTime)} if today isn't logged.`,
    denied: '🚫 Notifications are blocked. Allow them in your browser/site settings to get reminders.',
    default: 'Turn on notifications so the app can remind you at the end of the day.',
    unsupported: 'This browser does not support notifications. On iPhone, add the app to your Home Screen first.',
  }[perm];

  // Google Sheets
  const c = settings.connected;
  $('sheetsSetup').classList.toggle('hidden', c);
  $('sheetsConnected').classList.toggle('hidden', !c);
  $('urlField').classList.toggle('hidden', !!CFG.SHEETS_WEBAPP_URL);
  if (!c) { $('sName').value ||= settings.name; $('sEmail').value ||= settings.email; $('sUrl').value ||= settings.webAppUrl; }
  if (c) {
    $('openSheet').href = settings.sheetUrl || '#';
    $('syncCode').textContent = settings.userId;
    $('emailRemind').checked = settings.emailReminders;
    $('emailRemind').disabled = !settings.email;
    $('emailRemind').parentElement.title = settings.email ? '' : 'Add an email when connecting to use this';
  }
  $('dataSheetsNote').textContent = c ? ' and backed up to your Google spreadsheet' : '';
  renderSyncStatus();
}
const fmtTime = t => new Date(`2000-01-01T${t}`).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

function renderAll() { renderToday(); renderHistory(); renderSettings(); checkReminder(); syncStateToWorker(); }

/* ---------- Google Sheets sync ---------- */
let syncState = 'idle', syncError = '';

function renderSyncStatus() {
  const pill = $('syncPill');
  if (!settings.connected) { pill.classList.add('hidden'); return; }
  pill.classList.remove('hidden');
  const pending = outbox.length;
  const map = {
    syncing: ['⟳ Syncing…', ''],
    ok: [pending ? `☁️ ${pending} pending` : '☁️ Synced', 'ok'],
    offline: [`⚠ Offline · ${pending} pending`, 'err'],
    error: ['⚠ Sync failed', 'err'],
    idle: [pending ? `☁️ ${pending} pending` : '☁️ Sheets', ''],
  }[syncState];
  pill.textContent = map[0]; pill.className = 'sync-pill ' + map[1];
  const last = settings.lastSync ? new Date(settings.lastSync).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  $('sheetsStatus').innerHTML = `✅ Connected as <b>${esc(settings.name || 'you')}</b>. Last synced: ${last}.` +
    (syncState === 'error' ? `<br><span style="color:var(--danger)">Last sync failed: ${esc(syncError)}</span>` : '') +
    (pending ? `<br>${pending} change${pending > 1 ? 's' : ''} waiting to upload.` : '');
}

async function api(action, payload = {}) {
  const url = webAppUrl();
  if (!url) throw new Error('Google Sheets is not set up yet');
  const res = await fetch(url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // "simple" request: avoids CORS preflight
    body: JSON.stringify({ action, userId: settings.userId, ...payload }),
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Unknown error');
  return data;
}

function queue(op, data) {
  if (!settings.connected) return;
  outbox.push({ op, data }); save('outbox', outbox);
  clearTimeout(queue.timer); queue.timer = setTimeout(() => sync({ pull: false }), 1500);
  renderSyncStatus();
}

let syncing = false;
async function sync({ pull = true } = {}) {
  if (!settings.connected || !webAppUrl() || syncing) return;
  if (!navigator.onLine) { syncState = 'offline'; renderSyncStatus(); return; }
  syncing = true; syncState = 'syncing'; renderSyncStatus();
  try {
    if (outbox.length) {
      const ops = outbox.slice(0, 200);
      await api('batch', { ops });
      outbox = outbox.slice(ops.length); save('outbox', outbox);
      if (outbox.length) { syncing = false; return sync({ pull }); }
    }
    if (pull) {
      const r = await api('pull');
      if (!outbox.length) {   // only replace local data when nothing is waiting to upload
        expenses = r.expenses; noSpend = r.noSpend;
        save('expenses', expenses); save('noSpend', noSpend);
        const earliest = [...expenses.map(e => e.date), ...noSpend].sort()[0];
        if (earliest && earliest < settings.firstDay) settings.firstDay = earliest;
      }
      if (r.sheetUrl) settings.sheetUrl = r.sheetUrl;
    }
    settings.lastSync = Date.now(); save('settings', settings);
    syncState = 'ok';
  } catch (err) {
    syncState = navigator.onLine ? 'error' : 'offline'; syncError = err.message;
  } finally {
    syncing = false;
    renderAll();
  }
}

function uploadEverything() {
  outbox = [...expenses.map(e => ({ op: 'upsert', data: e })), ...noSpend.map(d => ({ op: 'nospend', data: d }))];
  save('outbox', outbox);
}

async function connectSheets() {
  const name = $('sName').value.trim(), email = $('sEmail').value.trim();
  if (!CFG.SHEETS_WEBAPP_URL) settings.webAppUrl = $('sUrl').value.trim();
  if (!name) { toast('Please enter your name'); $('sName').focus(); return; }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) { toast('That email doesn\'t look right'); return; }
  if (!webAppUrl()) { toast('Paste the Apps Script web app URL first'); return; }
  const btn = $('connectBtn'); btn.disabled = true; btn.textContent = 'Creating your spreadsheet…';
  settings.userId ||= newId();
  try {
    const r = await api('register', { name, email, emailReminders: settings.emailReminders });
    Object.assign(settings, { name, email, sheetUrl: r.sheetUrl, connected: true });
    save('settings', settings);
    uploadEverything();
    await sync();
    toast('✅ Your spreadsheet is ready');
  } catch (err) {
    toast('Could not connect: ' + err.message);
  } finally { btn.disabled = false; btn.textContent = 'Create my spreadsheet'; }
}

async function linkDevice() {
  const code = $('linkCode').value.trim();
  if (!/^[A-Za-z0-9-]{16,64}$/.test(code)) { toast('That sync code doesn\'t look right'); return; }
  if (!CFG.SHEETS_WEBAPP_URL) settings.webAppUrl = $('sUrl').value.trim();
  if (!webAppUrl()) { toast('Paste the Apps Script web app URL first'); return; }
  const prev = settings.userId; settings.userId = code;
  try {
    const r = await api('pull');
    Object.assign(settings, { connected: true, name: r.name, sheetUrl: r.sheetUrl });
    save('settings', settings);
    uploadEverything();   // merge anything already on this device into the sheet
    await sync();
    toast('✅ This device is now linked');
  } catch (err) {
    settings.userId = prev; toast(err.message);
  }
}

/* ---------- Reminders & warnings ---------- */
async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = { body, tag, icon: 'icon.svg', badge: 'icon.svg', renotify: true, requireInteraction: tag === 'final-warning' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return true; }
    new Notification(title, opts); return true;
  } catch { return false; }
}

function checkReminder() {
  const today = dayKey();
  const banner = $('reminderBanner');
  if (isLogged(today)) { banner.classList.add('hidden'); return; }
  const now = nowMinutes();
  if (now >= minutesOf(settings.warningTime)) {
    banner.className = 'banner danger';
    banner.innerHTML = `<b>⚠️ Today is almost over and nothing is logged.</b> If you skip today your streak resets and your totals will be wrong. It only takes 30 seconds.`;
    if (settings.lastFinalWarned !== today) {
      settings.lastFinalWarned = today; save('settings', settings);
      notify('⚠️ Don\'t lose today\'s expenses!',
        `You haven't logged anything today. Unrecorded spending is the #1 reason budgets fail — your ${streak()}-day streak is at risk.`, 'final-warning');
    }
  } else if (now >= minutesOf(settings.reminderTime)) {
    banner.className = 'banner';
    banner.innerHTML = `<b>📝 Time to log today's expenses.</b> What did you spend money on today?`;
    if (settings.lastReminded !== today) {
      settings.lastReminded = today; save('settings', settings);
      notify('📝 How much did you spend today?', 'Take 30 seconds to log today\'s expenses before you forget.', 'daily-reminder');
    }
  } else banner.classList.add('hidden');
}

function showMissedDialog(force = false) {
  const missed = missedDays();
  const today = dayKey();
  if (!missed.length || (!force && settings.lastDialog === today)) return;
  settings.lastDialog = today; save('settings', settings);
  $('warnTitle').textContent = missed.length === 1 ? 'You didn\'t log a day' : `You missed ${missed.length} days`;
  $('warnText').textContent = missed.length === 1 && missed[0] === addDays(today, -1)
    ? 'No expenses were recorded yesterday. Here’s why every single day matters:'
    : 'Some days have no expenses recorded. Here’s why every single day matters:';
  $('missedDays').innerHTML = missed.map(k => `<button data-logday="${k}">Log ${prettyDay(k)}</button>`).join('') +
    `<button data-nospend-all="1">I spent nothing on ${missed.length === 1 ? 'that day' : 'these days'}</button>`;
  $('warnDialog').showModal();
}

async function syncStateToWorker() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('expenses-state');
    const state = { lastLoggedDay: isLogged(dayKey()) ? dayKey() : null, reminderTime: settings.reminderTime, warningTime: settings.warningTime };
    await cache.put('./__state', new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
  } catch {}
}

async function registerBackgroundReminder() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state === 'granted') await reg.periodicSync.register('daily-reminder', { minInterval: 60 * 60 * 1000 });
    }
  } catch {}
}

/* ---------- Actions ---------- */
function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${name}`));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo(0, 0);
}

function logDay(k) {
  if ($('warnDialog').open) $('warnDialog').close();
  resetForm(); setView('today');
  $('date').value = k; $('amount').focus();
  toast(`Adding expenses for ${prettyDay(k)}`);
}

function markNoSpend(days) {
  days.forEach(k => { if (!noSpend.includes(k)) { noSpend.push(k); queue('nospend', k); } });
  save('noSpend', noSpend); renderAll();
}

function budgetCheck(before) {
  if (!(settings.budget > 0)) return;
  const after = monthTotal(monthOf(dayKey()));
  const b = settings.budget;
  if (before < b && after >= b) setTimeout(() => toast(`🚨 You've gone over your ${moneyShort(b)} monthly budget`), 2700);
  else if (before < 0.8 * b && after >= 0.8 * b) setTimeout(() => toast(`⚠️ You've used 80% of your monthly budget`), 2700);
}

$('expenseForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const amount = Math.round(parseFloat($('amount').value) * 100) / 100;
  if (!(amount > 0)) { toast('Enter an amount'); return; }
  const date = $('date').value || dayKey();
  const other = selectedCat === 'Others' ? $('other').value.trim() : '';
  const before = monthTotal(monthOf(dayKey()));
  let e;
  if (editingId) {
    e = expenses.find(x => x.id === editingId);
    Object.assign(e, { amount, date, cat: selectedCat, other, pay: selectedPay, note: $('note').value.trim() });
    toast('Changes saved');
  } else {
    e = { id: newId(), amount, cat: selectedCat, other, pay: selectedPay, note: $('note').value.trim(), date, ts: Date.now() };
    expenses.push(e);
    toast(`Added ${money(amount)} · ${label(e)}${date !== dayKey() ? ' for ' + prettyDay(date) : ''}`);
  }
  if (noSpend.includes(date)) { noSpend = noSpend.filter(k => k !== date); save('noSpend', noSpend); queue('unnospend', date); }
  settings.lastPay = selectedPay; save('settings', settings);
  save('expenses', expenses); queue('upsert', e);
  budgetCheck(before);
  resetForm(); renderAll();
});

function deleteExpense(id) {
  const e = expenses.find(x => x.id === id); if (!e) return;
  expenses = expenses.filter(x => x.id !== id); save('expenses', expenses); queue('delete', id);
  if (editingId === id) resetForm();
  renderAll();
  toast(`Deleted ${money(e.amount)} · ${label(e)}`, { label: 'Undo', fn: () => {
    expenses.push(e); save('expenses', expenses); queue('upsert', e); renderAll();
  } });
}

document.addEventListener('click', ev => {
  const t = ev.target.closest('button, li[data-edit], [data-focus]'); if (!t) return;
  if (t.dataset.focus) { focusCat = focusCat === t.dataset.focus ? null : t.dataset.focus; renderHistory(); return; }
  if (t.dataset.cat) { selectedCat = t.dataset.cat; renderChips(); if (selectedCat === 'Others') $('other').focus(); }
  else if (t.dataset.pay) { selectedPay = t.dataset.pay; renderChips(); }
  else if (t.dataset.del) { deleteExpense(t.dataset.del); }
  else if (t.dataset.edit) { startEdit(t.dataset.edit); }
  else if (t.dataset.view) { setView(t.dataset.view); }
  else if (t.dataset.logday) { logDay(t.dataset.logday); }
  else if (t.dataset.nospend) { markNoSpend([t.dataset.nospend]); }
  else if (t.dataset.nospendAll) { markNoSpend(missedDays()); $('warnDialog').close(); toast('Marked as no-spend days'); }
});

$('cancelEdit').addEventListener('click', resetForm);
$('noSpendBtn').addEventListener('click', () => { markNoSpend([dayKey()]); toast('✅ No-spend day — streak kept!'); });
$('warnClose').addEventListener('click', () => $('warnDialog').close());
$('prevMonth').addEventListener('click', () => { viewMonth = addMonths(viewMonth, -1); focusCat = null; renderHistory(); });
$('nextMonth').addEventListener('click', () => { viewMonth = addMonths(viewMonth, 1); focusCat = null; renderHistory(); });
$('search').addEventListener('input', renderHistory);
$('syncPill').addEventListener('click', () => sync());

['reminderTime', 'warningTime'].forEach(id => $(id).addEventListener('change', e => {
  settings[id] = e.target.value; settings.lastReminded = null; settings.lastFinalWarned = null;
  save('settings', settings); renderAll(); toast('Reminder time saved');
}));
$('currency').addEventListener('change', e => { settings.currency = e.target.value.trim() || '₱'; save('settings', settings); renderAll(); });
$('budget').addEventListener('change', e => { settings.budget = Math.max(0, parseFloat(e.target.value) || 0); save('settings', settings); renderAll(); toast(settings.budget ? `Monthly budget set to ${moneyShort(settings.budget)}` : 'Budget removed'); });

$('connectBtn').addEventListener('click', connectSheets);
$('linkBtn').addEventListener('click', linkDevice);
$('syncNow').addEventListener('click', () => sync());
$('copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(settings.userId); toast('Sync code copied'); } catch { toast('Copy failed — select the code and copy it'); }
});
$('emailRemind').addEventListener('change', async e => {
  settings.emailReminders = e.target.checked; save('settings', settings);
  try { await api('register', { name: settings.name, email: settings.email, emailReminders: settings.emailReminders }); toast(e.target.checked ? 'Email reminders on' : 'Email reminders off'); }
  catch (err) { toast('Could not update: ' + err.message); }
});
$('disconnectBtn').addEventListener('click', () => {
  if (!confirm('Stop syncing this device? Your spreadsheet stays in Google Drive, and you can reconnect later with your sync code.')) return;
  if (outbox.length && !confirm(`${outbox.length} change(s) haven't been uploaded yet and will only stay on this device. Continue?`)) return;
  settings.connected = false; outbox = []; save('outbox', outbox); save('settings', settings); renderAll();
});

$('notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  if (p === 'granted') { await registerBackgroundReminder(); toast('Notifications enabled'); }
  renderSettings();
});
$('testNotifyBtn').addEventListener('click', async () => {
  const ok = await notify('📝 Daily Expenses', 'This is what your end-of-day reminder will look like.', 'test');
  if (!ok) toast('Enable notifications first');
});

$('exportBtn').addEventListener('click', () => {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Category', 'Others (specify)', 'Amount (PHP)', 'Paid with', 'Note'].join(','),
    ...[...expenses].sort((a, b) => a.date.localeCompare(b.date)).map(e => [e.date, q(e.cat), q(e.other), e.amount, q(e.pay), q(e.note)].join(','))];
  const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `expenses-${dayKey()}.csv`; a.click();
});
$('resetBtn').addEventListener('click', () => {
  const msg = settings.connected
    ? 'Delete all data on THIS device? Your Google spreadsheet is not affected.'
    : 'Delete all expenses and settings on this device? This cannot be undone.';
  if (!confirm(msg)) return;
  localStorage.clear(); location.reload();
});

let deferredInstall;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').addEventListener('click', () => { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall = null; $('installBtn').classList.add('hidden'); });

/* ---------- Boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(registerBackgroundReminder).catch(() => {});
save('expenses', expenses);
$('date').value = dayKey();
renderChips();
renderAll();
showMissedDialog();
sync();

setInterval(() => { renderHeader(); checkReminder(); }, 30000);
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderAll(); showMissedDialog(); sync(); }
});

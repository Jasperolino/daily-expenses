'use strict';
const SHELL = 'expenses-shell-v4';
const FILES = ['./', 'index.html', 'guide.html', 'style.css', 'config.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('expenses-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates show up), fall back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

// Background reminder (installed Chrome/Edge apps): fires roughly hourly even when the app is closed.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'daily-reminder') e.waitUntil(backgroundCheck());
});

async function backgroundCheck() {
  const cache = await caches.open('expenses-state');
  const res = await cache.match('./__state');
  if (!res) return;
  const state = await res.json();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastLoggedDay === today) return;

  const mins = d.getHours() * 60 + d.getMinutes();
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  if (mins >= toMin(state.warningTime)) {
    await self.registration.showNotification('⚠️ Don\'t lose today\'s expenses!', {
      body: 'Nothing logged today. Unrecorded spending is the #1 reason budgets fail. Tap to log it now.',
      tag: 'final-warning', icon: 'icon.svg', requireInteraction: true,
    });
  } else if (mins >= toMin(state.reminderTime)) {
    await self.registration.showNotification('📝 How much did you spend today?', {
      body: 'Take 30 seconds to log today\'s expenses before you forget.', tag: 'daily-reminder', icon: 'icon.svg',
    });
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});

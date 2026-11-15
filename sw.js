/* Catatan Keuangan — service worker
   Menyimpan tampilan aplikasi di HP supaya tetap bisa dibuka & dipakai mencatat saat offline.
   Data transaksi TIDAK disimpan di sini (disimpan aplikasi di penyimpanan lokal & dikirim saat online). */
const CACHE = 'ku-shell-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // permintaan ke Apps Script (POST) selalu langsung ke internet
  const url = new URL(req.url);

  // Font Google: simpan setelah pertama kali dimuat
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { c.put(req, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // File aplikasi: tampilkan versi tersimpan dulu (cepat), lalu perbarui di belakang layar
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit || c.match('index.html'));
        return hit || net;
      })
    )
  );
});

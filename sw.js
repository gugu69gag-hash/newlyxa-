// ============================================================
//  LYXA — Service Worker
//  Letakkan file ini di root repo GitHub (sejajar index.html)
// ============================================================

const CACHE_NAME   = 'lyxa-cache-v1';
const DATA_STORE   = 'lyxa-sw-data';      // key untuk data app
const SHOWN_PREFIX = 'lyxa-shown-';       // key untuk riwayat notif

const ICON = 'https://cdn-icons-png.flaticon.com/512/2933/2933830.png';

// ── Install: ambil halaman utama agar bisa offline ──────────
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(['./'])
        ).catch(() => {})
    );
});

// ── Activate: ambil kendali semua tab langsung ───────────────
self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});

// ── Fetch: sajikan dari cache jika offline ───────────────────
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request)
            .then(resp => {
                const clone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                return resp;
            })
            .catch(() => caches.match(event.request))
    );
});

// ── Message: terima data dari halaman utama ──────────────────
self.addEventListener('message', async event => {
    if (!event.data) return;

    if (event.data.type === 'UPDATE_DATA') {
        // Simpan data terbaru ke Cache Storage
        const payload = {
            deadlines : event.data.deadlines || [],
            maint     : event.data.maint     || [],
            odo       : event.data.odo       || 0,
            savedAt   : Date.now()
        };
        const cache = await caches.open(CACHE_NAME);
        await cache.put(
            DATA_STORE,
            new Response(JSON.stringify(payload), {
                headers: { 'Content-Type': 'application/json' }
            })
        );
    }

    if (event.data.type === 'CHECK_NOW') {
        // Halaman minta cek langsung (saat dibuka / kembali ke foreground)
        await checkAndNotifyBG(true);
    }
});

// ── Periodic Background Sync ─────────────────────────────────
//    Berjalan ~sekali sehari meski app tertutup (Android + TWA)
self.addEventListener('periodicsync', event => {
    if (event.tag === 'lyxa-daily-check') {
        event.waitUntil(checkAndNotifyBG(false));
    }
});

// ── Klik notifikasi → buka / fokus ke app ───────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(list => {
                // Kalau tab app sudah terbuka, fokuskan saja
                const existing = list.find(c => c.url.includes(self.location.origin));
                if (existing) return existing.focus();
                // Kalau belum, buka tab baru
                return clients.openWindow('./');
            })
    );
});

// ────────────────────────────────────────────────────────────
//  FUNGSI INTI: cek & tampilkan notifikasi
//  forceAll = true  → abaikan riwayat shown (saat buka app)
//  forceAll = false → hanya yang belum ditampilkan hari ini
// ────────────────────────────────────────────────────────────
async function checkAndNotifyBG(forceAll = false) {
    const data = await loadData();
    if (!data) return;

    const { deadlines, maint, odo } = data;
    const today    = new Date();
    const todayStr = today.toDateString();

    // Ambil daftar notif yang sudah ditampilkan hari ini
    const cache   = await caches.open(CACHE_NAME);
    const shownKey = SHOWN_PREFIX + todayStr;
    const shownResp = await cache.match(shownKey).catch(() => null);
    const shown    = shownResp ? (await shownResp.json().catch(() => [])) : [];

    const queue = [];

    // ── Cek deadlines ──
    (deadlines || []).forEach(d => {
        const diff = Math.ceil((new Date(d.date) - today) / 86400000);
        const id   = 'dl_' + d.id + '_' + diff;
        if (!forceAll && shown.includes(id)) return;

        if      (diff < 0)  queue.push({ id, title: '⚠️ DEADLINE TERLEWAT!',      body: d.title + ' (' + Math.abs(diff) + ' hari lalu)' });
        else if (diff === 0) queue.push({ id, title: '⚖️ DEADLINE HARI INI!',      body: d.title });
        else if (diff === 1) queue.push({ id, title: '⚖️ Deadline Besok',          body: d.title });
        else if (diff === 3) queue.push({ id, title: '⚖️ Deadline 3 Hari Lagi',   body: d.title });
        else if (diff === 7) queue.push({ id, title: '⚖️ Deadline Seminggu Lagi', body: d.title });
    });

    // ── Cek maintenance ──
    (maint || []).forEach(m => {
        const used = m.type === 'km'
            ? (odo - m.lastVal)
            : Math.floor((Date.now() - new Date(m.lastVal).getTime()) / 86400000);
        const prog = (used / m.interval) * 100;
        const id   = 'mn_' + m.id + '_' + Math.floor(prog / 10);
        if (!forceAll && shown.includes(id)) return;

        if      (prog >= 100) queue.push({ id, title: '🔧 Service Harus Dilakukan!', body: m.title + ' sudah lewat interval!' });
        else if (prog >= 90)  queue.push({ id, title: '🔧 Service Hampir Tiba',      body: m.title + ' (' + prog.toFixed(0) + '%)' });
    });

    if (!queue.length) return;

    // Tampilkan semua notifikasi (jeda 1.2 detik antar notif)
    for (let i = 0; i < queue.length; i++) {
        const n = queue[i];
        await delay(i * 1200);
        await self.registration.showNotification(n.title, {
            body    : n.body,
            icon    : ICON,
            badge   : ICON,
            tag     : n.id,          // deduplikasi — tag sama = replace, tidak dobel
            renotify: false
        });
        if (!shown.includes(n.id)) shown.push(n.id);
    }

    // Simpan daftar yang sudah ditampilkan
    await cache.put(
        shownKey,
        new Response(JSON.stringify(shown), {
            headers: { 'Content-Type': 'application/json' }
        })
    );
}

// ── Helpers ──────────────────────────────────────────────────
async function loadData() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const resp  = await cache.match(DATA_STORE);
        if (!resp) return null;
        return await resp.json();
    } catch { return null; }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

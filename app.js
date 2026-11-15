/* ============================================================
   Catatan Keuangan — app.js
   Aplikasi PWA pencatat keuangan yang tersambung ke Google Sheets
   lewat Google Apps Script. Tanpa framework, tanpa build step.
   ============================================================ */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var LS = { cfg: 'ku.cfg', cache: 'ku.cache', queue: 'ku.queue', prefs: 'ku.prefs', demo: 'ku.demo', demoDb: 'ku.demodb' };
  var BATCH_SIZE = 15;
  /* Palet kategori (urutan tetap, sudah divalidasi aman buta warna) */
  var SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  var NEUTRAL = '#a3a9bf';
  var C_IN = '#1baf7a', C_OUT = '#6250d6';
  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  /* ---------------- Penyimpanan lokal ---------------- */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ---------------- State ---------------- */
  var S = {
    cfg: store.get(LS.cfg, null),
    demo: store.get(LS.demo, false) || !!window.KU_PREVIEW,
    server: store.get(LS.cache, null),
    queue: store.get(LS.queue, []),
    prefs: store.get(LS.prefs, {}),
    view: 'home',
    period: { type: 'month', from: '', to: '' },
    hist: { q: '', jenis: 'all', kat: '', from: '', to: '', limit: 60 },
    loading: false,
    online: navigator.onLine,
    authError: false,
    lastSync: store.get('ku.lastSync', null),
    opResults: {},
    flushChain: Promise.resolve(),
    installEvt: null
  };

  /* ---------------- Util ---------------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var nf = new Intl.NumberFormat('id-ID');
  function fmt(n) { return nf.format(Math.round(n || 0)); }
  function rp(n) { return (n < 0 ? '−' : '') + 'Rp ' + fmt(Math.abs(n)); }
  function rpShort(n) {
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e9) return s + trim1(a / 1e9) + ' M';
    if (a >= 1e6) return s + trim1(a / 1e6) + ' jt';
    if (a >= 1e3) return s + trim1(a / 1e3) + ' rb';
    return s + fmt(a);
  }
  function trim1(x) { return (Math.round(x * 10) / 10).toString().replace('.', ','); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12); }
  function today() { return ymd(new Date()); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }
  function monthLen(y, m) { return new Date(y, m, 0).getDate(); }
  function dateLong(s) { var d = parse(s); return d.getDate() + ' ' + BULAN[d.getMonth()] + ' ' + d.getFullYear(); }
  function dateShort(s) { var d = parse(s); return d.getDate() + ' ' + BLN[d.getMonth()]; }
  function dayLabel(s) {
    var t = today();
    if (s === t) return 'Hari ini';
    if (s === addDays(t, -1)) return 'Kemarin';
    var d = parse(s);
    return HARI[d.getDay()] + ', ' + d.getDate() + ' ' + BLN[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function genId() { return 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function savePrefs() { store.set(LS.prefs, S.prefs); }

  /* ---------------- Kategori ---------------- */
  function categories(jenis) {
    var list = (S.server && S.server.categories) || [];
    return list.filter(function (c) { return c.jenis === jenis; });
  }
  var ruleCache = null;
  function rules() {
    if (ruleCache) return ruleCache;
    ruleCache = { keluar: [], masuk: [] };
    ((S.server && S.server.categories) || []).forEach(function (c, ci) {
      String(c.kataKunci || '').split(',').map(norm).filter(Boolean).forEach(function (kw) {
        ruleCache[c.jenis].push({ kw: kw, cat: c.nama, order: ci });
      });
    });
    return ruleCache;
  }
  function isWordChar(ch) { return !!ch && /[a-z0-9]/.test(ch); }
  function hasWord(text, kw) {
    var from = 0, i;
    while ((i = text.indexOf(kw, from)) >= 0) {
      if (!isWordChar(text[i - 1]) && !isWordChar(text[i + kw.length])) return true;
      from = i + 1;
    }
    return false;
  }
  /** Tebak kategori dari keterangan: kata kunci terpanjang yang cocok menang. */
  function guessCategory(text, jenis) {
    var t = norm(text);
    if (!t) return '';
    var best = null;
    rules()[jenis].forEach(function (r) {
      if (r.kw.length > (best ? best.kw.length : 0) && hasWord(t, r.kw)) best = r;
    });
    return best ? best.cat : '';
  }
  function catIndex(nama, jenis) {
    var list = categories(jenis).filter(function (c) { return norm(c.nama) !== 'lainnya'; });
    for (var i = 0; i < list.length; i++) if (list[i].nama === nama) return i;
    return -1;
  }
  function catColor(nama, jenis) {
    var i = catIndex(nama, jenis);
    return i >= 0 && i < SERIES.length ? SERIES[i] : NEUTRAL;
  }
  function catIcon(nama, jenis) {
    var c = categories(jenis).filter(function (x) { return x.nama === nama; })[0];
    return (c && c.ikon) || (jenis === 'masuk' ? '💰' : '📦');
  }
  function sourceIcon(nama) {
    var s = ((S.server && S.server.sources) || []).filter(function (x) { return x.nama === nama; })[0];
    return s ? s.ikon : '';
  }

  /* ---------------- Data gabungan (server + antrian offline) ---------------- */
  var viewCache = null;
  function invalidate() { viewCache = null; ruleCache = null; }
  function txList() {
    if (viewCache) return viewCache;
    var base = ((S.server && S.server.transactions) || []).map(function (t, i) { return Object.assign({}, t, { _i: i }); });
    var byId = {};
    base.forEach(function (t) { byId[t.id] = t; });
    var extra = 10000000;
    S.queue.forEach(function (op) {
      if (op.action === 'add' || op.action === 'update') {
        var tx = op.data.tx;
        var prev = byId[tx.id];
        var merged = Object.assign({}, prev || {}, tx, { _pending: true, _i: prev ? prev._i : extra++ });
        if (prev) base[base.indexOf(prev)] = merged; else base.push(merged);
        byId[tx.id] = merged;
      } else if (op.action === 'delete') {
        var p = byId[op.data.id];
        if (p) { base.splice(base.indexOf(p), 1); delete byId[op.data.id]; }
      }
    });
    base.forEach(function (t) {
      t.cat = t.kategori || guessCategory(t.keterangan, t.jenis) || 'Lainnya';
      t.autoCat = !t.kategori;
    });
    base.sort(function (a, b) { return a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : b._i - a._i; });
    viewCache = base;
    return base;
  }
  function inRange(list, from, to) { return list.filter(function (t) { return t.tanggal >= from && t.tanggal <= to; }); }
  function sum(list, jenis) { return list.reduce(function (s, t) { return s + (!jenis || t.jenis === jenis ? t.nominal : 0); }, 0); }

  /* ---------------- Periode ---------------- */
  function periodRange(p) {
    var t = today(), d = parse(t), from, to, pf, pt, label;
    if (p.type === 'today') {
      from = to = t; pf = pt = addDays(t, -1); label = dayLabel(t) + ', ' + dateShort(t);
    } else if (p.type === 'week') {
      var dow = (d.getDay() + 6) % 7; // Senin = 0
      from = addDays(t, -dow); to = addDays(from, 6);
      pf = addDays(from, -7); pt = addDays(pf, dow);
      label = dateShort(from) + ' – ' + dateShort(to);
    } else if (p.type === 'year') {
      from = d.getFullYear() + '-01-01'; to = d.getFullYear() + '-12-31';
      pf = (d.getFullYear() - 1) + '-01-01'; pt = (d.getFullYear() - 1) + t.slice(4);
      label = 'Tahun ' + d.getFullYear();
    } else if (p.type === 'custom' && p.from && p.to) {
      from = p.from <= p.to ? p.from : p.to; to = p.from <= p.to ? p.to : p.from;
      var len = daysBetween(from, to) + 1;
      pt = addDays(from, -1); pf = addDays(pt, -(len - 1));
      label = dateShort(from) + ' – ' + dateLong(to);
    } else {
      var y = d.getFullYear(), m = d.getMonth() + 1;
      from = y + '-' + pad(m) + '-01'; to = y + '-' + pad(m) + '-' + pad(monthLen(y, m));
      var py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      pf = py + '-' + pad(pm) + '-01'; pt = py + '-' + pad(pm) + '-' + pad(Math.min(d.getDate(), monthLen(py, pm)));
      label = BULAN[m - 1] + ' ' + y;
    }
    var effTo = to < t ? to : (from > t ? to : t);
    return { from: from, to: to, prevFrom: pf, prevTo: pt, label: label, days: daysBetween(from, effTo) + 1, type: p.type };
  }
  var PERIOD_LABEL = { today: 'Hari ini', week: 'Minggu ini', month: 'Bulan ini', year: 'Tahun ini', custom: 'Pilih tanggal' };
  var PREV_LABEL = { today: 'kemarin', week: 'minggu lalu', month: 'bulan lalu (tanggal yang sama)', year: 'tahun lalu', custom: 'periode sebelumnya' };

  function periodChips() {
    var p = S.period;
    var html = '<div class="chips" role="tablist" aria-label="Periode">' +
      ['today', 'week', 'month', 'year', 'custom'].map(function (k) {
        return '<button class="chip' + (p.type === k ? ' is-active' : '') + '" data-period="' + k + '" role="tab" aria-selected="' + (p.type === k) + '">' + PERIOD_LABEL[k] + '</button>';
      }).join('') + '</div>';
    if (p.type === 'custom') {
      html += '<div class="custom-range"><input type="date" data-range="from" value="' + esc(p.from) + '" aria-label="Dari tanggal">' +
        '<span>s/d</span><input type="date" data-range="to" value="' + esc(p.to) + '" aria-label="Sampai tanggal"></div>';
    }
    return html;
  }
  function bindPeriod(root, rerender) {
    $$('[data-period]', root).forEach(function (b) {
      b.addEventListener('click', function () {
        S.period.type = b.dataset.period;
        if (S.period.type === 'custom' && !S.period.from) {
          S.period.to = today(); S.period.from = addDays(today(), -29);
        }
        rerender();
      });
    });
    $$('[data-range]', root).forEach(function (inp) {
      inp.addEventListener('change', function () { S.period[inp.dataset.range] = inp.value; if (S.period.from && S.period.to) rerender(); });
    });
  }

  /* ============================================================
     API
     ============================================================ */
  function ApiError(message, code) { this.message = message; this.code = code; }
  ApiError.prototype = Object.create(Error.prototype);

  function api(action, data) {
    if (S.demo) return demoApi(action, data);
    if (!S.cfg) return Promise.reject(new ApiError('Belum terhubung ke spreadsheet.', 'CFG'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
    return fetch(S.cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: S.cfg.key, action: action, data: data || {} }),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          throw new ApiError('Balasan server tidak dikenali. Pastikan URL berakhiran /exec dan akses web app "Siapa saja".', 'SERVER');
        }
        if (!j.ok) throw new ApiError(j.error || 'Terjadi kesalahan di server.', j.code === 'AUTH' ? 'AUTH' : 'SERVER');
        S.online = true;
        return j.data;
      });
    }, function (err) {
      throw new ApiError(navigator.onLine ? 'Tidak bisa menghubungi server.' : 'Kamu sedang offline.', 'NET');
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- Sinkronisasi ---------------- */
  function persistQueue() { store.set(LS.queue, S.queue); }
  function persistServer() { store.set(LS.cache, S.server); }

  function enqueue(action, data) {
    var op = { opId: genId(), action: action, data: data, ts: Date.now() };
    var id = action === 'delete' ? data.id : data.tx.id;
    var pendingAdd = S.queue.filter(function (o) { return o.action === 'add' && o.data.tx.id === id; })[0];
    if (action === 'update' && pendingAdd) {
      pendingAdd.data.tx = Object.assign({}, data.tx);
      op = pendingAdd;
    } else if (action === 'delete' && pendingAdd) {
      S.queue = S.queue.filter(function (o) { return !((o.data.tx && o.data.tx.id === id) || o.data.id === id); });
      S.opResults[op.opId] = { ok: true, local: true };
    } else {
      if (action !== 'add') S.queue = S.queue.filter(function (o) { return !(o.action === 'update' && o.data.tx.id === id); });
      S.queue.push(op);
    }
    persistQueue();
    invalidate();
    renderAll();
    return op.opId;
  }

  function applyResult(op, data) {
    var list = S.server.transactions;
    if (op.action === 'delete') {
      S.server.transactions = list.filter(function (t) { return t.id !== op.data.id; });
    } else {
      var tx = data.tx, found = false;
      for (var i = 0; i < list.length; i++) if (list[i].id === tx.id) { list[i] = tx; found = true; break; }
      if (!found) list.push(tx);
    }
  }

  function flush() {
    S.flushChain = S.flushChain.then(doFlush, doFlush);
    return S.flushChain;
  }

  function doFlush() {
    if (!S.queue.length || !S.server) { updateSyncPill(); return Promise.resolve(); }
    updateSyncPill(true);
    var batch = S.queue.slice(0, BATCH_SIZE);
    return api('batch', { ops: batch }).then(function (res) {
      var failed = false;
      (res.results || []).forEach(function (r) {
        var op = batch.filter(function (o) { return o.opId === r.opId; })[0];
        if (!op) return;
        S.queue = S.queue.filter(function (o) { return o.opId !== r.opId; });
        S.opResults[r.opId] = r.ok ? { ok: true } : { ok: false, error: r.error };
        if (r.ok) applyResult(op, r.data); else failed = true;
      });
      S.lastSync = new Date().toISOString(); store.set('ku.lastSync', S.lastSync);
      persistQueue(); persistServer(); invalidate(); renderAll();
      if (failed) refresh(true);
      if (S.queue.length) return doFlush();
    }, function (err) {
      if (err.code === 'AUTH') { S.authError = true; toast('Kunci aplikasi ditolak. Periksa koneksi di Pengaturan.', 'err'); }
      if (err.code === 'NET') S.online = false;
      updateSyncPill();
      renderAll();
    });
  }

  function refresh(silent) {
    if (!S.cfg && !S.demo) return Promise.resolve();
    S.loading = true;
    var btn = $('#btn-refresh'); if (btn) btn.classList.add('is-spinning');
    if (!S.server) renderAll();
    return api('bootstrap').then(function (data) {
      S.server = data; S.authError = false; S.online = true;
      S.lastSync = new Date().toISOString(); store.set('ku.lastSync', S.lastSync);
      persistServer(); invalidate();
      if (!silent) toast('Data terbaru sudah dimuat', 'ok', 1800);
      if (S.queue.length) flush();
    }, function (err) {
      if (err.code === 'AUTH') { S.authError = true; toast('Kunci aplikasi ditolak. Hubungkan ulang di Pengaturan.', 'err'); }
      else if (err.code === 'NET') { S.online = false; if (!silent) toast('Offline: menampilkan data terakhir yang tersimpan di HP.', 'info'); }
      else toast(err.message, 'err');
    }).then(function () {
      S.loading = false;
      if (btn) btn.classList.remove('is-spinning');
      renderAll();
    });
  }

  function updateSyncPill(busy) {
    var pill = $('#sync-pill');
    if (!pill) return;
    var n = S.queue.length;
    if (!n) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.classList.toggle('is-offline', !S.online);
    pill.textContent = busy ? 'Mengirim ' + n + '…' : (S.online ? n + ' belum terkirim' : 'Offline · ' + n + ' antre');
  }

  /** Kirim satu perubahan dan beri notifikasi sesuai hasilnya. */
  function commit(action, data, msgs) {
    var opId = enqueue(action, data);
    if (S.opResults[opId] && S.opResults[opId].local) { toast(msgs.ok, 'ok'); return Promise.resolve(true); }
    return flush().then(function () {
      var r = S.opResults[opId];
      if (r && r.ok) { toast(msgs.ok, 'ok', 2600, msgs.undo); return true; }
      if (r && !r.ok) { toast('Gagal: ' + r.error, 'err', 5000); return false; }
      toast('Tersimpan di HP. Akan dikirim otomatis saat online.', 'info', 3500, msgs.undo);
      return true;
    });
  }

  /* ============================================================
     MODE CONTOH (data buatan, tidak menyentuh spreadsheet)
     ============================================================ */
  function demoDefaults() {
    return {
      categories: [
        ['keluar', 'Makan & Jajan', '🍜', 'sarapan, makan, makan siang, jajan, bakso, mie ayam, es teh, kopi, martabak, soto, gorengan, cilok'],
        ['keluar', 'Belanja Harian', '🛒', 'sayur, sayuran, lauk, buah, telur, galon, gas, beras, alfa, indomaret, detergen'],
        ['keluar', 'Transportasi', '🚗', 'bensin, emoney, parkir, ongkos, grab, tol, cuci mobil'],
        ['keluar', 'Tagihan & Rumah', '🏠', 'listrik, wifi, pam, ipl, pulsa, paket data, kontrakan'],
        ['keluar', 'Pendidikan', '🎓', 'spp, buku, seragam, sekolah'],
        ['keluar', 'Kesehatan', '💊', 'obat, vitamin, dokter, klinik'],
        ['keluar', 'Keluarga & Kewajiban', '🤝', 'iuran wajib, cicilan, kado, arisan'],
        ['keluar', 'Belanja & Hiburan', '🛍️', 'baju, sepatu, renang, nonton, mainan'],
        ['keluar', 'Lainnya', '📦', ''],
        ['masuk', 'Gaji', '💼', 'gaji'],
        ['masuk', 'Bonus & THR', '🎁', 'bonus, thr'],
        ['masuk', 'Usaha & Sampingan', '🧾', 'jualan, freelance'],
        ['masuk', 'Lainnya', '💰', '']
      ].map(function (c, i) {
        var budget = { 'Makan & Jajan': 2500000, 'Belanja Harian': 3000000, 'Transportasi': 1200000 }[c[1]] || 0;
        return { jenis: c[0], nama: c[1], ikon: c[2], kataKunci: c[3], anggaran: c[0] === 'keluar' ? budget : 0, urut: i };
      }),
      sources: [{ nama: 'Tunai', ikon: '💵' }, { nama: 'Rekening Bank', ikon: '🏦' }, { nama: 'E-Wallet', ikon: '📱' }]
    };
  }
  function demoGenerate() {
    var seed = 7;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    var items = [
      ['sayur dan lauk', 25, 140, 0.55], ['bensin', 24, 300, 0.35], ['jajan', 10, 120, 0.5], ['buah', 20, 120, 0.25],
      ['alfa', 40, 250, 0.3], ['es teh', 5, 20, 0.2], ['mie ayam', 20, 70, 0.15], ['emoney', 50, 200, 0.12],
      ['galon', 20, 45, 0.08], ['gas', 22, 22, 0.06], ['sarapan', 15, 60, 0.25], ['parkir', 2, 10, 0.15],
      ['obat', 30, 150, 0.03], ['kado', 100, 250, 0.02], ['renang', 75, 175, 0.03], ['buku', 25, 90, 0.02]
    ];
    var txs = [], t = today(), start = addDays(t, -125), d = start, n = 0;
    while (d <= t) {
      var day = +d.slice(8);
      if (day === 1) {
        txs.push({ id: 'D' + (n++), jenis: 'masuk', tanggal: d, nominal: 9500000, keterangan: 'Gaji ' + BULAN[+d.slice(5, 7) - 1], kategori: 'Gaji', sumber: 'Rekening Bank' });
        txs.push({ id: 'D' + (n++), jenis: 'keluar', tanggal: d, nominal: 450000, keterangan: 'listrik', kategori: '', sumber: 'Rekening Bank' });
        txs.push({ id: 'D' + (n++), jenis: 'keluar', tanggal: d, nominal: 284000, keterangan: 'wifi', kategori: '', sumber: 'Rekening Bank' });
        txs.push({ id: 'D' + (n++), jenis: 'keluar', tanggal: d, nominal: 400000, keterangan: 'ipl', kategori: '', sumber: 'Rekening Bank' });
        txs.push({ id: 'D' + (n++), jenis: 'keluar', tanggal: d, nominal: 240000, keterangan: 'spp sekolah', kategori: '', sumber: 'Rekening Bank' });
      }
      if (day === 15 && rnd() > 0.4) txs.push({ id: 'D' + (n++), jenis: 'masuk', tanggal: d, nominal: Math.round(400 + rnd() * 900) * 1000, keterangan: 'jualan kue', kategori: 'Usaha & Sampingan', sumber: 'E-Wallet' });
      items.forEach(function (it) {
        if (rnd() < it[3]) {
          var nom = Math.round((it[1] + rnd() * (it[2] - it[1])) / 1) * 1000;
          txs.push({ id: 'D' + (n++), jenis: 'keluar', tanggal: d, nominal: nom, keterangan: it[0], kategori: '', sumber: rnd() > 0.6 ? 'E-Wallet' : 'Tunai' });
        }
      });
      d = addDays(d, 1);
    }
    return txs;
  }
  function demoDb() {
    var db = store.get(LS.demoDb, null);
    if (!db) { db = demoDefaults(); db.transactions = demoGenerate(); store.set(LS.demoDb, db); }
    return db;
  }
  function demoApi(action, data) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var db = demoDb();
        var one = function (a, d) {
          if (a === 'add' || a === 'update') {
            var tx = Object.assign({}, d.tx, { ref: { year: +d.tx.tanggal.slice(0, 4), sheet: d.tx.jenis === 'masuk' ? 'Pemasukan' : BULAN[+d.tx.tanggal.slice(5, 7) - 1] } });
            if (!(tx.nominal > 0)) throw new Error('Nominal harus lebih dari 0.');
            var i = db.transactions.findIndex(function (t) { return t.id === tx.id; });
            if (i >= 0) db.transactions[i] = tx; else db.transactions.push(tx);
            return { tx: tx };
          }
          if (a === 'delete') {
            var old = db.transactions.filter(function (t) { return t.id === d.id; })[0];
            db.transactions = db.transactions.filter(function (t) { return t.id !== d.id; });
            return { tx: old };
          }
        };
        try {
          var out;
          if (action === 'bootstrap') out = { transactions: db.transactions, categories: db.categories, sources: db.sources, meta: { baseYear: new Date().getFullYear(), sheetName: 'Contoh', demo: true } };
          else if (action === 'batch') out = { results: data.ops.map(function (op) { try { return { opId: op.opId, ok: true, data: one(op.action, op.data) }; } catch (e) { return { opId: op.opId, ok: false, error: e.message }; } }) };
          else if (action === 'saveBudgets') {
            db.categories.forEach(function (c) { var k = c.jenis + '|' + c.nama; if (k in data.budgets) c.anggaran = Math.max(0, Math.round(+data.budgets[k] || 0)); });
            out = { categories: db.categories };
          } else out = one(action, data);
          store.set(LS.demoDb, db);
          resolve(JSON.parse(JSON.stringify(out)));
        } catch (e) { reject(new ApiError(e.message, 'SERVER')); }
      }, 250);
    });
  }

  /* ============================================================
     UI DASAR: toast, sheet, navigasi
     ============================================================ */
  function toast(msg, kind, ms, action) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    var icon = kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'info' ? '↻' : 'i';
    el.innerHTML = '<span class="ti">' + icon + '</span><span class="tt"></span>';
    el.querySelector('.tt').textContent = msg;
    if (action) {
      var b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', function () { close(); action.run(); });
      el.appendChild(b);
    }
    while (box.children.length > 2) box.removeChild(box.firstChild);
    box.appendChild(el);
    var closed = false;
    function close() { if (closed) return; closed = true; el.classList.add('is-out'); setTimeout(function () { el.remove(); }, 260); }
    setTimeout(close, ms || (action ? 6000 : 2800));
    el.addEventListener('click', function (e) { if (e.target.tagName !== 'BUTTON') close(); });
  }

  var sheetOnClose = null;
  function openSheet(html, onMount, onClose) {
    var sheet = $('#sheet'), body = $('#sheet-body');
    body.innerHTML = html;
    sheet.classList.remove('is-closing');
    sheet.hidden = false; $('#scrim').hidden = false;
    sheet.scrollTop = 0;
    sheetOnClose = onClose || null;
    $$('[data-close]', body).forEach(function (b) { b.addEventListener('click', closeSheet); });
    if (onMount) onMount(body);
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    var sheet = $('#sheet');
    if (sheet.hidden) return;
    sheet.classList.add('is-closing');
    $('#scrim').hidden = true;
    document.body.style.overflow = '';
    setTimeout(function () { sheet.hidden = true; sheet.classList.remove('is-closing'); $('#sheet-body').innerHTML = ''; }, 200);
    if (sheetOnClose) { var f = sheetOnClose; sheetOnClose = null; f(); }
  }
  var closeIcon = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function go(view) {
    S.view = view;
    $$('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === view); });
    $('#page-title').textContent = $('#view-' + view).dataset.title;
    window.scrollTo(0, 0);
    hideTip();
    renderView();
  }

  function renderAll() {
    var connected = !!(S.cfg || S.demo);
    $('#screen-connect').hidden = connected;
    $('#main').hidden = !connected;
    if (!connected) return;
    $('#demo-banner').hidden = !S.demo;
    var h = new Date().getHours();
    $('#hello').textContent = h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
    updateSyncPill();
    renderView();
  }
  function renderView() {
    if (S.view === 'home') renderHome();
    else if (S.view === 'history') renderHistory();
    else if (S.view === 'stats') renderStats();
    else renderSettings();
  }

  /* ============================================================
     KOMPONEN
     ============================================================ */
  function txRow(t) {
    var icon = catIcon(t.cat, t.jenis);
    var meta = esc(t.cat) + (t.sumber ? ' · ' + esc(t.sumber) : '');
    return '<li><button class="tx" data-tx="' + esc(t.id) + '">' +
      '<span class="tx-icon" style="background:' + hexA(t.jenis === 'masuk' ? C_IN : catColor(t.cat, t.jenis), .14) + '">' + esc(icon) + '</span>' +
      '<span class="tx-main"><p class="tx-title">' + esc(t.keterangan || t.cat) + '</p><p class="tx-meta">' + meta + '</p></span>' +
      '<span class="tx-amt money' + (t.jenis === 'masuk' ? ' in' : '') + '">' + (t.jenis === 'masuk' ? '+' : '−') + rp(t.nominal) +
      (t._pending ? '<i class="tx-pending" title="Belum terkirim"></i>' : '') + '</span></button></li>';
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function txGroups(list) {
    var groups = [], cur = null;
    list.forEach(function (t) {
      if (!cur || cur.date !== t.tanggal) { cur = { date: t.tanggal, items: [], out: 0, inn: 0 }; groups.push(cur); }
      cur.items.push(t);
      if (t.jenis === 'masuk') cur.inn += t.nominal; else cur.out += t.nominal;
    });
    return groups.map(function (g) {
      var tot = (g.out ? '−' + rp(g.out) : '') + (g.inn ? (g.out ? '  ' : '') + '+' + rp(g.inn) : '');
      return '<div class="tx-group"><div class="tx-day"><span>' + esc(dayLabel(g.date)) + '</span><span class="money">' + tot + '</span></div>' +
        '<ul class="tx-list card">' + g.items.map(txRow).join('') + '</ul></div>';
    }).join('');
  }
  function bindTxRows(root) {
    $$('[data-tx]', root).forEach(function (b) { b.addEventListener('click', function () { openDetail(b.dataset.tx); }); });
  }
  function emptyState(icon, title, text, cta) {
    return '<div class="empty"><div class="empty-art">' + icon + '</div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      (cta ? '<button class="btn btn-primary" data-empty-cta>' + esc(cta) + '</button>' : '') + '</div>';
  }
  function skeleton() {
    return '<div class="skeleton" style="height:180px;border-radius:28px;margin-top:14px"></div>' +
      '<div class="skeleton" style="height:22px;width:40%;margin:26px 4px 12px"></div>' +
      '<div class="skeleton" style="height:64px;margin-bottom:8px"></div><div class="skeleton" style="height:64px;margin-bottom:8px"></div><div class="skeleton" style="height:64px"></div>';
  }

  /* ============================================================
     BERANDA
     ============================================================ */
  function renderHome() {
    var root = $('#view-home');
    if (!S.server) { root.innerHTML = skeleton(); return; }
    var all = txList();
    var r = periodRange(S.period);
    var list = inRange(all, r.from, r.to);
    var inn = sum(list, 'masuk'), out = sum(list, 'keluar');
    var html = periodChips();

    html += '<section class="hero" aria-label="Ringkasan">' +
      '<p class="hero-label">Saldo bersih</p>' +
      '<p class="hero-amount money"><span class="rp">' + (inn - out < 0 ? '−Rp' : 'Rp') + '</span>' + fmt(Math.abs(inn - out)) + '</p>' +
      '<p class="hero-period">' + esc(r.label) + '</p>' +
      '<div class="hero-split">' +
      '<div class="glass"><p class="glass-label"><i>↓</i>Pemasukan</p><p class="glass-value money">' + rp(inn) + '</p></div>' +
      '<div class="glass"><p class="glass-label"><i>↑</i>Pengeluaran</p><p class="glass-value money">' + rp(out) + '</p></div>' +
      '</div></section>';

    // Pengingat gaji di awal bulan
    var monthStart = today().slice(0, 8) + '01';
    var hasIncomeThisMonth = all.some(function (t) { return t.jenis === 'masuk' && t.tanggal >= monthStart && t.tanggal <= today(); });
    if (!hasIncomeThisMonth && S.prefs.gajiDismiss !== today().slice(0, 7)) {
      html += '<div class="nudge"><span class="nudge-icon">💼</span><span class="nudge-text"><strong>Gaji bulan ini belum dicatat</strong>' +
        '<span>Catat sekali, saldo bulan ini langsung akurat. <button class="link-btn" id="nudge-later">Nanti saja</button></span></span><button class="btn btn-dark btn-sm" id="nudge-gaji">Catat</button></div>';
    }
    if (S.installEvt && !S.prefs.installDismiss) {
      html += '<div class="nudge nudge-install"><span class="nudge-icon">📲</span><span class="nudge-text"><strong>Pasang di layar utama</strong>' +
        '<span>Buka seperti aplikasi biasa, langsung dari HP.</span></span><button class="btn btn-primary btn-sm" id="nudge-install">Pasang</button></div>';
    }

    if (!all.length) {
      html += emptyState('🧾', 'Belum ada transaksi', 'Catat pengeluaran pertamamu. Cukup isi nominal dan pilih kategori.', 'Tambah transaksi');
      root.innerHTML = html;
      bindHome(root);
      return;
    }

    html += budgetSection();

    // Insight singkat
    var ins = computeInsights(r, all);
    html += '<section class="section"><div class="section-head"><h2 class="section-title">Sorotan</h2>' +
      '<button class="section-link" data-goto="stats">Analisis lengkap</button></div><div class="tiles">';
    html += tile('Pengeluaran terbesar', ins.topCat ? esc(catIcon(ins.topCat.name, 'keluar')) + ' ' + esc(ins.topCat.name) : '—',
      ins.topCat ? rp(ins.topCat.value) + ' · ' + Math.round(ins.topCat.share * 100) + '%' : 'Belum ada pengeluaran');
    html += tile('Rata-rata per hari', rp(ins.avgDaily), 'dari ' + r.days + ' hari');
    if (ins.prevOut > 0) {
      var up = ins.delta > 0;
      html += '<div class="card tile tile-wide"><p class="tile-label">Dibanding ' + PREV_LABEL[r.type] + '</p>' +
        '<p class="tile-value"><span class="delta ' + (up ? 'up' : 'down') + '">' + (up ? '▲ ' : '▼ ') + Math.abs(Math.round(ins.delta * 100)) + '%</span> ' +
        (up ? 'lebih boros' : 'lebih hemat') + '</p><p class="tile-sub money">' + rp(out) + ' vs ' + rp(ins.prevOut) + '</p></div>';
    }
    html += '</div></section>';

    // Transaksi terakhir
    var recent = all.slice(0, 6);
    html += '<section class="section"><div class="section-head"><h2 class="section-title">Transaksi terakhir</h2>' +
      '<button class="section-link" data-goto="history">Lihat semua</button></div>' + txGroups(recent) + '</section>';

    root.innerHTML = html;
    bindHome(root);
  }
  function tile(label, value, sub) {
    return '<div class="card tile"><p class="tile-label">' + label + '</p><p class="tile-value">' + value + '</p><p class="tile-sub money">' + sub + '</p></div>';
  }
  function bindHome(root) {
    bindPeriod(root, renderHome);
    bindTxRows(root);
    $$('[data-goto]', root).forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.goto); }); });
    var cta = $('[data-empty-cta]', root); if (cta) cta.addEventListener('click', function () { openForm({}); });
    var g = $('#nudge-gaji', root);
    if (g) g.addEventListener('click', function () {
      var lastGaji = txList().filter(function (t) { return t.jenis === 'masuk' && t.cat === 'Gaji'; })[0];
      openForm({ preset: { jenis: 'masuk', kategori: 'Gaji', keterangan: 'Gaji ' + BULAN[new Date().getMonth()], nominal: lastGaji ? lastGaji.nominal : '', sumber: lastGaji ? lastGaji.sumber : '' } });
    });
    var later = $('#nudge-later', root);
    if (later) later.addEventListener('click', function () { S.prefs.gajiDismiss = today().slice(0, 7); savePrefs(); renderHome(); });
    var ib = $('#nudge-install', root);
    if (ib) ib.addEventListener('click', promptInstall);
  }

  function budgetSection() {
    var cats = categories('keluar').filter(function (c) { return c.anggaran > 0; });
    if (!cats.length) return '';
    var t = today(), d = parse(t);
    var from = t.slice(0, 8) + '01', to = t.slice(0, 8) + pad(monthLen(d.getFullYear(), d.getMonth() + 1));
    var list = inRange(txList(), from, to).filter(function (x) { return x.jenis === 'keluar'; });
    var dayFrac = d.getDate() / monthLen(d.getFullYear(), d.getMonth() + 1);
    var rows = cats.map(function (c) {
      var spent = list.filter(function (x) { return x.cat === c.nama; }).reduce(function (s, x) { return s + x.nominal; }, 0);
      var pct = spent / c.anggaran;
      var projected = dayFrac > 0.15 ? spent / dayFrac : spent;
      var cls = pct >= 1 ? 'is-over' : (pct >= 0.8 || projected > c.anggaran * 1.05) ? 'is-warn' : '';
      var note = pct >= 1 ? '⚠ Lewat ' + rp(spent - c.anggaran) + ' dari anggaran'
        : projected > c.anggaran * 1.05 ? '⚠ Dengan laju sekarang, diperkirakan ' + rp(projected) + ' di akhir bulan'
        : 'Sisa ' + rp(c.anggaran - spent);
      return '<div class="budget-row"><div class="budget-top"><span>' + esc(c.ikon) + ' ' + esc(c.nama) + '</span><span class="money">' + rp(spent) + ' / ' + rpShort(c.anggaran) + '</span></div>' +
        '<div class="bar ' + cls + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct * 100) + '" aria-label="' + esc(c.nama) + '"><i style="width:' + Math.min(100, pct * 100).toFixed(1) + '%"></i></div>' +
        '<div class="budget-note ' + (pct >= 1 ? 'is-over' : '') + '">' + note + '</div></div>';
    }).join('');
    return '<section class="section"><div class="section-head"><h2 class="section-title">Anggaran ' + BULAN[d.getMonth()] + '</h2>' +
      '<button class="section-link" data-goto="settings">Atur</button></div><div class="card card-pad">' + rows + '</div></section>';
  }

  /* ============================================================
     INSIGHT
     ============================================================ */
  function computeInsights(r, all) {
    var list = inRange(all, r.from, r.to);
    var out = list.filter(function (t) { return t.jenis === 'keluar'; });
    var totalOut = sum(out), totalIn = sum(list, 'masuk');
    var byCat = {};
    out.forEach(function (t) { byCat[t.cat] = (byCat[t.cat] || 0) + t.nominal; });
    var cats = Object.keys(byCat).map(function (k) { return { name: k, value: byCat[k], share: totalOut ? byCat[k] / totalOut : 0 }; })
      .sort(function (a, b) { return b.value - a.value; });
    var prevList = inRange(all, r.prevFrom, r.prevTo);
    var prevOut = sum(prevList, 'keluar');
    var prevByCat = {};
    prevList.forEach(function (t) { if (t.jenis === 'keluar') prevByCat[t.cat] = (prevByCat[t.cat] || 0) + t.nominal; });
    var biggest = out.slice().sort(function (a, b) { return b.nominal - a.nominal; })[0];
    var freq = {};
    out.forEach(function (t) { var k = norm(t.keterangan); if (k) { freq[k] = freq[k] || { n: 0, v: 0, label: t.keterangan }; freq[k].n++; freq[k].v += t.nominal; } });
    var topFreq = Object.keys(freq).map(function (k) { return freq[k]; }).sort(function (a, b) { return b.n - a.n || b.v - a.v; })[0];
    var byDow = [0, 0, 0, 0, 0, 0, 0], dowCount = [0, 0, 0, 0, 0, 0, 0];
    var effTo = r.to < today() ? r.to : today();
    for (var d = r.from; d <= effTo; d = addDays(d, 1)) dowCount[parse(d).getDay()]++;
    out.forEach(function (t) { byDow[parse(t.tanggal).getDay()] += t.nominal; });
    var dowAvg = byDow.map(function (v, i) { return dowCount[i] ? v / dowCount[i] : 0; });
    var topDow = dowAvg.indexOf(Math.max.apply(null, dowAvg));
    // kategori yang paling naik
    var rise = cats.map(function (c) { return { name: c.name, diff: c.value - (prevByCat[c.name] || 0), prev: prevByCat[c.name] || 0, value: c.value }; })
      .sort(function (a, b) { return b.diff - a.diff; })[0];
    return {
      totalOut: totalOut, totalIn: totalIn, cats: cats, topCat: cats[0],
      avgDaily: r.days ? totalOut / r.days : 0, prevOut: prevOut,
      delta: prevOut ? (totalOut - prevOut) / prevOut : 0,
      biggest: biggest, topFreq: topFreq, topDow: r.days >= 14 && totalOut ? topDow : -1, dowAvg: dowAvg,
      rise: rise && rise.diff > 0 && rise.prev > 0 ? rise : null,
      saving: totalIn > 0 ? (totalIn - totalOut) / totalIn : null
    };
  }

  /* ============================================================
     RIWAYAT
     ============================================================ */
  function renderHistory() {
    var root = $('#view-history');
    if (!S.server) { root.innerHTML = skeleton(); delete root.dataset.ready; return; }
    if (!root.dataset.ready) {
      root.dataset.ready = '1';
      var cats = categories('keluar').concat(categories('masuk'));
      root.innerHTML =
        '<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="search" id="h-q" placeholder="Cari keterangan, mis. bensin" autocomplete="off" aria-label="Cari transaksi"></div>' +
        '<div class="chips" style="margin-top:10px" id="h-jenis">' +
        [['all', 'Semua'], ['keluar', 'Pengeluaran'], ['masuk', 'Pemasukan']].map(function (j) {
          return '<button class="chip chip-sm" data-jenis="' + j[0] + '">' + j[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="filter-row"><select id="h-kat" aria-label="Filter kategori"><option value="">Semua kategori</option></select></div>' +
        '<div class="filter-row"><input type="date" id="h-from" aria-label="Dari tanggal"><input type="date" id="h-to" aria-label="Sampai tanggal"></div>' +
        '<div id="h-results"></div>';
      var q = $('#h-q', root);
      q.addEventListener('input', debounce(function () { S.hist.q = q.value; S.hist.limit = 60; renderHistoryList(); }, 180));
      $$('#h-jenis [data-jenis]', root).forEach(function (b) {
        b.addEventListener('click', function () { S.hist.jenis = b.dataset.jenis; S.hist.kat = ''; S.hist.limit = 60; renderHistoryList(); });
      });
      $('#h-kat', root).addEventListener('change', function (e) { S.hist.kat = e.target.value; S.hist.limit = 60; renderHistoryList(); });
      $('#h-from', root).addEventListener('change', function (e) { S.hist.from = e.target.value; S.hist.limit = 60; renderHistoryList(); });
      $('#h-to', root).addEventListener('change', function (e) { S.hist.to = e.target.value; S.hist.limit = 60; renderHistoryList(); });
    }
    renderHistoryList();
  }
  function renderHistoryList() {
    var root = $('#view-history');
    var h = S.hist;
    $$('#h-jenis [data-jenis]', root).forEach(function (b) { b.classList.toggle('is-active', b.dataset.jenis === h.jenis); });
    var sel = $('#h-kat', root);
    var cats = h.jenis === 'all' ? categories('keluar').concat(categories('masuk')) : categories(h.jenis);
    var seen = {};
    sel.innerHTML = '<option value="">Semua kategori</option>' + cats.filter(function (c) {
      var k = c.nama; if (seen[k]) return false; seen[k] = 1; return true;
    }).map(function (c) { return '<option' + (c.nama === h.kat ? ' selected' : '') + ' value="' + esc(c.nama) + '">' + esc(c.ikon + ' ' + c.nama) + '</option>'; }).join('');
    $('#h-from', root).value = h.from; $('#h-to', root).value = h.to;

    var q = norm(h.q);
    var list = txList().filter(function (t) {
      if (h.jenis !== 'all' && t.jenis !== h.jenis) return false;
      if (h.kat && t.cat !== h.kat) return false;
      if (h.from && t.tanggal < h.from) return false;
      if (h.to && t.tanggal > h.to) return false;
      if (q && norm(t.keterangan + ' ' + t.cat + ' ' + t.sumber + ' ' + t.nominal).indexOf(q) < 0) return false;
      return true;
    });
    var out = $('#h-results', root);
    if (!list.length) {
      out.innerHTML = emptyState('🔍', txList().length ? 'Tidak ada yang cocok' : 'Belum ada transaksi',
        txList().length ? 'Coba kata lain atau hapus filter tanggal dan kategori.' : 'Transaksi yang kamu catat akan muncul di sini.',
        txList().length ? 'Hapus semua filter' : 'Tambah transaksi');
      var cta = $('[data-empty-cta]', out);
      cta.addEventListener('click', function () {
        if (txList().length) { S.hist = { q: '', jenis: 'all', kat: '', from: '', to: '', limit: 60 }; $('#h-q', root).value = ''; renderHistoryList(); }
        else openForm({});
      });
      return;
    }
    var shown = list.slice(0, h.limit);
    out.innerHTML = '<div class="result-summary"><span>' + list.length + ' transaksi</span><span class="money">' +
      (sum(list, 'keluar') ? 'Keluar <b>' + rp(sum(list, 'keluar')) + '</b>' : '') +
      (sum(list, 'masuk') ? ' · Masuk <b>' + rp(sum(list, 'masuk')) + '</b>' : '') + '</span></div>' +
      txGroups(shown) +
      (list.length > shown.length ? '<button class="btn btn-outline btn-block" style="margin-top:14px" id="h-more">Tampilkan lebih banyak (' + (list.length - shown.length) + ' lagi)</button>' : '');
    bindTxRows(out);
    var more = $('#h-more', out);
    if (more) more.addEventListener('click', function () { S.hist.limit += 80; renderHistoryList(); });
  }

  /* ============================================================
     ANALISIS (grafik + insight)
     ============================================================ */
  function renderStats() {
    var root = $('#view-stats');
    if (!S.server) { root.innerHTML = skeleton(); return; }
    var all = txList();
    var r = periodRange(S.period);
    var ins = computeInsights(r, all);
    var html = periodChips();
    if (!all.length) {
      root.innerHTML = html + emptyState('📊', 'Grafik akan muncul di sini', 'Setelah ada transaksi, kamu bisa melihat ke mana uangmu pergi.', 'Tambah transaksi');
      bindPeriod(root, renderStats);
      $('[data-empty-cta]', root).addEventListener('click', function () { openForm({}); });
      return;
    }

    // 1) Per kategori
    html += '<section class="section card chart-card" id="c-cat"><div class="chart-head"><div><h2 class="chart-title">Pengeluaran per kategori</h2>' +
      '<p class="chart-sub">' + esc(r.label) + '</p></div><button class="chart-toggle" data-table="cat">Tabel</button></div><div class="chart-body"></div></section>';
    // 2) Tren
    var daily = daysBetween(r.from, r.to) <= 62;
    html += '<section class="section card chart-card" id="c-trend"><div class="chart-head"><div><h2 class="chart-title">Tren pengeluaran ' + (daily ? 'harian' : 'bulanan') + '</h2>' +
      '<p class="chart-sub">Ketuk batang untuk melihat nilainya</p></div><button class="chart-toggle" data-table="trend">Tabel</button></div><div class="chart-body"></div></section>';
    // 3) Pemasukan vs pengeluaran
    html += '<section class="section card chart-card" id="c-vs"><div class="chart-head"><div><h2 class="chart-title">Pemasukan vs pengeluaran</h2>' +
      '<p class="chart-sub">6 bulan terakhir</p></div><button class="chart-toggle" data-table="vs">Tabel</button></div><div class="chart-body"></div></section>';
    // 4) Insight
    html += '<section class="section"><div class="section-head"><h2 class="section-title">Insight</h2></div><div class="card card-pad"><ul class="insights">' + insightItems(ins, r) + '</ul></div></section>';
    root.innerHTML = html;
    bindPeriod(root, renderStats);

    var catData = ins.cats;
    var trend = trendData(r, all, daily);
    var vs = vsData(r, all);
    var views = { cat: false, trend: false, vs: false };
    function draw(which) {
      if (which === 'cat') {
        var body = $('#c-cat .chart-body');
        if (!catData.length) { body.innerHTML = '<p class="muted">Tidak ada pengeluaran di periode ini.</p>'; return; }
        body.innerHTML = views.cat ? table(['Kategori', 'Nominal', '%'], catData.map(function (c) { return [c.name, rp(c.value), Math.round(c.share * 100) + '%']; }))
          : donutChart(catData, ins.totalOut) + catRows(catData);
        if (!views.cat) bindDonut(body, catData, ins.totalOut);
      } else if (which === 'trend') {
        var tb = $('#c-trend .chart-body');
        tb.innerHTML = views.trend ? table([daily ? 'Tanggal' : 'Bulan', 'Pengeluaran'], trend.filter(function (d) { return d.value > 0; }).map(function (d) { return [d.full, rp(d.value)]; }))
          : barChart(trend, { avg: trend.avg, color: C_OUT, highlight: today() });
        if (!views.trend) bindBars(tb, trend, function (d) { return [{ v: rp(d.value), l: d.full }]; });
      } else {
        var vb = $('#c-vs .chart-body');
        vb.innerHTML = views.vs ? table(['Bulan', 'Masuk', 'Keluar', 'Selisih'], vs.map(function (d) { return [d.full, rp(d.a), rp(d.b), rp(d.a - d.b)]; }))
          : '<div class="legend-inline"><span><i style="background:' + C_IN + '"></i>Pemasukan</span><span><i style="background:' + C_OUT + '"></i>Pengeluaran</span></div>' + groupedChart(vs);
        if (!views.vs) bindBars(vb, vs, function (d) { return [{ v: rp(d.a), l: 'Pemasukan', c: C_IN }, { v: rp(d.b), l: 'Pengeluaran', c: C_OUT }, { v: rp(d.a - d.b), l: 'Selisih ' + d.full }]; });
      }
    }
    ['cat', 'trend', 'vs'].forEach(draw);
    $$('[data-table]', root).forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.table; views[k] = !views[k]; b.textContent = views[k] ? 'Grafik' : 'Tabel'; hideTip(); draw(k);
      });
    });
  }

  function insightItems(ins, r) {
    var items = [];
    if (ins.topCat) items.push(['🏆', 'Kategori terbesar adalah <strong>' + esc(ins.topCat.name) + '</strong>: ' + rp(ins.topCat.value) + ' (' + Math.round(ins.topCat.share * 100) + '% dari pengeluaran).']);
    items.push(['📅', 'Rata-rata pengeluaran <strong>' + rp(ins.avgDaily) + ' per hari</strong> selama ' + r.days + ' hari.']);
    if (ins.prevOut > 0) {
      var up = ins.delta > 0;
      items.push([up ? '📈' : '📉', 'Dibanding ' + PREV_LABEL[r.type] + ', pengeluaran <strong>' + (up ? 'naik ' : 'turun ') + Math.abs(Math.round(ins.delta * 100)) + '%</strong> (' + rp(ins.prevOut) + ' → ' + rp(ins.totalOut) + ').']);
    }
    if (ins.rise) items.push(['🔺', 'Kenaikan terbesar ada di <strong>' + esc(ins.rise.name) + '</strong>: +' + rp(ins.rise.diff) + ' dibanding ' + PREV_LABEL[r.type] + '.']);
    if (ins.saving !== null) {
      items.push([ins.saving >= 0 ? '🐷' : '⚠️', ins.saving >= 0
        ? 'Kamu menyisihkan <strong>' + Math.round(ins.saving * 100) + '%</strong> dari pemasukan (' + rp(ins.totalIn - ins.totalOut) + ').'
        : 'Pengeluaran melebihi pemasukan sebesar <strong>' + rp(ins.totalOut - ins.totalIn) + '</strong>.']);
    }
    if (ins.biggest) items.push(['💸', 'Transaksi terbesar: <strong>' + esc(ins.biggest.keterangan || ins.biggest.cat) + '</strong> ' + rp(ins.biggest.nominal) + ' pada ' + dateShort(ins.biggest.tanggal) + '.']);
    if (ins.topFreq && ins.topFreq.n >= 3) items.push(['🔁', 'Paling sering: <strong>' + esc(ins.topFreq.label) + '</strong> ' + ins.topFreq.n + '× (total ' + rp(ins.topFreq.v) + ').']);
    if (ins.topDow >= 0) items.push(['🗓️', 'Hari paling boros rata-rata: <strong>' + HARI[ins.topDow] + '</strong> (' + rp(ins.dowAvg[ins.topDow]) + ').']);
    return items.map(function (i) { return '<li><span class="ii">' + i[0] + '</span><p>' + i[1] + '</p></li>'; }).join('');
  }

  function trendData(r, all, daily) {
    var out = inRange(all, r.from, r.to).filter(function (t) { return t.jenis === 'keluar'; });
    var data = [];
    if (daily) {
      var map = {};
      out.forEach(function (t) { map[t.tanggal] = (map[t.tanggal] || 0) + t.nominal; });
      for (var d = r.from; d <= r.to; d = addDays(d, 1)) data.push({ key: d, label: String(+d.slice(8)), full: dayLabel(d) + (d === today() || d === addDays(today(), -1) ? ', ' + dateShort(d) : ''), value: map[d] || 0, future: d > today() });
    } else {
      var mm = {};
      out.forEach(function (t) { var k = t.tanggal.slice(0, 7); mm[k] = (mm[k] || 0) + t.nominal; });
      var cur = r.from.slice(0, 7);
      while (cur <= r.to.slice(0, 7)) {
        var y = +cur.slice(0, 4), m = +cur.slice(5, 7);
        data.push({ key: cur, label: BLN[m - 1], full: BULAN[m - 1] + ' ' + y, value: mm[cur] || 0, future: cur > today().slice(0, 7) });
        cur = m === 12 ? (y + 1) + '-01' : y + '-' + pad(m + 1);
      }
    }
    var past = data.filter(function (x) { return !x.future; });
    data.avg = past.length ? past.reduce(function (s, x) { return s + x.value; }, 0) / past.length : 0;
    return data;
  }
  function vsData(r, all) {
    var end = r.to > today() ? today() : r.to;
    var y = +end.slice(0, 4), m = +end.slice(5, 7);
    var res = [];
    for (var i = 5; i >= 0; i--) {
      var mm = m - i, yy = y;
      while (mm < 1) { mm += 12; yy--; }
      var key = yy + '-' + pad(mm);
      var list = all.filter(function (t) { return t.tanggal.slice(0, 7) === key; });
      res.push({ key: key, label: BLN[mm - 1], full: BULAN[mm - 1] + ' ' + yy, a: sum(list, 'masuk'), b: sum(list, 'keluar') });
    }
    return res;
  }

  /* ---------------- Grafik SVG ---------------- */
  function table(head, rows) {
    return '<table class="data-table"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * p;
  }
  function barPath(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }
  function axisFrame(W, H, L, B, T, max) {
    var g = '';
    [0, 0.5, 1].forEach(function (f) {
      var y = T + (H - T - B) * (1 - f);
      g += '<line class="' + (f === 0 ? 'baseline' : 'grid') + '" x1="' + L + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/>';
      g += '<text class="axis-text" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + (f === 0 ? '0' : rpShort(max * f)) + '</text>';
    });
    return g;
  }
  function barChart(data, opt) {
    var W = 340, H = 180, L = 40, B = 22, T = 10;
    var max = niceMax(Math.max.apply(null, data.map(function (d) { return d.value; }).concat([opt.avg || 0, 1])));
    var band = (W - L) / data.length, bw = Math.max(2, Math.min(18, band - 2));
    var ph = H - T - B;
    var every = Math.ceil(data.length / 8), lastLab = -99;
    var svg = '<div class="chart" data-chart><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Grafik batang pengeluaran">' + axisFrame(W, H, L, B, T, max);
    data.forEach(function (d, i) {
      var h = d.value / max * ph, x = L + i * band + (band - bw) / 2, y = T + ph - h;
      var col = d.key === opt.highlight ? C_OUT : hexA(opt.color, d.future ? 0.2 : 0.78);
      svg += '<path class="mark" data-i="' + i + '" d="' + barPath(x, y, bw, h, 4) + '" fill="' + col + '"/>';
      if ((i % every === 0 && data.length - 1 - i >= every / 2) || i === data.length - 1) lastLab = i, svg += '<text class="axis-text" x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>';
      svg += '<rect class="hit" data-i="' + i + '" x="' + (L + i * band) + '" y="' + T + '" width="' + band + '" height="' + ph + '" tabindex="0" aria-label="' + esc(d.full + ': ' + rp(d.value)) + '"/>';
    });
    if (opt.avg > 0) {
      var ay = T + ph - opt.avg / max * ph;
      svg += '<line class="avg" x1="' + L + '" x2="' + W + '" y1="' + ay + '" y2="' + ay + '"/>' +
        '<text class="avg-label" x="' + W + '" y="' + (ay - 5) + '" text-anchor="end">rata-rata ' + rpShort(opt.avg) + '</text>';
    }
    return svg + '</svg></div>';
  }
  function groupedChart(data) {
    var W = 340, H = 190, L = 40, B = 22, T = 10;
    var max = niceMax(Math.max.apply(null, data.map(function (d) { return Math.max(d.a, d.b); }).concat([1])));
    var band = (W - L) / data.length, bw = Math.min(16, (band - 14) / 2), ph = H - T - B;
    var svg = '<div class="chart" data-chart><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Pemasukan dan pengeluaran per bulan">' + axisFrame(W, H, L, B, T, max);
    data.forEach(function (d, i) {
      var cx = L + i * band + band / 2;
      var ha = d.a / max * ph, hb = d.b / max * ph;
      svg += '<path class="mark" data-i="' + i + '" d="' + barPath(cx - bw - 1, T + ph - ha, bw, ha, 4) + '" fill="' + C_IN + '"/>';
      svg += '<path class="mark" data-i="' + i + '" d="' + barPath(cx + 1, T + ph - hb, bw, hb, 4) + '" fill="' + C_OUT + '"/>';
      svg += '<text class="axis-text" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>';
      svg += '<rect class="hit" data-i="' + i + '" x="' + (L + i * band) + '" y="' + T + '" width="' + band + '" height="' + ph + '" tabindex="0" aria-label="' + esc(d.full + ': masuk ' + rp(d.a) + ', keluar ' + rp(d.b)) + '"/>';
    });
    return svg + '</svg></div>';
  }
  function bindBars(body, data, rowsFn) {
    var chart = $('[data-chart]', body);
    if (!chart) return;
    $$('.hit', chart).forEach(function (hit) {
      var show = function () {
        var i = +hit.dataset.i;
        chart.classList.add('has-focus');
        $$('.mark', chart).forEach(function (m) { m.classList.toggle('is-focus', +m.dataset.i === i); });
        var marks = $$('.mark[data-i="' + i + '"]', chart);
        var top = Infinity, left = 0, right = 0;
        marks.forEach(function (m) { var b = m.getBoundingClientRect(); if (b.height) top = Math.min(top, b.top); left = left || b.left; right = Math.max(right, b.right); });
        var hb = hit.getBoundingClientRect();
        if (top === Infinity) top = hb.bottom - 4;
        showTip(rowsFn(data[i]), (hb.left + hb.right) / 2, top);
      };
      hit.addEventListener('click', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') show(); });
    });
    chart.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { chart.classList.remove('has-focus'); hideTip(); } });
  }
  function showTip(rows, x, y) {
    var tip = $('#tooltip');
    tip.innerHTML = '';
    rows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'tr';
      if (r.c) { var k = document.createElement('i'); k.style.background = r.c; row.appendChild(k); }
      var v = document.createElement('span'); v.className = i === 0 || r.c ? 'tv' : 'tl'; v.textContent = r.v;
      var l = document.createElement('span'); l.className = 'tl'; l.textContent = r.l;
      row.appendChild(v); row.appendChild(l);
      tip.appendChild(row);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, vw = window.innerWidth;
    x = Math.max(w / 2 + 8, Math.min(vw - w / 2 - 8, x));
    tip.style.left = x + 'px';
    tip.style.top = Math.max(tip.offsetHeight + 16, y) + 'px';
  }
  function hideTip() {
    var tip = $('#tooltip'); if (tip) tip.hidden = true;
    $$('[data-chart].has-focus').forEach(function (c) { c.classList.remove('has-focus'); });
  }

  function foldCats(cats) {
    // maksimal 6 irisan + "Lainnya" agar warna tetap terbaca
    var top = cats.slice(0, 6), rest = cats.slice(6);
    var res = top.map(function (c) { return { name: c.name, value: c.value, share: c.share, color: catColor(c.name, 'keluar') }; });
    if (rest.length) {
      var v = rest.reduce(function (s, c) { return s + c.value; }, 0);
      var existing = res.filter(function (c) { return norm(c.name) === 'lainnya'; })[0];
      if (existing) { existing.value += v; existing.share += rest.reduce(function (s, c) { return s + c.share; }, 0); existing.folded = true; }
      else res.push({ name: 'Lainnya', value: v, share: rest.reduce(function (s, c) { return s + c.share; }, 0), color: NEUTRAL, folded: true });
    }
    return res;
  }
  function donutChart(cats, total) {
    var data = foldCats(cats);
    var S0 = 150, cx = 75, cy = 75, R = 72, r0 = 50;
    var a = -Math.PI / 2, svg = '';
    data.forEach(function (d, i) {
      var ang = d.value / total * Math.PI * 2;
      var a2 = a + ang;
      var large = ang > Math.PI ? 1 : 0;
      var p = function (rad, an) { return (cx + rad * Math.cos(an)).toFixed(2) + ',' + (cy + rad * Math.sin(an)).toFixed(2); };
      var path = data.length === 1
        ? 'M' + p(R, -Math.PI / 2) + 'A' + R + ',' + R + ' 0 1 1 ' + p(R, Math.PI * 1.5 - 0.0001) + 'L' + p(r0, Math.PI * 1.5 - 0.0001) + 'A' + r0 + ',' + r0 + ' 0 1 0 ' + p(r0, -Math.PI / 2) + 'Z'
        : 'M' + p(R, a) + 'A' + R + ',' + R + ' 0 ' + large + ' 1 ' + p(R, a2) + 'L' + p(r0, a2) + 'A' + r0 + ',' + r0 + ' 0 ' + large + ' 0 ' + p(r0, a) + 'Z';
      svg += '<path class="mark seg" data-i="' + i + '" d="' + path + '" fill="' + d.color + '" stroke="#fff" stroke-width="2" stroke-linejoin="round" tabindex="0" aria-label="' + esc(d.name + ': ' + rp(d.value)) + '"/>';
      a = a2;
    });
    var legend = data.map(function (d, i) {
      return '<li><button data-i="' + i + '"><span class="sw" style="background:' + d.color + '"></span><span>' + esc(d.name) + '</span><span class="lv">' + Math.round(d.share * 100) + '%</span></button></li>';
    }).join('');
    return '<div class="donut-wrap"><div class="chart" data-chart data-donut><svg viewBox="0 0 ' + S0 + ' ' + S0 + '" role="img" aria-label="Diagram donat pengeluaran per kategori">' + svg +
      '<text class="donut-center-label" x="75" y="70" text-anchor="middle" id="dc-l">Total</text><text class="donut-center-value" x="75" y="89" text-anchor="middle" id="dc-v">' + rpShort(total) + '</text></svg></div>' +
      '<ul class="legend">' + legend + '</ul></div>';
  }
  function catRows(cats) {
    var max = cats[0] ? cats[0].value : 1;
    return '<div class="cat-rows">' + cats.map(function (c) {
      var col = catColor(c.name, 'keluar');
      return '<div class="cat-row" style="--c:' + col + '"><span class="tx-icon" style="background:' + hexA(col, .14) + '">' + esc(catIcon(c.name, 'keluar')) + '</span>' +
        '<div><div class="name">' + esc(c.name) + '</div><div class="bar"><i style="width:' + (c.value / max * 100).toFixed(1) + '%"></i></div></div>' +
        '<div class="val money">' + rp(c.value) + '<small>' + (c.share * 100).toFixed(c.share < 0.1 ? 1 : 0).replace('.', ',') + '%</small></div></div>';
    }).join('') + '</div>';
  }
  function bindDonut(body, cats, total) {
    var data = foldCats(cats);
    var chart = $('[data-donut]', body);
    var focus = -1;
    function set(i) {
      focus = focus === i ? -1 : i;
      chart.classList.toggle('has-focus', focus >= 0);
      $$('.seg', chart).forEach(function (s) { s.classList.toggle('is-focus', +s.dataset.i === focus); });
      $$('.legend button', body).forEach(function (b) { b.classList.toggle('is-focus', +b.dataset.i === focus); });
      $('#dc-l', chart).textContent = focus >= 0 ? truncate(data[focus].name, 16) : 'Total';
      $('#dc-v', chart).textContent = rpShort(focus >= 0 ? data[focus].value : total);
    }
    $$('.seg', chart).forEach(function (s) { s.addEventListener('click', function () { set(+s.dataset.i); }); s.addEventListener('keydown', function (e) { if (e.key === 'Enter') set(+s.dataset.i); }); });
    $$('.legend button', body).forEach(function (b) { b.addEventListener('click', function () { set(+b.dataset.i); }); });
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* ============================================================
     PENGATURAN
     ============================================================ */
  function renderSettings() {
    var root = $('#view-settings');
    var cfg = S.cfg;
    var status = S.demo ? ['off', 'Mode contoh'] : S.authError ? ['err', 'Kunci ditolak'] : S.online ? ['', 'Terhubung'] : ['off', 'Offline'];
    var html = '<section class="section" style="margin-top:8px"><div class="section-head"><h2 class="section-title">Koneksi spreadsheet</h2></div><div class="card"><ul class="set-list">' +
      '<li class="set-item"><span class="k">Status</span><span class="v"><i class="status-dot ' + status[0] + '"></i>' + status[1] + '</span></li>' +
      (S.server && S.server.meta && S.server.meta.sheetName ? '<li class="set-item"><span class="k">Spreadsheet</span><span class="v">' + esc(S.server.meta.sheetName) + '</span></li>' : '') +
      (cfg && !S.demo ? '<li class="set-item"><span class="k">URL</span><span class="v">…' + esc(cfg.url.slice(-28)) + '</span></li>' : '') +
      '<li class="set-item"><span class="k">Belum terkirim</span><span class="v">' + S.queue.length + ' transaksi</span></li>' +
      '<li class="set-item"><span class="k">Terakhir sinkron</span><span class="v">' + (S.lastSync ? esc(new Date(S.lastSync).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })) : '—') + '</span></li>' +
      '</ul><div class="card-pad" style="display:grid;gap:8px;padding-top:4px">' +
      (S.queue.length ? '<button class="btn btn-dark btn-block" id="s-sync">Kirim sekarang</button>' : '') +
      '<button class="btn btn-outline btn-block" id="s-reconnect">' + (S.demo ? 'Hubungkan spreadsheet' : 'Ubah URL atau kunci') + '</button>' +
      '</div></div></section>';

    html += '<section class="section"><div class="section-head"><h2 class="section-title">Pasang di HP</h2></div><div class="card card-pad">' +
      (isStandalone() ? '<p class="muted" style="margin:0">✓ Aplikasi sudah terpasang di layar utama.</p>'
        : S.installEvt ? '<button class="btn btn-primary btn-block" id="s-install">Pasang ke layar utama</button>'
        : '<p class="muted" style="margin:0">Di Chrome Android: ketuk menu ⋮ di kanan atas, lalu pilih <b>Tambahkan ke layar utama</b> atau <b>Instal aplikasi</b>.</p>') +
      '</div></section>';

    // Anggaran
    var cats = categories('keluar');
    if (cats.length) {
      html += '<section class="section"><div class="section-head"><h2 class="section-title">Anggaran bulanan</h2></div><div class="card card-pad">' +
        '<p class="muted" style="margin:0 0 6px">Kosongkan jika tidak ingin dibatasi. Tersimpan di sheet "Kategori".</p>' +
        cats.map(function (c) {
          return '<div class="budget-edit"><span class="tx-icon" style="background:' + hexA(catColor(c.nama, 'keluar'), .14) + '">' + esc(c.ikon) + '</span>' +
            '<label for="b-' + esc(c.urut) + '">' + esc(c.nama) + '</label>' +
            '<input type="text" id="b-' + esc(c.urut) + '" class="money" inputmode="numeric" data-budget="' + esc('keluar|' + c.nama) + '" value="' + (c.anggaran ? fmt(c.anggaran) : '') + '" placeholder="Rp 0"></div>';
        }).join('') +
        '<button class="btn btn-dark btn-block" style="margin-top:10px" id="s-budget">Simpan anggaran</button></div></section>';
    }

    html += '<section class="section"><div class="section-head"><h2 class="section-title">Kategori & sumber dana</h2></div><div class="card card-pad">' +
      '<p class="muted" style="margin:0">Tambah, ubah nama, ikon, atau kata kunci kategori langsung di sheet <b>Kategori</b>. Daftar dompet ada di sheet <b>Sumber Dana</b>. Setelah mengubah, ketuk tombol muat ulang di kanan atas.</p>' +
      '<p class="muted" style="margin:10px 0 0">Transaksi lama yang belum punya kategori dikelompokkan otomatis dari keterangannya. Kalau ada yang keliru, buka transaksinya dan pilih kategori yang benar.</p>' +
      '</div></section>';

    html += '<section class="section"><div class="card"><ul class="set-list">' +
      '<li class="set-item"><span class="k">Jumlah transaksi</span><span class="v">' + (S.server ? txList().length : 0) + '</span></li>' +
      '<li class="set-item"><span class="k">Versi aplikasi</span><span class="v">' + VERSION + '</span></li>' +
      '</ul></div>' +
      '<button class="btn btn-ghost btn-block" style="margin-top:10px;color:var(--danger)" id="s-logout">' + (S.demo ? 'Keluar dari mode contoh' : 'Putuskan dari HP ini') + '</button></section>';

    root.innerHTML = html;
    var sync = $('#s-sync', root); if (sync) sync.addEventListener('click', function () { flush().then(function () { if (!S.queue.length) toast('Semua transaksi sudah terkirim', 'ok'); }); });
    $('#s-reconnect', root).addEventListener('click', function () { showConnect(true); });
    var inst = $('#s-install', root); if (inst) inst.addEventListener('click', promptInstall);
    $$('[data-budget]', root).forEach(function (inp) {
      inp.addEventListener('input', function () { var d = digits(inp.value); inp.value = d ? fmt(+d) : ''; });
    });
    var sb = $('#s-budget', root);
    if (sb) sb.addEventListener('click', function () {
      var budgets = {};
      $$('[data-budget]', root).forEach(function (inp) { budgets[inp.dataset.budget] = +digits(inp.value) || 0; });
      sb.disabled = true; sb.innerHTML = '<span class="spinner"></span>Menyimpan…';
      api('saveBudgets', { budgets: budgets }).then(function (res) {
        S.server.categories = res.categories; persistServer(); invalidate();
        toast('Anggaran tersimpan', 'ok'); renderAll();
      }, function (err) {
        toast(err.code === 'NET' ? 'Butuh koneksi internet untuk menyimpan anggaran.' : 'Gagal: ' + err.message, 'err');
        sb.disabled = false; sb.textContent = 'Simpan anggaran';
      });
    });
    $('#s-logout', root).addEventListener('click', function () {
      var pending = S.queue.length && !S.demo;
      openSheet('<div class="sheet-head"><h2 class="sheet-title" id="sheet-title">' + (S.demo ? 'Keluar dari mode contoh?' : 'Putuskan HP ini?') + '</h2></div>' +
        '<p class="confirm-text">' + (pending ? '<b>' + S.queue.length + ' transaksi belum terkirim akan hilang.</b> ' : '') +
        (S.demo ? 'Data contoh akan dihapus dari HP.' : 'Data di spreadsheet tetap aman. Kamu perlu memasukkan URL dan kunci lagi untuk memakai aplikasi.') + '</p>' +
        '<div class="btn-row"><button class="btn btn-outline" data-close>Batal</button><button class="btn btn-danger-solid" id="lo-yes">' + (S.demo ? 'Keluar' : 'Putuskan') + '</button></div>',
        function (body) {
          $('#lo-yes', body).addEventListener('click', function () {
            [LS.cfg, LS.cache, LS.queue, LS.demo, LS.demoDb, 'ku.lastSync'].forEach(store.del);
            S.cfg = null; S.demo = false; S.server = null; S.queue = []; invalidate();
            closeSheet(); showConnect(false);
          });
        });
    });
  }

  /* ============================================================
     FORM TAMBAH / UBAH
     ============================================================ */
  function quickPicks(jenis) {
    var since = addDays(today(), -90), map = {};
    txList().forEach(function (t) {
      if (t.jenis !== jenis || t.tanggal < since || !t.keterangan) return;
      var k = norm(t.keterangan) + '|' + t.nominal;
      map[k] = map[k] || { n: 0, t: t };
      map[k].n++;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (x) { return x.n >= 2; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8).map(function (x) { return x.t; });
  }

  function openForm(opts) {
    var editing = opts.tx || null;
    var p = opts.preset || {};
    var f = {
      jenis: editing ? editing.jenis : (p.jenis || S.prefs.lastJenis || 'keluar'),
      nominal: editing ? editing.nominal : (p.nominal || ''),
      kategori: editing ? (editing.kategori || '') : (p.kategori || ''),
      keterangan: editing ? editing.keterangan : (p.keterangan || ''),
      tanggal: editing ? editing.tanggal : (p.tanggal || today()),
      sumber: editing ? (editing.sumber || '') : (p.sumber || S.prefs.lastSumber || ''),
      catTouched: !!(editing && editing.kategori) || !!p.kategori
    };
    if (!editing && !p.jenis) f.jenis = 'keluar';
    if (editing && !editing.kategori) f.kategori = editing.cat; // tampilkan tebakan, simpan saat disimpan

    var html = '<div class="sheet-head"><h2 class="sheet-title" id="sheet-title">' + (editing ? 'Ubah transaksi' : 'Tambah transaksi') + '</h2>' +
      '<button class="sheet-close" data-close aria-label="Tutup">' + closeIcon + '</button></div>' +
      '<div class="seg" role="tablist" aria-label="Jenis transaksi"><button type="button" data-jenis="keluar">Pengeluaran</button><button type="button" data-jenis="masuk">Pemasukan</button></div>' +
      '<div class="amount-box" id="f-amount-box"><div class="amount-label">Nominal</div><div class="amount-row"><span class="rp">Rp</span>' +
      '<input id="f-amount" class="amount-input" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Nominal dalam rupiah" enterkeyhint="done"></div></div>' +
      '<p class="amount-error" id="f-amount-err" role="alert" hidden></p>' +
      '<div id="f-quick" class="quick"></div>' +
      '<div class="form-label"><span>Kategori</span><em id="f-cat-hint"></em></div><div class="cat-grid" id="f-cats"></div>' +
      '<div class="form-label"><span>Keterangan</span><em>opsional</em></div>' +
      '<input type="text" id="f-ket" maxlength="200" autocomplete="off" placeholder="mis. bensin, sayur, makan siang" enterkeyhint="done">' +
      '<div class="form-label"><span>Tanggal</span></div><div class="date-row" id="f-date"></div>' +
      '<div class="form-label"><span>Sumber dana</span><em>opsional</em></div><div class="chips" id="f-src"></div>' +
      '<div class="form-actions"><button class="btn btn-primary btn-block" id="f-save"></button></div>';

    openSheet(html, function (body) {
      var amt = $('#f-amount', body), ket = $('#f-ket', body);
      amt.value = f.nominal ? fmt(f.nominal) : '';
      ket.value = f.keterangan;

      function paintJenis() {
        $$('.seg button', body).forEach(function (b) { var on = b.dataset.jenis === f.jenis; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on); });
        $('#f-save', body).textContent = editing ? 'Simpan perubahan' : (f.jenis === 'masuk' ? 'Simpan pemasukan' : 'Simpan pengeluaran');
        paintCats(); paintQuick();
      }
      function paintCats() {
        var cats = categories(f.jenis);
        var suggest = !f.catTouched ? guessCategory(ket.value, f.jenis) : '';
        if (!f.catTouched) f.kategori = suggest;
        $('#f-cats', body).innerHTML = cats.map(function (c) {
          var on = c.nama === f.kategori;
          return '<button type="button" class="cat-btn' + (on ? ' is-on' : '') + (on && !f.catTouched ? ' is-suggest' : '') + '" data-cat="' + esc(c.nama) + '" aria-pressed="' + on + '"><span class="em">' + esc(c.ikon || '•') + '</span>' + esc(c.nama) + '</button>';
        }).join('');
        $('#f-cat-hint', body).textContent = suggest && !f.catTouched ? 'dipilih otomatis' : '';
        $$('[data-cat]', body).forEach(function (b) {
          b.addEventListener('click', function () {
            f.catTouched = true;
            f.kategori = f.kategori === b.dataset.cat ? '' : b.dataset.cat;
            vibrate(8); paintCats();
          });
        });
      }
      function paintQuick() {
        var box = $('#f-quick', body);
        if (editing) { box.innerHTML = ''; return; }
        var picks = quickPicks(f.jenis);
        box.innerHTML = picks.length ? '<div class="chips">' + picks.map(function (t, i) {
          return '<button type="button" class="chip chip-sm quick-chip" data-q="' + i + '">' + esc(truncate(t.keterangan, 18)) + ' <b class="money">' + rpShort(t.nominal) + '</b></button>';
        }).join('') + '</div>' : '';
        $$('[data-q]', box).forEach(function (b) {
          b.addEventListener('click', function () {
            var t = picks[+b.dataset.q];
            amt.value = fmt(t.nominal); ket.value = t.keterangan;
            f.kategori = t.kategori || t.cat; f.catTouched = true;
            if (t.sumber) f.sumber = t.sumber;
            clearAmtErr(); paintCats(); paintSrc(); vibrate(8);
          });
        });
      }
      function paintDate() {
        var t = today(), y = addDays(t, -1);
        $('#f-date', body).innerHTML =
          '<button type="button" class="chip chip-sm' + (f.tanggal === t ? ' is-active' : '') + '" data-d="' + t + '">Hari ini</button>' +
          '<button type="button" class="chip chip-sm' + (f.tanggal === y ? ' is-active' : '') + '" data-d="' + y + '">Kemarin</button>' +
          '<input type="date" id="f-tgl" value="' + f.tanggal + '" aria-label="Pilih tanggal" max="' + addDays(t, 366) + '">';
        $$('[data-d]', body).forEach(function (b) { b.addEventListener('click', function () { f.tanggal = b.dataset.d; paintDate(); }); });
        $('#f-tgl', body).addEventListener('change', function (e) { if (e.target.value) { f.tanggal = e.target.value; paintDate(); } });
      }
      function paintSrc() {
        var src = (S.server && S.server.sources) || [];
        $('#f-src', body).innerHTML = src.map(function (s) {
          return '<button type="button" class="chip chip-sm' + (f.sumber === s.nama ? ' is-active' : '') + '" data-s="' + esc(s.nama) + '">' + esc((s.ikon ? s.ikon + ' ' : '') + s.nama) + '</button>';
        }).join('');
        $$('[data-s]', body).forEach(function (b) { b.addEventListener('click', function () { f.sumber = f.sumber === b.dataset.s ? '' : b.dataset.s; paintSrc(); }); });
      }
      function clearAmtErr() { $('#f-amount-box', body).classList.remove('has-error'); $('#f-amount-err', body).hidden = true; }

      $$('.seg button', body).forEach(function (b) {
        b.addEventListener('click', function () {
          if (f.jenis === b.dataset.jenis) return;
          f.jenis = b.dataset.jenis; f.kategori = ''; f.catTouched = false; paintJenis();
        });
      });
      amt.addEventListener('input', function () {
        var d = digits(amt.value).replace(/^0+/, '').slice(0, 12);
        amt.value = d ? fmt(+d) : '';
        clearAmtErr();
      });
      amt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ket.focus(); } });
      ket.addEventListener('input', debounce(function () { if (!f.catTouched) paintCats(); }, 150));
      ket.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ket.blur(); } });

      paintJenis(); paintDate(); paintSrc();
      if (!editing && !p.nominal) setTimeout(function () { amt.focus(); }, 60);

      $('#f-save', body).addEventListener('click', function () {
        var nominal = +digits(amt.value);
        if (!amt.value.trim() || !nominal) {
          $('#f-amount-box', body).classList.add('has-error');
          var err = $('#f-amount-err', body);
          err.textContent = 'Isi nominal dulu, harus lebih dari 0.'; err.hidden = false;
          amt.focus(); vibrate([20, 40, 20]);
          return;
        }
        if (!f.tanggal) { toast('Pilih tanggal transaksi.', 'err'); return; }
        var kategori = f.kategori || guessCategory(ket.value, f.jenis) || 'Lainnya';
        var tx = {
          id: editing ? editing.id : genId(), jenis: f.jenis, tanggal: f.tanggal, nominal: nominal,
          kategori: kategori, keterangan: ket.value.trim(), sumber: f.sumber
        };
        if (editing && editing.ref) tx.ref = editing.ref;
        S.prefs.lastSumber = f.sumber; savePrefs();
        vibrate(12);
        closeSheet();
        var label = (tx.jenis === 'masuk' ? 'Pemasukan ' : 'Pengeluaran ') + rp(nominal);
        commit(editing ? 'update' : 'add', { tx: tx }, {
          ok: editing ? 'Perubahan tersimpan ke spreadsheet' : label + ' tersimpan ke spreadsheet',
          undo: editing ? null : { label: 'Urungkan', run: function () { removeTx(tx, true); } }
        });
      });
    });
  }

  /* ============================================================
     DETAIL, HAPUS, URUNGKAN
     ============================================================ */
  function findTx(id) { return txList().filter(function (t) { return t.id === id; })[0]; }

  function openDetail(id) {
    var t = findTx(id);
    if (!t) return;
    var html = '<div class="sheet-head"><h2 class="sheet-title" id="sheet-title">' + esc(t.keterangan || t.cat) + '</h2>' +
      '<button class="sheet-close" data-close aria-label="Tutup">' + closeIcon + '</button></div>' +
      '<p class="detail-amount money' + (t.jenis === 'masuk' ? ' in' : '') + '">' + (t.jenis === 'masuk' ? '+' : '−') + rp(t.nominal) + '</p>' +
      '<ul class="detail-list">' +
      '<li><span>Jenis</span><span>' + (t.jenis === 'masuk' ? 'Pemasukan' : 'Pengeluaran') + '</span></li>' +
      '<li><span>Tanggal</span><span>' + esc(HARI[parse(t.tanggal).getDay()] + ', ' + dateLong(t.tanggal)) + '</span></li>' +
      '<li><span>Kategori</span><span>' + esc(catIcon(t.cat, t.jenis) + ' ' + t.cat) + (t.autoCat ? '<br><small class="muted">dikelompokkan otomatis</small>' : '') + '</span></li>' +
      '<li><span>Sumber dana</span><span>' + (t.sumber ? esc(sourceIcon(t.sumber) + ' ' + t.sumber) : '—') + '</span></li>' +
      '<li><span>Tersimpan di</span><span>' + (t._pending ? 'Menunggu dikirim' : t.ref ? 'Sheet ' + esc(t.ref.sheet) : '—') + '</span></li>' +
      '</ul><div class="btn-row"><button class="btn btn-danger" id="d-del">Hapus</button><button class="btn btn-dark" id="d-edit">Ubah</button></div>';
    openSheet(html, function (body) {
      $('#d-edit', body).addEventListener('click', function () { closeSheet(); setTimeout(function () { openForm({ tx: t }); }, 210); });
      $('#d-del', body).addEventListener('click', function () { confirmDelete(t); });
    });
  }

  function confirmDelete(t) {
    openSheet('<div class="sheet-head"><h2 class="sheet-title" id="sheet-title">Hapus transaksi ini?</h2></div>' +
      '<p class="confirm-text"><b>' + esc(t.keterangan || t.cat) + '</b> · ' + rp(t.nominal) + ' · ' + esc(dateShort(t.tanggal)) +
      '<br>Barisnya akan dihapus dari spreadsheet.</p>' +
      '<div class="btn-row"><button class="btn btn-outline" data-close>Batal</button><button class="btn btn-danger-solid" id="c-yes">Ya, hapus</button></div>',
      function (body) {
        $('#c-yes', body).addEventListener('click', function () { closeSheet(); removeTx(t, false); });
      });
  }

  function removeTx(t, isUndoOfAdd) {
    var copy = { id: t.id, jenis: t.jenis, tanggal: t.tanggal, nominal: t.nominal, kategori: t.kategori || '', keterangan: t.keterangan, sumber: t.sumber || '' };
    commit('delete', { id: t.id, ref: t.ref }, {
      ok: isUndoOfAdd ? 'Dibatalkan' : 'Transaksi dihapus',
      undo: isUndoOfAdd ? null : { label: 'Urungkan', run: function () { commit('add', { tx: copy }, { ok: 'Transaksi dikembalikan' }); } }
    });
  }

  /* ============================================================
     HUBUNGKAN
     ============================================================ */
  function showConnect(fromSettings) {
    $('#main').hidden = true;
    $('#screen-connect').hidden = false;
    var form = $('#connect-form');
    if (S.cfg) { $('#cf-url').value = S.cfg.url; $('#cf-key').value = S.cfg.key; }
    $('#cf-error').hidden = true;
    $('#cf-demo').hidden = !!fromSettings && S.demo;
    if (fromSettings) {
      if (!$('#cf-back')) {
        var back = document.createElement('button');
        back.type = 'button'; back.id = 'cf-back'; back.className = 'btn btn-ghost btn-block'; back.textContent = 'Kembali';
        back.addEventListener('click', function () { renderAll(); go('settings'); });
        form.parentNode.insertBefore(back, $('#cf-demo').nextSibling);
      }
    } else { var b = $('#cf-back'); if (b) b.remove(); }
  }

  function bindConnect() {
    $('#connect-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var url = $('#cf-url').value.trim(), key = $('#cf-key').value.trim();
      var err = $('#cf-error');
      err.hidden = true;
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { err.textContent = 'URL harus diawali https://script.google.com/macros/s/ dan berakhiran /exec.'; err.hidden = false; return; }
      if (key.length < 10) { err.textContent = 'Kunci terlalu pendek. Salin dari menu "Tampilkan kunci aplikasi" di spreadsheet.'; err.hidden = false; return; }
      var btn = $('#cf-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Menghubungkan…';
      var prev = { cfg: S.cfg, demo: S.demo };
      S.cfg = { url: url, key: key }; S.demo = false;
      api('bootstrap').then(function (data) {
        store.set(LS.cfg, S.cfg); store.set(LS.demo, false); store.del(LS.demoDb);
        if (prev.demo) { S.queue = []; persistQueue(); }
        S.server = data; S.authError = false; S.online = true;
        S.lastSync = new Date().toISOString(); store.set('ku.lastSync', S.lastSync);
        persistServer(); invalidate();
        var b = $('#cf-back'); if (b) b.remove();
        renderAll(); go('home');
        toast('Terhubung ke "' + (data.meta && data.meta.sheetName || 'spreadsheet') + '"', 'ok');
      }, function (er) {
        S.cfg = prev.cfg; S.demo = prev.demo;
        err.textContent = er.code === 'AUTH' ? 'Kunci aplikasi salah. Salin ulang dari menu spreadsheet.' : er.message;
        err.hidden = false;
      }).then(function () { btn.disabled = false; btn.textContent = 'Hubungkan'; });
    });
    $('#cf-demo').addEventListener('click', function () {
      S.demo = true; store.set(LS.demo, true);
      S.queue = []; persistQueue();
      S.server = null; invalidate();
      renderAll(); go('home');
      refresh(true);
    });
  }

  /* ============================================================
     PWA: install & service worker
     ============================================================ */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function promptInstall() {
    if (!S.installEvt) return;
    S.installEvt.prompt();
    S.installEvt.userChoice.then(function (c) {
      if (c.outcome === 'accepted') toast('Aplikasi dipasang di layar utama', 'ok');
      S.installEvt = null; S.prefs.installDismiss = true; savePrefs(); renderAll();
    });
  }

  /* ============================================================
     MULAI
     ============================================================ */
  function init() {
    $$('.nav-btn').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.view); }); });
    $('#fab').addEventListener('click', function () { openForm({}); });
    $('#scrim').addEventListener('click', closeSheet);
    $('#btn-refresh').addEventListener('click', function () { flush().then(function () { refresh(false); }); });
    $('#demo-exit').addEventListener('click', function () { showConnect(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    document.addEventListener('click', function (e) { if (!e.target.closest('[data-chart]')) hideTip(); });
    window.addEventListener('scroll', hideTip, { passive: true });
    bindConnect();

    window.addEventListener('online', function () { S.online = true; updateSyncPill(); flush(); });
    window.addEventListener('offline', function () { S.online = false; updateSyncPill(); });
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if ((S.cfg || S.demo) && Date.now() - hiddenAt > 60000) { flush().then(function () { refresh(true); }); }
    });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); S.installEvt = e; renderAll(); });

    renderAll();
    if (S.cfg || S.demo) {
      refresh(true).then(function () { if (S.queue.length) flush(); });
      // pintasan dari ikon aplikasi (tekan lama ikon) atau ?aksi=tambah
      var q = new URLSearchParams(location.search).get('aksi');
      if (q === 'tambah' || q === 'pemasukan') {
        setTimeout(function () { openForm(q === 'pemasukan' ? { preset: { jenis: 'masuk' } } : {}); }, 120);
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
      }
    }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) {}
    }
    setInterval(function () { if (S.queue.length && navigator.onLine) flush(); }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

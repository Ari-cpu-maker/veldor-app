// netlify/functions/tiktok-check.js  (VERSI 3 - sampel file video, lebih cepat)
//
// Perubahan v3: 2 alamat video dicoba BERSAMAAN (yang tercepat menang), batas waktu
// total dijaga di bawah 10 dtk Netlify, dan analisis AI Gemini dipisah ke function
// tiktok-ai.js supaya data teknis tampil duluan tanpa menunggu AI.
//
// Alur baru:
// 1. Ambil halaman TikTok -> dapat info dasar (akun, views, likes) + alamat file video.
// 2. TikTok TIDAK memberi info kualitas yang bisa dipercaya, jadi file videonya
//    diambil langsung sebagai SAMPEL (bukan diunduh penuh, walau file sampai 100MB):
//      a. Minta 512 KB pertama (biasanya sudah memuat blok "moov" = data teknis video).
//      b. Kalau "moov" tidak ada di depan (ada di belakang file), lompat antar blok
//         MP4 pakai Range request kecil (16 byte per lompatan), lalu ambil blok
//         "moov" saja. Total yang dibaca biasanya < 1 MB, jadi cepat.
//      c. Kalau server mengabaikan Range, file dibaca streaming dan berhenti begitu
//         "moov" ketemu (dibatasi 100 MB & batas waktu).
// 3. Dari blok "moov" dibaca: resolusi, codec, profil, bit depth, HDR (transfer PQ/HLG,
//    Dolby Vision), FPS, durasi, dan bitrate video ASLI (jumlah ukuran semua frame).
//
// CATATAN: ini BUKAN API resmi TikTok. Kalau TikTok mengubah struktur halamannya atau
// memblokir akses file video, hasil teknis bisa gagal. Kalau gagal, alasannya
// dikirim di field video.techNote supaya kelihatan di layar.

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const HEAD_BYTES = 256 * 1024;          // sampel awal (cukup untuk moov video pendek)
const MOOV_MAX = 16 * 1024 * 1024;      // batas aman ukuran blok moov
const STREAM_CAP = 100 * 1024 * 1024;   // batas baca kalau server tidak dukung Range
const TOTAL_BUDGET_MS = 9000;           // batas total SELURUH proses (Netlify memutus di 10 dtk)

async function resolveShortLink(url) {
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3000) });
    return resp.url || url;
  } catch (e) {
    return url;
  }
}

function extractItemStruct(html) {
  let m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const scope = data.__DEFAULT_SCOPE__ || {};
      const detail = scope['webapp.video-detail'];
      const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
      if (item) return item;
    } catch (e) { /* lanjut cara lain */ }
  }
  m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const modules = data.ItemModule || {};
      const key = Object.keys(modules)[0];
      if (key) return modules[key];
    } catch (e) { /* habis */ }
  }
  return null;
}

// ---------------------------------------------------------------------------------
// Pembaca MP4 (dipakai pada blok "moov")
// ---------------------------------------------------------------------------------
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const cc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function boxes(buf, start, end) {
  const out = [];
  let pos = start;
  end = Math.min(end, buf.length);
  while (pos + 8 <= end) {
    let size = u32(buf, pos), hdr = 8;
    const type = cc(buf, pos + 4);
    if (size === 1) {
      if (pos + 16 > end) break;
      size = u32(buf, pos + 8) * 4294967296 + u32(buf, pos + 12);
      hdr = 16;
    } else if (size === 0) size = end - pos;
    if (size < hdr) break;
    if (pos + size > end) { out.push({ type, start: pos, size: end - pos, hdr }); break; }
    out.push({ type, start: pos, size, hdr });
    pos += size;
  }
  return out;
}
const kids = (buf, b) => boxes(buf, b.start + b.hdr, b.start + b.size);
const find = (list, type) => list.find(b => b.type === type) || null;

const TRANSFER_NAMES = { 1: 'BT.709', 4: 'gamma 2.2', 6: 'BT.601', 13: 'sRGB', 14: 'BT.2020', 15: 'BT.2020', 16: 'PQ (HDR10)', 18: 'HLG' };
const PRIMARIES_NAMES = { 1: 'BT.709', 5: 'BT.601', 6: 'BT.601', 9: 'BT.2020' };

function parseTrack(buf, trak) {
  const tk = kids(buf, trak);
  const mdia = find(tk, 'mdia');
  if (!mdia) return null;
  const mk = kids(buf, mdia);
  const hdlr = find(mk, 'hdlr');
  const handler = hdlr ? cc(buf, hdlr.start + hdlr.hdr + 8) : '';
  if (handler !== 'vide') return { handler };

  const tkhd = find(tk, 'tkhd');
  const mdhd = find(mk, 'mdhd');
  const minf = find(mk, 'minf');
  const stbl = minf && find(kids(buf, minf), 'stbl');
  if (!stbl) return { handler };
  const sk = kids(buf, stbl);

  // --- durasi & skala waktu
  let timescale = 0, mdDuration = 0;
  if (mdhd) {
    const p = mdhd.start + mdhd.hdr;
    if (buf[p] === 1) { timescale = u32(buf, p + 20); mdDuration = u32(buf, p + 24) * 4294967296 + u32(buf, p + 28); }
    else { timescale = u32(buf, p + 12); mdDuration = u32(buf, p + 16); }
  }

  // --- jumlah frame & total waktu dari stts
  let frames = 0, ticks = 0;
  const stts = find(sk, 'stts');
  if (stts) {
    const p = stts.start + stts.hdr;
    const n = u32(buf, p + 4);
    for (let i = 0, o = p + 8; i < n && o + 8 <= stts.start + stts.size; i++, o += 8) {
      const c = u32(buf, o), d = u32(buf, o + 4);
      frames += c; ticks += c * d;
    }
  }

  // --- total byte semua frame dari stsz (bitrate video asli)
  let videoBytes = 0, stszCount = 0;
  const stsz = find(sk, 'stsz');
  if (stsz) {
    const p = stsz.start + stsz.hdr;
    const fixed = u32(buf, p + 4);
    stszCount = u32(buf, p + 8);
    if (fixed) videoBytes = fixed * stszCount;
    else for (let i = 0, o = p + 12; i < stszCount && o + 4 <= stsz.start + stsz.size; i++, o += 4) videoBytes += u32(buf, o);
  }
  if (!frames) frames = stszCount;

  // --- ukuran tampilan dari tkhd (sudah memperhitungkan rotasi)
  let width = 0, height = 0;
  if (tkhd) {
    const e = tkhd.start + tkhd.size;
    width = u32(buf, e - 8) >>> 16;
    height = u32(buf, e - 4) >>> 16;
  }

  // --- sample entry (codec, HDR, bit depth)
  let codecTag = '', profile = '', bitDepth = null, transfer = null, primaries = null, fullRange = null, dolby = false;
  const stsd = find(sk, 'stsd');
  if (stsd) {
    const es = stsd.start + stsd.hdr + 8;           // awal entry pertama
    if (es + 8 <= buf.length) {
      const esSize = u32(buf, es);
      codecTag = cc(buf, es + 4);
      if (!width || !height) { width = u16(buf, es + 32); height = u16(buf, es + 34); }
      const cb = boxes(buf, es + 86, Math.min(es + esSize, buf.length));
      for (const c of cb) {
        const p = c.start + c.hdr;
        if (c.type === 'colr' && cc(buf, p) === 'nclx') {
          primaries = u16(buf, p + 4); transfer = u16(buf, p + 6); fullRange = (buf[p + 10] >> 7) & 1;
        } else if (c.type === 'hvcC') {
          const idc = buf[p + 1] & 0x1f;
          profile = idc === 1 ? 'Main' : idc === 2 ? 'Main 10' : 'profil ' + idc;
          bitDepth = (buf[p + 17] & 7) + 8;
        } else if (c.type === 'avcC') {
          const idc = buf[p + 1];
          profile = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' }[idc] || 'profil ' + idc;
          bitDepth = idc === 110 ? 10 : 8; // perkiraan dari profil
        } else if (c.type === 'av1C') {
          const b2 = buf[p + 2];
          bitDepth = (b2 & 0x20) ? 12 : (b2 & 0x40) ? 10 : 8;
        } else if (c.type === 'dvcC' || c.type === 'dvvC') {
          dolby = true;
        }
      }
    }
  }
  if (codecTag === 'dvh1' || codecTag === 'dvhe') dolby = true;

  const codecMap = { avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265 (HEVC)', hev1: 'H.265 (HEVC)', dvh1: 'H.265 (HEVC)', dvhe: 'H.265 (HEVC)', av01: 'AV1', vp09: 'VP9' };
  const pq = transfer === 16, hlg = transfer === 18;
  const hdr = dolby || pq || hlg;
  const hdrType = dolby ? 'Dolby Vision' : pq ? 'HDR10 (PQ)' : hlg ? 'HLG' : null;

  const durationSec = ticks && timescale ? ticks / timescale : (timescale ? mdDuration / timescale : 0);
  const fps = ticks && timescale && frames ? (frames * timescale) / ticks : null;
  const videoBitrateBps = durationSec && videoBytes ? Math.round((videoBytes * 8) / durationSec) : null;

  return {
    handler, width, height,
    codec: codecMap[codecTag] || codecTag || '-', codecTag, profile, bitDepth,
    hdr, hdrType,
    transfer: transfer != null ? (TRANSFER_NAMES[transfer] || String(transfer)) : null,
    primaries: primaries != null ? (PRIMARIES_NAMES[primaries] || String(primaries)) : null,
    fullRange,
    fps: fps ? Math.round(fps * 100) / 100 : null,
    frames, durationSec: durationSec ? Math.round(durationSec * 100) / 100 : 0,
    videoBytes, videoBitrateBps,
  };
}

// buf = bytes blok "moov" lengkap (dimulai dari header moov)
function readMp4Info(buf) {
  try {
    const top = boxes(buf, 0, buf.length);
    const moov = find(top, 'moov');
    if (!moov) return null;
    for (const t of kids(buf, moov).filter(b => b.type === 'trak')) {
      const info = parseTrack(buf, t);
      if (info && info.handler === 'vide') return info;
    }
  } catch (e) { /* data rusak */ }
  return null;
}

// ---------------------------------------------------------------------------------
// Pengambilan sampel file video
// ---------------------------------------------------------------------------------
function parseTotal(cr) {
  if (!cr) return null;
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function concat(chunks, len) {
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function rangeGet(url, start, end, ctx) {
  const resp = await fetch(url, { headers: { ...ctx.headers, Range: `bytes=${start}-${end}` }, signal: ctx.signal });
  if (resp.status === 206) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    ctx.bytes += buf.length;
    return { buf, total: parseTotal(resp.headers.get('content-range')) };
  }
  try { await resp.body.cancel(); } catch (e) {}
  const err = new Error(resp.status === 200 ? 'Server mengabaikan Range' : 'HTTP ' + resp.status);
  err.status = resp.status;
  throw err;
}

// Server mengabaikan Range: baca streaming, simpan hanya blok moov, buang sisanya.
async function streamScan(resp, ctx, total) {
  const reader = resp.body.getReader();
  let hdrBuf = new Uint8Array(0), skip = 0, moovParts = null, moovNeed = 0, moovLen = 0, received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      ctx.bytes += value.length;
      if (received > STREAM_CAP) throw new Error('File lebih dari 100 MB, pembacaan dihentikan');
      let off = 0;
      while (off < value.length) {
        if (moovNeed > 0) {
          const take = Math.min(moovNeed, value.length - off);
          moovParts.push(value.subarray(off, off + take)); moovLen += take; moovNeed -= take; off += take;
          if (moovNeed === 0) return concat(moovParts, moovLen);
        } else if (skip > 0) {
          const take = Math.min(skip, value.length - off);
          skip -= take; off += take;
        } else {
          const want = hdrBuf.length < 8 ? 8 : (u32(hdrBuf, 0) === 1 ? 16 : 8);
          const take = Math.min(want - hdrBuf.length, value.length - off);
          const merged = new Uint8Array(hdrBuf.length + take);
          merged.set(hdrBuf); merged.set(value.subarray(off, off + take), hdrBuf.length);
          hdrBuf = merged; off += take;
          const need = hdrBuf.length < 8 ? 8 : (u32(hdrBuf, 0) === 1 ? 16 : 8);
          if (hdrBuf.length < need) continue;
          let size = u32(hdrBuf, 0), hdr = 8;
          const type = cc(hdrBuf, 4);
          if (size === 1) { size = u32(hdrBuf, 8) * 4294967296 + u32(hdrBuf, 12); hdr = 16; }
          else if (size === 0) size = total || Infinity;
          if (type === 'moov') {
            if (size > MOOV_MAX) throw new Error('Blok moov terlalu besar');
            moovParts = [hdrBuf]; moovLen = hdrBuf.length; moovNeed = size - hdr;
          } else {
            skip = size - hdr;
          }
          hdrBuf = new Uint8Array(0);
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch (e) {}
  }
  throw new Error('Blok moov tidak ditemukan di file');
}

// Mengembalikan { info, totalSize, mode }
async function analyzeRemote(url, ctx) {
  const resp = await fetch(url, { headers: { ...ctx.headers, Range: `bytes=0-${HEAD_BYTES - 1}` }, signal: ctx.signal });

  // Server tidak dukung Range -> baca streaming
  if (resp.status === 200) {
    const total = parseInt(resp.headers.get('content-length') || '', 10) || null;
    const moovBuf = await streamScan(resp, ctx, total);
    return { info: readMp4Info(moovBuf), totalSize: total, mode: 'stream' };
  }
  if (resp.status !== 206) {
    try { await resp.body.cancel(); } catch (e) {}
    const err = new Error('Server video membalas HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }

  const head = new Uint8Array(await resp.arrayBuffer());
  ctx.bytes += head.length;
  const total = parseTotal(resp.headers.get('content-range'));

  // Lompat antar blok MP4 tingkat atas sampai ketemu moov
  let pos = 0, moovBuf = null;
  for (let hop = 0; hop < 12; hop++) {
    if (total && pos >= total) break;
    let h;
    if (pos + 16 <= head.length) h = head.subarray(pos, pos + 16);
    else h = (await rangeGet(url, pos, pos + 15, ctx)).buf;
    if (h.length < 8) break;
    let size = u32(h, 0), hdr = 8;
    const type = cc(h, 4);
    if (size === 1) { if (h.length < 16) break; size = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; }
    else if (size === 0) size = (total || 0) - pos;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > MOOV_MAX) throw new Error('Blok moov terlalu besar (' + size + ' byte)');
      moovBuf = pos + size <= head.length ? head.subarray(pos, pos + size) : (await rangeGet(url, pos, pos + size - 1, ctx)).buf;
      break;
    }
    pos += size;
  }
  if (!moovBuf) throw new Error('Blok moov tidak ditemukan di file');
  return { info: readMp4Info(moovBuf), totalSize: total, mode: 'range' };
}

function collectCandidates(video) {
  const list = [];
  const add = (u, label) => { if (u && !list.some(x => x.url === u)) list.push({ url: u, label }); };
  const infos = (video.bitrateInfo || []).slice().sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
  for (const b of infos) {
    const urls = (b.PlayAddr && b.PlayAddr.UrlList) || [];
    urls.slice(0, 2).forEach(u => add(u, 'kualitas tertinggi'));
  }
  add(video.playAddr, 'playAddr');
  add(video.downloadAddr, 'downloadAddr');
  return list.slice(0, 4);
}

async function tryCandidate(c, cookie, ctrl) {
  const t0 = Date.now();
  const ctx = {
    bytes: 0,
    signal: ctrl.signal,
    headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', ...(cookie ? { Cookie: cookie } : {}) },
  };
  const r = await analyzeRemote(c.url, ctx);
  if (!r.info) throw new Error('moov ditemukan tapi track video tidak terbaca');
  return { ...r, bytesRead: ctx.bytes, ms: Date.now() - t0, sourceLabel: c.label };
}

const errMsg = (e) => (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'waktu habis' : (e && e.message ? e.message : String(e));

// Coba alamat video 2 sekaligus (yang berhasil duluan dipakai, sisanya dibatalkan).
async function fetchVideoTechInfo(video, cookie, deadlineAt) {
  const cands = collectCandidates(video);
  if (!cands.length) return { error: 'TikTok tidak memberi alamat file video di halaman ini' };
  const errors = [];
  for (let i = 0; i < cands.length; i += 2) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 800) { errors.push('waktu habis'); break; }
    const group = cands.slice(i, i + 2);
    const ctrls = group.map(() => new AbortController());
    const timer = setTimeout(() => ctrls.forEach(c => c.abort()), remaining);
    try {
      const r = await Promise.any(group.map((c, k) => tryCandidate(c, cookie, ctrls[k])));
      ctrls.forEach(c => c.abort());   // hentikan yang kalah, hemat bandwidth
      return r;
    } catch (agg) {
      for (const e of (agg && agg.errors ? agg.errors : [agg])) errors.push(errMsg(e));
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: [...new Set(errors)].slice(0, 3).join(' | ') };
}

function buildCookie(resp) {
  try {
    const h = resp.headers;
    const arr = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (h.get('set-cookie') ? [h.get('set-cookie')] : []);
    return arr.map(s => s.split(';')[0]).filter(Boolean).join('; ');
  } catch (e) { return ''; }
}

exports.handler = async (event) => {
  const startedAt = Date.now();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Body bukan JSON valid.' }); }

  let url = (payload.url || '').trim();
  if (!url || !/tiktok\.com/i.test(url)) return json(400, { error: 'Link TikTok tidak valid.' });

  if (/vt\.tiktok\.com|vm\.tiktok\.com|\/t\//.test(url)) url = await resolveShortLink(url);

  let html, cookie = '';
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return json(502, { error: 'Gagal membuka halaman TikTok (kode ' + resp.status + '). Videonya mungkin sudah dihapus/private.' });
    cookie = buildCookie(resp);
    html = await resp.text();
  } catch (e) {
    return json(502, { error: 'Gagal menghubungi TikTok: ' + (e && e.message ? e.message : String(e)) });
  }

  const item = extractItemStruct(html);
  if (!item) return json(502, { error: 'Tidak bisa membaca data video ini. Kemungkinan video private/dihapus, atau TikTok mengubah struktur halamannya (perlu diperbaiki di kode).' });

  const stats = item.stats || item.statsV2 || {};
  const video = item.video || {};
  const author = item.author || {};

  const tech = await fetchVideoTechInfo(video, cookie, startedAt + TOTAL_BUDGET_MS);
  const info = tech && tech.info;

  const width = (info && info.width) || video.width || 0;
  const height = (info && info.height) || video.height || 0;
  const duration = (info && info.durationSec) || video.duration || 0;
  const sizeBytes = (tech && tech.totalSize) || null;
  const overallBitrateBps = sizeBytes && duration ? Math.round((sizeBytes * 8) / duration) : null;
  const bitrateBps = (info && info.videoBitrateBps) || overallBitrateBps || video.bitrate || null;

  return json(200, {
    username: author.uniqueId || author.nickname || '-',
    desc: item.desc || '',
    stats: {
      views: stats.playCount ?? null,
      likes: stats.diggCount ?? null,
      comments: stats.commentCount ?? null,
      shares: stats.shareCount ?? null,
      favorites: stats.collectCount ?? null,
    },
    video: {
      width, height, duration,
      codec: (info && info.codec) || video.format || '-',
      codecProfile: info ? info.profile || null : null,
      bitDepth: info ? info.bitDepth : null,
      hdr: info ? !!info.hdr : null,          // null = tidak sempat dicek
      hdrType: info ? info.hdrType : null,
      transfer: info ? info.transfer : null,
      fps: info ? info.fps : null,
      bitrateBps,                             // bitrate video asli (dari ukuran semua frame)
      overallBitrateBps,                      // bitrate keseluruhan file (video + audio)
      sizeBytes,
      techSource: info ? 'file' : 'metadata-tiktok-saja',
      techNote: info ? null : (tech && tech.error) || 'Analisis file gagal',
      sampleInfo: info ? { mode: tech.mode, bytesRead: tech.bytesRead, ms: tech.ms, source: tech.sourceLabel } : null,
    },
    createTime: item.createTime || null,
    elapsedMs: Date.now() - startedAt,
  });
};

// dipakai hanya untuk pengujian lokal
exports._internals = { readMp4Info, analyzeRemote, fetchVideoTechInfo };

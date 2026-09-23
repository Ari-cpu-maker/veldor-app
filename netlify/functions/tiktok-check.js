// netlify/functions/tiktok-check.js
//
// Fitur "TikTok Checker": terima link video TikTok, ambil info publik dari
// halamannya (views/likes/komentar/share, resolusi, durasi, dll), lalu kalau
// bisa, ambil sebagian byte awal file videonya untuk baca info teknis akurat
// (codec asli, HDR, resolusi pasti, perkiraan bitrate/ukuran file).
//
// CATATAN PENTING (baca sebelum ubah-ubah):
// - Ini BUKAN API resmi TikTok. Ini baca data publik yang TikTok taruh di
//   dalam HTML halaman videonya (cara yang sama dipakai tools sejenis
//   "Vague TikTok Checker"). TikTok bisa kapan saja mengubah struktur
//   halamannya, dan kalau itu terjadi, ekstraksi JSON di bawah akan gagal
//   sampai disesuaikan lagi.
// - Field seperti "shadow ban" atau "region" SENGAJA tidak disediakan di sini
//   karena itu cuma tebakan/heuristik yang tidak akurat, bukan data asli.
// - Kalau video-nya private/dihapus/umur akun dibatasi, TikTok tidak akan
//   menyertakan itemStruct di HTML-nya, dan function ini akan balas error.

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

async function resolveShortLink(url) {
  // vt.tiktok.com / vm.tiktok.com / link pendek lain -> ikuti redirect sampai dapat URL panjang
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } });
    return resp.url || url;
  } catch (e) {
    return url; // kalau gagal, coba saja pakai url asli
  }
}

function extractItemStruct(html) {
  // TikTok menaruh data halaman di salah satu dari 2 kemungkinan tag <script> ini
  let m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const scope = data.__DEFAULT_SCOPE__ || {};
      const detail = scope['webapp.video-detail'];
      const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
      if (item) return item;
    } catch (e) { /* lanjut coba cara lain */ }
  }
  m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const modules = data.ItemModule || {};
      const key = Object.keys(modules)[0];
      if (key) return modules[key];
    } catch (e) { /* tidak ada lagi cara lain */ }
  }
  return null;
}

// ---------- pembaca kotak MP4 minimal (dipakai untuk baca info teknis dari sebagian byte awal video) ----------
function readMp4Info(buf) {
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const cc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function readHeader(pos, end) {
    if (end - pos < 8) return null;
    let size = u32(buf, pos), hdr = 8;
    const type = cc(buf, pos + 4);
    if (size === 1) { if (end - pos < 16) return null; size = u32(buf, pos + 8) * 4294967296 + u32(buf, pos + 12); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) return null;
    return { type, size, hdr };
  }
  function findTop(type) {
    let pos = 0;
    while (pos < buf.length) {
      const h = readHeader(pos, buf.length);
      if (!h) return null;
      if (h.type === type) return { start: pos, size: h.size, hdr: h.hdr };
      pos += h.size;
    }
    return null;
  }
  function findChild(start, end, type) {
    let pos = start;
    while (pos < end) {
      const h = readHeader(pos, end);
      if (!h) return null;
      if (h.type === type) return { start: pos, size: h.size, hdr: h.hdr };
      pos += h.size;
    }
    return null;
  }
  function findDeep(start, end, path) {
    let cur = { start, size: end - start, hdr: 0 };
    for (const t of path) {
      const c = findChild(cur.start + cur.hdr, cur.start + cur.size, t);
      if (!c) return null;
      cur = c;
    }
    return cur;
  }
  const moov = findTop('moov');
  if (!moov) return null;
  const traks = [];
  { let pos = moov.start + moov.hdr, end = moov.start + moov.size;
    while (pos < end) { const h = readHeader(pos, end); if (!h) break; if (h.type === 'trak') traks.push({ start: pos, size: h.size, hdr: h.hdr }); pos += h.size; }
  }
  let vTrak = null;
  for (const t of traks) {
    const hdlr = findDeep(t.start, t.start + t.size, ['mdia', 'hdlr']);
    if (hdlr && cc(buf, hdlr.start + hdlr.hdr + 8) === 'vide') { vTrak = t; break; }
  }
  if (!vTrak) return null;
  const tkhd = findChild(vTrak.start + vTrak.hdr, vTrak.start + vTrak.size, 'tkhd');
  const stsd = findDeep(vTrak.start, vTrak.start + vTrak.size, ['mdia', 'minf', 'stbl', 'stsd']);
  let width = 0, height = 0, codec = '', hdr = false, trc = 0;
  if (tkhd) { const p = tkhd.start + tkhd.hdr; width = u32(buf, p + tkhd.size - 8) >>> 16; height = u32(buf, p + tkhd.size - 4) >>> 16; }
  if (stsd) {
    const entryStart = stsd.start + stsd.hdr + 8;
    codec = cc(buf, entryStart + 4);
    const searchEnd = Math.min(stsd.start + stsd.size, buf.length);
    for (let i = entryStart; i < searchEnd - 4; i++) {
      if (cc(buf, i) === 'colr' && cc(buf, i + 4) === 'nclx') { trc = (buf[i + 10] << 8) | buf[i + 11]; break; }
      if (cc(buf, i) === 'dvcC' || cc(buf, i) === 'dvvC') { hdr = true; }
    }
  }
  if (trc === 16 || trc === 18) hdr = true;
  const hevc = codec === 'hvc1' || codec === 'hev1';
  return { width, height, codec: hevc ? 'hevc' : (codec === 'avc1' || codec === 'avc3' ? 'h264' : codec), hdr };
}

async function fetchVideoTechInfo(playAddr) {
  if (!playAddr) return null;
  try {
    const resp = await fetch(playAddr, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-2000000', Referer: 'https://www.tiktok.com/' },
    });
    if (!resp.ok && resp.status !== 206) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    let totalSize = null;
    const cr = resp.headers.get('content-range'); // format: bytes 0-2000000/12345678
    if (cr) { const m = cr.match(/\/(\d+)$/); if (m) totalSize = parseInt(m[1], 10); }
    else { const cl = resp.headers.get('content-length'); if (cl && resp.status === 200) totalSize = parseInt(cl, 10); }
    const mp4 = readMp4Info(buf);
    return { ...mp4, totalSize };
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Body bukan JSON valid.' }); }

  let url = (payload.url || '').trim();
  if (!url || !/tiktok\.com/i.test(url)) return json(400, { error: 'Link TikTok tidak valid.' });

  if (/vt\.tiktok\.com|vm\.tiktok\.com|\/t\//.test(url)) url = await resolveShortLink(url);

  let html;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' } });
    if (!resp.ok) return json(502, { error: 'Gagal membuka halaman TikTok (kode ' + resp.status + '). Videonya mungkin sudah dihapus/private.' });
    html = await resp.text();
  } catch (e) {
    return json(502, { error: 'Gagal menghubungi TikTok: ' + (e && e.message ? e.message : String(e)) });
  }

  const item = extractItemStruct(html);
  if (!item) return json(502, { error: 'Tidak bisa membaca data video ini. Kemungkinan video private/dihapus, atau TikTok mengubah struktur halamannya (perlu diperbaiki di kode).' });

  const stats = item.stats || item.statsV2 || {};
  const video = item.video || {};
  const author = item.author || {};
  const playAddr = video.playAddr || (video.bitrateInfo && video.bitrateInfo[0] && video.bitrateInfo[0].PlayAddr && video.bitrateInfo[0].PlayAddr.UrlList && video.bitrateInfo[0].PlayAddr.UrlList[0]) || '';

  const tech = await fetchVideoTechInfo(playAddr);

  const width = (tech && tech.width) || video.width || 0;
  const height = (tech && tech.height) || video.height || 0;
  const duration = video.duration || 0;
  const sizeBytes = (tech && tech.totalSize) || null;
  const bitrateBps = sizeBytes && duration ? Math.round((sizeBytes * 8) / duration) : (video.bitrate || null);

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
      width, height,
      duration,
      codec: (tech && tech.codec) || video.format || '-',
      hdr: tech ? !!tech.hdr : null, // null = tidak sempat dicek (misal playAddr gagal diakses)
      bitrateBps,
      sizeBytes,
      techSource: tech ? 'file' : 'metadata-tiktok-saja',
    },
    createTime: item.createTime || null,
  });
};

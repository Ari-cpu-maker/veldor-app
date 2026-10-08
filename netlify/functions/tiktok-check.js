// Netlify function: ambil SEMUA data video TikTok dari JSON halaman publik + baca sampel file video (HDR/FPS/codec)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = { 'Content-Type': 'application/json' };
const out = (c, b) => ({ statusCode: c, headers: H, body: JSON.stringify(b) });

async function getItem(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  const html = await r.text();
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Halaman TikTok tidak berisi data (video private/dihapus atau TikTok memblokir server).');
  const scope = JSON.parse(m[1]).__DEFAULT_SCOPE__ || {};
  const item = scope['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!item) throw new Error('Video tidak ditemukan / tidak bisa diakses (status ' + (scope['webapp.video-detail']?.statusMsg || 'unknown') + ').');
  return { item, cookie };
}

// Baca file mp4 secara akurat: ambil bagian awal besar (6 MB) + cari box 'moov' persis (di awal/akhir file),
// lalu parse struktur track video: codec, profile, bit depth, HDR (colr), FPS (stts/mdhd), jumlah frame.
const HEAD = 6 * 1024 * 1024;
const txt = (b, s, e) => b.toString('utf8', s, e).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
function* boxes(b, s, e) {
  while (s + 8 <= e) {
    let size = b.readUInt32BE(s), hl = 8; const type = b.toString('latin1', s + 4, s + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(s + 8)); hl = 16; } else if (size === 0) size = e - s;
    if (size < hl) return;
    yield { type, s: s + hl, e: Math.min(s + size, e) };
    s += size;
  }
}
const find = (b, s, e, t) => { for (const x of boxes(b, s, e)) if (x.type === t) return x; return null; };

async function probe(mediaUrl, cookie, duration) {
  const hd = { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Cookie: cookie };
  let total = null, downloaded = 0;
  const rng = async (a, z) => {
    const r = await fetch(mediaUrl, { headers: { ...hd, Range: `bytes=${a}-${z}` } });
    const cr = r.headers.get('content-range'); if (cr) total = Number(cr.split('/')[1]);
    const buf = Buffer.from(await r.arrayBuffer()); downloaded += buf.length; return buf;
  };
  const head = await rng(0, HEAD - 1);
  // cari moov di level atas (loncati mdat dengan range kecil)
  let moov = null, pos = 0, cur = head, base = 0;
  for (let i = 0; i < 12 && !moov; i++) {
    if (pos - base + 16 > cur.length) { if (total && pos >= total) break; cur = await rng(pos, pos + 15); base = pos; }
    const o = pos - base; let size = cur.readUInt32BE(o); const type = cur.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(cur.readBigUInt64BE(o + 8)); if (size === 0) size = (total || 0) - pos;
    if (size < 8) break;
    if (type === 'moov') {
      const buf = (pos - base + size <= cur.length) ? cur.subarray(o, o + size) : await rng(pos, pos + size - 1);
      moov = buf;
    }
    pos += size;
  }
  const res = { hdr: null, hdrType: null, bitDepth: null, profile: null, fps: null, frames: null, bytesRead: downloaded, totalBytes: total, codecTag: null };
  if (!moov) return res;
  let done = false;
  for (const trak of boxes(moov, 8, moov.length)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(moov, trak.s, trak.e, 'mdia'); if (!mdia) continue;
    const hdlr = find(moov, mdia.s, mdia.e, 'hdlr');
    const ht = hdlr && moov.toString('latin1', hdlr.s + 8, hdlr.s + 12);
    if (hdlr && (ht === 'vide' || ht === 'soun')) { const nm = txt(moov, hdlr.s + 24, hdlr.e); if (ht === 'vide' && !res.handlerVideo) res.handlerVideo = nm; if (ht === 'soun') res.handlerAudio = nm; }
    if (ht !== 'vide' || done) continue;
    done = true;
    const mdhd = find(moov, mdia.s, mdia.e, 'mdhd');
    const v1 = moov[mdhd.s] === 1;
    const ts = moov.readUInt32BE(mdhd.s + (v1 ? 20 : 12));
    const dur = v1 ? Number(moov.readBigUInt64BE(mdhd.s + 24)) : moov.readUInt32BE(mdhd.s + 16);
    const stbl = find(moov, find(moov, mdia.s, mdia.e, 'minf').s, mdia.e, 'stbl');
    const stsd = find(moov, stbl.s, stbl.e, 'stsd');
    const ent = find(moov, stsd.s + 8, stsd.e, moov.toString('latin1', stsd.s + 12, stsd.s + 16)); // sample entry
    res.codecTag = moov.toString('latin1', stsd.s + 12, stsd.s + 16);
    if (ent) for (const c of boxes(moov, ent.s + 78, ent.e)) {
      if (c.type === 'colr' && moov.toString('latin1', c.s, c.s + 4) === 'nclx') {
        const tr = moov.readUInt16BE(c.s + 6); res.hdr = tr === 16 || tr === 18; res.hdrType = tr === 16 ? 'HDR10/PQ' : tr === 18 ? 'HLG' : null;
        if (!res.hdr) res.hdrType = null;
      } else if (c.type === 'hvcC') {
        const pi = moov[c.s + 1] & 31; res.profile = { 1: 'Main', 2: 'Main 10', 3: 'Main Still' }[pi] || 'Profile ' + pi; res.bitDepth = (moov[c.s + 17] & 7) + 8;
      } else if (c.type === 'avcC') {
        res.profile = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10' }[moov[c.s + 1]] || String(moov[c.s + 1]); res.bitDepth = moov[c.s + 1] === 110 ? 10 : 8;
      } else if (c.type === 'av1C') { res.profile = 'AV1 P' + (moov[c.s + 1] >> 5); res.bitDepth = (moov[c.s + 2] & 0x40) ? ((moov[c.s + 2] & 0x20) ? 12 : 10) : 8; }
    }
    if (res.hdr === null) res.hdr = false; // colr nclx tidak menandakan PQ/HLG = SDR
    const stsz = find(moov, stbl.s, stbl.e, 'stsz');
    if (stsz) res.frames = moov.readUInt32BE(stsz.s + 8);
    if (res.frames && dur && ts) res.fps = Math.round(res.frames / (dur / ts) * 100) / 100;
  }
  // tag metadata (udta/meta/ilst): encoder (©too), software, komentar, dll.
  res.tags = {};
  const readIlst = (b, s, e) => { for (const it of boxes(b, s, e)) { const d = find(b, it.s, it.e, 'data'); if (d) { const v = txt(b, d.s + 8, d.e); if (v) res.tags[it.type.replace(/\xa9/g, '©')] = v; } } };
  for (const u of boxes(moov, 8, moov.length)) if (u.type === 'udta') {
    for (const c of boxes(moov, u.s, u.e)) {
      if (c.type === 'meta') { const il = find(moov, c.s + 4, c.e, 'ilst'); if (il) readIlst(moov, il.s, il.e); }
      else if (c.type.charCodeAt(0) === 0xa9 && c.e - c.s > 4) { const v = txt(moov, c.s + 4, c.e); if (v) res.tags[c.type.replace(/\xa9/g, '©')] = v; }
    }
  }
  // encoder yang tertanam di stream video (SEI x264/x265/Lavc)
  const m = head.toString('latin1').match(/(x264 - core[ -~]{0,160}|x265 \(build[ -~]{0,120}|Lavc[ -~]{3,40})/);
  if (m) res.encoderSei = m[1].replace(/\s+/g, ' ').trim();
  return res;
}

exports.handler = async (ev) => {
  try {
    const { url } = JSON.parse(ev.body || '{}');
    if (!/^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i.test(url || '')) return out(400, { error: 'Link TikTok tidak valid.' });
    const { item: it, cookie } = await getItem(url);
    const v = it.video || {}, a = it.author || {}, s = it.statsV2 || {}, s1 = it.stats || {}, mu = it.music || {};
    const n = (x, y) => Number(x ?? y ?? 0);
    const best = (v.bitrateInfo || []).slice().sort((p, q) => (q.PlayAddr?.Width * q.PlayAddr?.Height || 0) - (p.PlayAddr?.Width * p.PlayAddr?.Height || 0) || q.Bitrate - p.Bitrate)[0];
    const pa = best?.PlayAddr || {};
    const mediaUrl = (pa.UrlList || []).find(Boolean) || v.playAddr || v.downloadAddr;
    const width = pa.Width || v.width, height = pa.Height || v.height, duration = v.duration;
    let tech = null, techNote = null;
    try { tech = mediaUrl ? await probe(mediaUrl, cookie, duration) : null; } catch (e) { techNote = e.message; }
    // ukuran file: dari TikTok, kalau kosong dari header file asli (Content-Range)
    let sizeBytes = Number(pa.DataSize) || tech?.totalBytes || null;
    if (!sizeBytes && mediaUrl) {
      try {
        const r = await fetch(mediaUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Cookie: cookie, Range: 'bytes=0-0' } });
        const cr = r.headers.get('content-range');
        sizeBytes = cr ? Number(cr.split('/')[1]) : (Number(r.headers.get('content-length')) > 1 ? Number(r.headers.get('content-length')) : null);
      } catch (e) { /* abaikan */ }
    }
    const codecRaw = best?.CodecType || v.codecType || '';
    const privateItem = !!it.privateItem, indexEnabled = it.indexEnabled !== false;
    return out(200, {
      id: it.id, url, username: a.uniqueId, nickname: a.nickname, desc: it.desc, cover: v.cover || v.originCover,
      stats: { views: n(s.playCount, s1.playCount), likes: n(s.diggCount, s1.diggCount), comments: n(s.commentCount, s1.commentCount), shares: n(s.shareCount, s1.shareCount), favorites: n(s.collectCount, s1.collectCount) },
      video: {
        width, height, duration, fps: tech?.fps ?? null, sizeBytes,
        codec: /265|hevc|hvc/i.test(codecRaw) ? 'hevc' : /264|avc/i.test(codecRaw) ? 'h264' : codecRaw || '-',
        bitrateBps: (sizeBytes && duration) ? Math.round(sizeBytes * 8 / duration) : (best?.Bitrate || v.bitrate || null), totalFrames: tech?.frames ?? null, codecTag: tech?.codecTag ?? null, handlerVideo: tech?.handlerVideo || null, handlerAudio: tech?.handlerAudio || null, fileTags: tech?.tags || {}, encoderSei: tech?.encoderSei || null, format: pa.Format || v.format || null, vqScore: v.VQScore || null,
        quality: best?.GearName || v.videoQuality || null, hdr: tech ? tech.hdr : null, hdrType: tech?.hdrType, bitDepth: tech?.bitDepth, codecProfile: tech?.profile,
        techSource: tech ? 'file' : 'tiktok', techNote, sampleBytes: tech?.bytesRead, fileBytes: tech?.totalBytes, mediaUrl,
        allQualities: (v.bitrateInfo || []).map(b => ({ w: b.PlayAddr?.Width, h: b.PlayAddr?.Height, bitrate: b.Bitrate, codec: b.CodecType, size: b.PlayAddr?.DataSize }))
      },
      author: { verified: !!a.verified, bio: a.signature || '', avatar: a.avatarThumb },
      visibility: {
        region: it.locationCreated || null, indexEnabled, review: privateItem ? 'Private' : 'Published',
        shadowBan: privateItem || !indexEnabled ? 'Kemungkinan' : 'No', language: it.textLanguage || null,
        translatable: !!it.textTranslatable, aigc: !!(it.aigcLabelType || it.IsAigc || it.AIGCDescription), isAd: !!it.isAd
      },
      createdAt: it.createTime ? Number(it.createTime) * 1000 : null,
      categories: (it.diversificationLabels || []).filter(Boolean),
      music: { title: mu.title, author: mu.authorName, duration: mu.duration }
    });
  } catch (e) { return out(502, { error: e.message }); }
};

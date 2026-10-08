// Netlify Edge Function: ambil video TikTok kualitas tertinggi lalu STREAM ke pengunduh.
// Link CDN TikTok tidak bisa dibuka langsung di browser (butuh cookie & Referer), jadi harus lewat server.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export default async (req) => {
  const page = new URL(req.url).searchParams.get('v') || '';
  if (!/^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i.test(page)) return new Response('Link TikTok tidak valid.', { status: 400 });
  try {
    const r = await fetch(page, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    const item = m && JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!item) return new Response('Video tidak ditemukan / tidak bisa diakses.', { status: 404 });
    const v = item.video || {};
    const best = (v.bitrateInfo || []).slice().sort((p, q) => (q.PlayAddr?.Width * q.PlayAddr?.Height || 0) - (p.PlayAddr?.Width * p.PlayAddr?.Height || 0) || q.Bitrate - p.Bitrate)[0];
    const media = (best?.PlayAddr?.UrlList || []).find(Boolean) || v.playAddr || v.downloadAddr;
    if (!media) return new Response('Link video tidak tersedia.', { status: 404 });
    const up = await fetch(media, { headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Cookie: cookie } });
    if (!up.ok || !up.body) return new Response('TikTok menolak permintaan unduh (' + up.status + ').', { status: 502 });
    const h = new Headers({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="REPACK_${(item.author?.uniqueId || 'tiktok').replace(/[^\w.-]/g, '')}_${item.id}.mp4"`,
      'Cache-Control': 'no-store'
    });
    const len = up.headers.get('content-length'); if (len) h.set('Content-Length', len);
    return new Response(up.body, { headers: h });
  } catch (e) { return new Response('Gagal: ' + e.message, { status: 502 }); }
};

export const config = { path: '/api/tiktok-download' };

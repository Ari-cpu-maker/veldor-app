// netlify/functions/tiktok-ai.js  (LANGKAH 2 - penilaian AI Gemini)
//
// Dipanggil halaman SETELAH data teknis tampil (dari tiktok-check.js), jadi pengguna
// tidak menunggu AI. Yang dikirim ke Gemini hanya ANGKA hasil analisis (resolusi, fps,
// bitrate, HDR, dll) - bukan file video - jadi cepat (biasanya 1-3 dtk) walau video 100 MB.
//
// Environment variable di Netlify:
//   GEMINI_API_KEY  (wajib - samakan dengan nama yang dipakai function color-grade)
//   GEMINI_MODEL    (opsional - samakan dengan model di function color-grade)

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const AI_TIMEOUT_MS = 8000;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// Hanya ambil field angka/teks pendek yang dibutuhkan (jangan percaya kiriman mentah dari browser).
function cleanInput(v) {
  const str = (x) => (typeof x === 'string' ? x.slice(0, 60) : null);
  return {
    width: num(v.width), height: num(v.height), fps: num(v.fps),
    durationSec: num(v.duration), sizeMB: num(v.sizeBytes) ? +(v.sizeBytes / 1e6).toFixed(2) : null,
    videoBitrateMbps: num(v.bitrateBps) ? +(v.bitrateBps / 1e6).toFixed(2) : null,
    codec: str(v.codec), codecProfile: str(v.codecProfile), bitDepth: num(v.bitDepth),
    hdr: typeof v.hdr === 'boolean' ? v.hdr : null, hdrType: str(v.hdrType), transfer: str(v.transfer),
  };
}

function buildPrompt(d) {
  return [
    'Kamu adalah ahli kualitas video untuk kreator TikTok. Berikut data teknis video TikTok yang SUDAH terbaca dari file videonya (versi yang sudah dikompres ulang oleh TikTok, bukan file asli upload).',
    'Data (JSON): ' + JSON.stringify(d),
    'Nilai kualitas videonya untuk ditonton di HP. Aturan: hanya berdasarkan data di atas; jangan mengarang angka; kalau suatu field null berarti tidak diketahui, sebut saja tidak diketahui. Acuan kasar: 1080x1920 dianggap HD standar TikTok; bitrate video di bawah ~2 Mbps untuk 1080p cenderung terlihat blok/buram; 60 fps lebih halus daripada 30 fps; HDR/10-bit hanya bermanfaat kalau perangkat penonton mendukung.',
    'Jawab HANYA JSON valid berbahasa Indonesia dengan bentuk persis: {"verdict":"bagus"|"cukup"|"kurang","score":angka 0-100,"summary":"1-2 kalimat","issues":["maks 3 poin"],"tips":["maks 3 saran singkat dan praktis"]}',
  ].join('\n');
}

async function callGemini(prompt, apiKey, withThinkingOff) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 600, responseMimeType: 'application/json' },
  };
  if (withThinkingOff) body.generationConfig.thinkingConfig = { thinkingBudget: 0 }; // lebih cepat
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
}

function parseAnswer(resp) {
  const parts = resp && resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts;
  const text = (parts || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
  const o = JSON.parse(text);
  const list = (a) => (Array.isArray(a) ? a.slice(0, 3).map(x => String(x).slice(0, 200)) : []);
  const verdict = ['bagus', 'cukup', 'kurang'].includes(o.verdict) ? o.verdict : 'cukup';
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
  return { verdict, score, summary: String(o.summary || '').slice(0, 400), issues: list(o.issues), tips: list(o.tips) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { error: 'GEMINI_API_KEY belum diisi di pengaturan Netlify.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Body bukan JSON valid.' }); }
  const v = payload && payload.video;
  if (!v || typeof v !== 'object' || !num(v.width) || !num(v.height)) return json(400, { error: 'Data video tidak lengkap.' });

  const prompt = buildPrompt(cleanInput(v));
  const t0 = Date.now();
  try {
    let resp = await callGemini(prompt, apiKey, true);
    if (resp.status === 400) resp = await callGemini(prompt, apiKey, false); // model tanpa opsi thinking
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return json(502, { error: 'Gemini membalas HTTP ' + resp.status + (t ? ': ' + t.slice(0, 160) : '') });
    }
    const ai = parseAnswer(await resp.json());
    return json(200, { ai, model: MODEL, ms: Date.now() - t0 });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return json(502, { error: timeout ? 'Gemini terlalu lama menjawab (lebih dari 8 detik).' : 'Gagal memproses jawaban Gemini: ' + (e && e.message ? e.message : e) });
  }
};

exports._internals = { cleanInput, buildPrompt, parseAnswer };

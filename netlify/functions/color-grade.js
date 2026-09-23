// netlify/functions/color-grade.js
//
// Fitur "Color Grading": menerima beberapa frame (JPEG base64) yang diambil
// merata sepanjang satu video di sisi browser, lalu minta Gemini menganalisa
// pencahayaan & warnanya dan memberi saran pengaturan color grading ala CapCut
// (Bahasa Indonesia, pakai nama slider CapCut yang sebenarnya).
//
// GEMINI_API_KEY diset lewat Netlify → Site settings → Environment variables,
// TIDAK PERNAH dikirim/terlihat di kode browser.
//
// Kenapa kirim frame gambar, bukan file video utuh: Netlify Functions punya
// batas ukuran request (~6MB). Beberapa frame JPEG kecil jauh lebih dari cukup
// untuk Gemini menilai pencahayaan/warna, dan menghindari upload video besar
// (bisa ratusan MB) lewat function ini.

const MODEL = 'gemini-3.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 900000; // ~675KB per frame (base64), total request tetap aman di bawah limit Netlify

const SYSTEM_PROMPT = `Kamu adalah kolaborator ahli color grading video pendek (TikTok/reels) yang menganalisa
beberapa screenshot frame dari satu video, lalu memberi saran pengaturan color grading di aplikasi CapCut,
dalam Bahasa Indonesia, untuk pengguna yang mengedit lewat HP.

ATURAN PENTING:
- Gunakan PERSIS nama tombol/slider yang ada di CapCut tab "Sesuaikan" (bagian Pintar & Sesuaikan), supaya pengguna tinggal cari nama itu di aplikasinya:
  Kecerahan, Kontras, Saturasi, Kecemerlangan, Pertajam, Kejernihan, HSL, Grafik (kurva channel All/Merah/Hijau/Biru),
  Sorotan, Bayangan, Putih, Hitam, Suhu, Rona, Pudar, Vinyet, Butiran.
- Untuk tiap slider yang perlu diubah: sebutkan namanya, arah & besar perubahan perkiraan (misalnya "+15" atau "-10", dari skala umum -50 s/d +50), dan alasan singkat berdasarkan apa yang terlihat di frame (contoh: pencahayaan flat, warna pudar, shadow kebiruan, langit overexposed).
- Lewati slider yang memang sudah bagus/tidak perlu diubah — jangan sebutkan semua slider kalau tidak relevan.
- Kalau ada masalah warna spesifik yang cocok ditangani lewat HSL (misalnya hijau daun kurang hidup, kulit jadi oranye, langit kurang biru), sebutkan channel warnanya (Merah/Oranye/Kuning/Hijau/Cyan/Biru/Ungu/Magenta) dan naik/turunkan Saturation atau Luminance channel itu.
- Tutup dengan 1-2 kalimat ringkasan "look" akhir yang akan didapat (misalnya: hasil lebih cerah, warm, kontras dalam, hijau lebih hidup) supaya pengguna tahu ekspektasinya sebelum mencoba.
- Jangan bahas hal di luar pencahayaan/warna/color grading (jangan bahas komposisi, cerita, audio, dll).
- Jawaban singkat, langsung ke poin, format list per slider, nada santai seperti kreator ke kreator — bukan laporan teknis kaku.`;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'GEMINI_API_KEY belum diset di environment variable Netlify.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Body bukan JSON valid.' });
  }

  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) {
    return json(400, { error: 'Tidak ada frame gambar yang dikirim.' });
  }
  if (images.length > MAX_IMAGES) {
    return json(400, { error: `Maksimal ${MAX_IMAGES} frame per analisa.` });
  }
  for (const img of images) {
    if (!img || typeof img.data !== 'string' || !img.data.length) {
      return json(400, { error: 'Ada frame yang datanya kosong/tidak valid.' });
    }
    if (img.data.length > MAX_IMAGE_CHARS) {
      return json(400, { error: 'Ada frame yang ukurannya terlalu besar, kecilkan resolusi/kualitas dulu sebelum kirim.' });
    }
  }

  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const metaLine = [
    meta.codec,
    meta.w && meta.h ? `${meta.w}x${meta.h}` : null,
    meta.fps ? `${Math.round(meta.fps)}fps` : null,
    meta.duration ? `${(typeof meta.duration === 'number' ? meta.duration.toFixed(1) : meta.duration)}dtk` : null,
  ].filter(Boolean).join(' · ');

  const parts = [
    {
      text:
        `Ini ${images.length} frame yang diambil merata sepanjang satu video` +
        (metaLine ? ` (${metaLine})` : '') +
        '. Analisa pencahayaan & warnanya, lalu beri saran color grading CapCut sesuai instruksi sistem.',
    },
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data },
    })),
  ];

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
  };

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json(502, { error: 'Gagal menghubungi Gemini API: ' + (e && e.message ? e.message : String(e)) });
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || `Gemini API error (${resp.status})`;
    return json(502, { error: msg });
  }

  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
    ? data.candidates[0].content.parts.map((p) => p.text || '').join('\n').trim()
    : '';

  if (!text) {
    return json(502, { error: 'Gemini tidak mengembalikan teks saran (kemungkinan diblokir filter keamanan internal Gemini).' });
  }

  return json(200, { suggestion: text });
};

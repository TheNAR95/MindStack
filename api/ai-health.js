/**
 * GET /api/ai-health
 *
 * Diagnóstico de la configuración de MindAI. No expone la API key.
 * Sirve para saber si la clave existe, si el modelo está disponible
 * y qué responde Google al generar contenido.
 *
 * Opcional: si defines AI_HEALTH_TOKEN en Vercel, hay que llamarlo con ?token=...
 */

const FALLBACK_MODEL = 'gemini-flash-latest';
const MODEL = process.env.GEMINI_MODEL || FALLBACK_MODEL;
const TOKEN = process.env.AI_HEALTH_TOKEN || '';

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

function sanitize(text) {
  let out = String(text || '').slice(0, 400);
  const key = process.env.GEMINI_API_KEY;
  if (key && key.length > 8) out = out.split(key).join('[oculta]');
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  if (TOKEN && String((req.query && req.query.token) || '') !== TOKEN) {
    return res.status(403).json({ error: 'Token requerido.' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  if (limited(ip)) {
    return res.status(429).json({ error: 'Demasiadas consultas.' });
  }

  const out = {
    ok: false,
    keyPresent: !!process.env.GEMINI_API_KEY,
    model: MODEL,
    modelFound: null,
    listStatus: null,
    generateStatus: null,
    retriedWith: null,
    retryStatus: null,
    modelUsed: null,
    generateOk: false,
    error: null,
    reply: null
  };

  if (!process.env.GEMINI_API_KEY) {
    out.error = 'Falta GEMINI_API_KEY en Vercel.';
    return res.status(200).json(out);
  }

  try {
    const listResp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=' +
        encodeURIComponent(process.env.GEMINI_API_KEY)
    );
    out.listStatus = listResp.status;
    const listData = await listResp.json().catch(() => null);

    if (listResp.ok && listData && Array.isArray(listData.models)) {
      const names = listData.models.map((m) => String(m.name || '').replace(/^models\//, ''));
      out.modelFound = names.indexOf(MODEL) !== -1;
      out.availableFlash = names.filter((n) => /gemini.*flash/i.test(n)).slice(0, 12);
    } else {
      out.error = sanitize((listData && listData.error && listData.error.message) || 'No se pudo listar modelos.');
    }
  } catch (err) {
    out.error = 'Error de conexión al listar modelos: ' + sanitize(err.message);
    return res.status(200).json(out);
  }

  async function generate(modelName) {
    const genResp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(modelName) + ':generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Responde solo: ok' }] }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 }
        })
      }
    );

    const genData = await genResp.json().catch(() => null);
    return { resp: genResp, data: genData };
  }

  try {
    let attempt = await generate(MODEL);
    out.generateStatus = attempt.resp.status;

    // Si el modelo configurado fue retirado, probar el alias estable.
    if (!attempt.resp.ok && MODEL !== FALLBACK_MODEL) {
      const detail = (attempt.data && attempt.data.error && attempt.data.error.message) || '';
      if (attempt.resp.status === 404 || /no longer available|not found|not supported/i.test(detail)) {
        const fallback = await generate(FALLBACK_MODEL);
        out.retriedWith = FALLBACK_MODEL;
        out.retryStatus = fallback.resp.status;
        attempt = fallback;
        out.generateStatus = fallback.resp.status;
      }
    }

    if (attempt.resp.ok) {
      const parts = (attempt.data.candidates && attempt.data.candidates[0] && attempt.data.candidates[0].content && attempt.data.candidates[0].content.parts) || [];
      out.generateOk = true;
      out.modelUsed = out.retriedWith || MODEL;
      out.reply = parts.map((p) => p.text || '').join('').slice(0, 80);
      out.ok = true;
    } else {
      out.error = sanitize((attempt.data && attempt.data.error && attempt.data.error.message) || 'Error desconocido de Gemini.');
    }
  } catch (err) {
    out.error = 'Error de conexión al generar: ' + sanitize(err.message);
  }

  return res.status(200).json(out);
};

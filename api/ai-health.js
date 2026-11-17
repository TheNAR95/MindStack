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
const PRIMARY_MODEL = 'gemini-3-flash-preview';

// Modelos retirados: Google aún los lista pero devuelven 404 al generar.
const RETIRED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-preview',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro'
]);

// Valor tal cual viene de Vercel: sirve para detectar que quedó desactualizado.
const CONFIGURED_MODEL = String(process.env.GEMINI_MODEL || '').trim();
const MODEL = (CONFIGURED_MODEL && !RETIRED_MODELS.has(CONFIGURED_MODEL)) ? CONFIGURED_MODEL : PRIMARY_MODEL;
const TOKEN = process.env.AI_HEALTH_TOKEN || '';

// Una sola generación real cada 60 s: evita que el diagnóstico consuma la cuota
// de Gemini cuando alguien llama al endpoint en bucle.
const CACHE_MS = 60 * 1000;
let cached = null;

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 3;
}

function sameToken(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
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

  const providedToken = String((req.query && req.query.token) || '');
  if (TOKEN && !sameToken(providedToken, TOKEN)) {
    return res.status(403).json({ error: 'Token requerido.' });
  }
  // Sin AI_HEALTH_TOKEN el endpoint sigue siendo público, pero devuelve
  // solo un resumen; el detalle completo queda para quien tenga el token.
  const detailed = !!TOKEN;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  if (limited(ip)) {
    return res.status(429).json({ error: 'Demasiadas consultas.' });
  }

  function shape(out) {
    if (detailed) return out;
    return {
      ok: out.ok,
      keyPresent: out.keyPresent,
      generateOk: out.generateOk,
      modelUsed: out.modelUsed,
      error: out.error
    };
  }

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return res.status(200).json(shape(cached.out));
  }

  function finish(payload) {
    cached = { at: Date.now(), out: payload };
    return res.status(200).json(shape(payload));
  }

  const out = {
    ok: false,
    keyPresent: !!process.env.GEMINI_API_KEY,
    model: MODEL,
    configuredModel: CONFIGURED_MODEL || null,
    modelNote: CONFIGURED_MODEL && CONFIGURED_MODEL !== MODEL
      ? 'GEMINI_MODEL en Vercel está desactualizado (' + CONFIGURED_MODEL + '); se usa ' + MODEL + '.'
      : null,
    modelFound: null,
    listStatus: null,
    generateStatus: null,
    triedModels: [],
    modelUsed: null,
    generateOk: false,
    error: null,
    reply: null
  };

  if (!process.env.GEMINI_API_KEY) {
    out.error = 'Falta GEMINI_API_KEY en Vercel.';
    return finish(out);
  }

  try {
    const listController = new AbortController();
    const listTimer = setTimeout(() => listController.abort(), 5000);
    let listResp;
    try {
      listResp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=' +
          encodeURIComponent(process.env.GEMINI_API_KEY),
        { signal: listController.signal }
      );
    } finally {
      clearTimeout(listTimer);
    }
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
    return finish(out);
  }

  async function generate(modelName, withThinking) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const genResp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(modelName) + ':generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Responde solo: ok' }] }],
            generationConfig: Object.assign(
              { maxOutputTokens: 20, temperature: 0 },
              withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}
            )
          }),
          signal: controller.signal
        }
      );

      const genData = await genResp.json().catch(() => null);

      // Algunos modelos no aceptan thinkingConfig: reintento sin ese campo.
      if (genResp.status === 400 && withThinking) {
        const msg = (genData && genData.error && genData.error.message) || '';
        if (/thinking/i.test(msg)) return generate(modelName, false);
      }

      return { resp: genResp, data: genData };
    } catch (err) {
      return { resp: { ok: false, status: 0 }, data: { error: { message: 'Sin respuesta en 3.5 s: ' + err.message } } };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const candidates = [MODEL, 'gemini-3-flash-preview', FALLBACK_MODEL, 'gemini-flash-lite-latest'];
    const tried = [];
    let chosen = null;
    const startedAt = Date.now();

    for (const name of candidates) {
      if (tried.some((t) => t.model === name)) continue;
      if (Date.now() - startedAt > 7500) break;

      const attempt = await generate(name, /flash/i.test(name));
      const detail = (attempt.data && attempt.data.error && attempt.data.error.message) || '';
      tried.push({ model: name, status: attempt.resp.status, error: attempt.resp.ok ? null : sanitize(detail) });

      if (attempt.resp.ok) {
        chosen = attempt;
        out.modelUsed = name;
        break;
      }
      // Un 404 significa modelo retirado: seguir probando. Un 0/5xx puede
      // ser temporal, pero otro modelo puede estar disponible igual.
      if ([0, 404, 429, 500, 502, 503].indexOf(attempt.resp.status) === -1) break;
    }

    out.generateStatus = tried.length ? tried[0].status : null;
    out.triedModels = tried;

    if (chosen) {
      const parts = (chosen.data.candidates && chosen.data.candidates[0] && chosen.data.candidates[0].content && chosen.data.candidates[0].content.parts) || [];
      out.generateOk = true;
      out.reply = parts.map((p) => p.text || '').join('').slice(0, 80);
      out.ok = true;
      out.error = null;
    } else {
      out.error = tried.length ? tried[tried.length - 1].error : 'No se pudo generar contenido.';
    }
  } catch (err) {
    out.error = 'Error de conexión al generar: ' + sanitize(err.message);
  }

  return finish(out);
};

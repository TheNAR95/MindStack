/**
 * POST /api/contact
 *
 * Recibe el formulario "Contáctate con MindStack" de la página Equipo y
 * envía el mensaje por correo al equipo.
 *
 * Si el usuario tiene sesión iniciada y su cuenta es VIP en Firebase
 * (`users/<uid>/isVip === true`), el correo se marca como "Usuario VIP"
 * para atenderlo con prioridad.
 *
 * Variables de entorno en Vercel:
 *   RESEND_API_KEY        -> obligatoria (https://resend.com)
 *   CONTACT_NOTIFY_EMAIL  -> correo que recibe el mensaje (por defecto mindstackn7@gmail.com)
 *   CONTACT_FROM_EMAIL    -> remitente verificado en Resend
 *   FIREBASE_DB_URL       -> opcional
 *   ALLOWED_ORIGIN        -> dominio de la web (recomendado)
 *
 * También acepta PAYMENT_NOTIFY_EMAIL y PAYMENTS_FROM_EMAIL como respaldo.
 */

const DB_URL = (process.env.FIREBASE_DB_URL || 'https://mindstack-6749c-default-rtdb.firebaseio.com').replace(/\/$/, '');
const CONTACT_TO = process.env.CONTACT_NOTIFY_EMAIL || process.env.PAYMENT_NOTIFY_EMAIL || 'mindstackn7@gmail.com';
const FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || process.env.PAYMENTS_FROM_EMAIL || 'MindStack Soporte <onboarding@resend.dev>';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const IP_LIMIT_MAX = 5;                       // mensajes por IP
const IP_LIMIT_WINDOW_MS = 15 * 60 * 1000;    // cada 15 minutos
const ACCOUNT_DAILY_LIMIT = 5;                // mensajes por cuenta al día
const ACCOUNT_MIN_GAP_MS = 30 * 1000;         // 30 s entre mensajes de la misma cuenta
const MIN_MESSAGE_CHARS = 10;
const MAX_MESSAGE_CHARS = 1500;
const MAX_NAME_CHARS = 60;
const MAX_EMAIL_CHARS = 120;

const TOPICS = [
  'Consulta general',
  'Problema técnico',
  'Pago o activación VIP',
  'Sugerencia o idea',
  'Otro'
];

const ipHits = new Map();

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'desconocida';
}

function isIpLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_LIMIT_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > IP_LIMIT_MAX;
}

function limaDayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ts));
}

function limaDateTime(ts) {
  return new Date(ts).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'long',
    timeStyle: 'short'
  });
}

function dbPath(path) {
  return DB_URL + '/' + path + '.json';
}

async function dbGet(path, idToken) {
  const resp = await fetch(dbPath(path) + '?auth=' + encodeURIComponent(idToken), {
    headers: { Accept: 'application/json' }
  });
  if (!resp.ok) return { ok: false, status: resp.status, value: null };
  return { ok: true, status: resp.status, value: await resp.json() };
}

async function dbPut(path, value, idToken) {
  try {
    const resp = await fetch(dbPath(path) + '?auth=' + encodeURIComponent(idToken), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
    return resp.ok;
  } catch (err) {
    return false;
  }
}

function cleanSingleLine(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanMessage(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= MAX_EMAIL_CHARS;
}

/* Verifica el token leyendo una ruta privada del usuario en Firebase. */
async function detectVip(uid, idToken) {
  if (!uid || !idToken) return false;
  if (!/^[A-Za-z0-9]{10,64}$/.test(uid)) return false;
  if (idToken.length < 100) return false;
  try {
    const read = await dbGet('users/' + encodeURIComponent(uid) + '/isVip', idToken);
    return read.ok && read.value === true;
  } catch (err) {
    return false;
  }
}

/* Límite por cuenta; si las reglas aún no permiten leer los intentos, no bloquea. */
async function accountLimitReached(uid, idToken, now, day) {
  if (!uid || !idToken) return false;
  const read = await dbGet('contact_attempts/' + encodeURIComponent(uid) + '/' + day, idToken);
  if (!read.ok) return false;
  const entries = read.value && typeof read.value === 'object' ? Object.keys(read.value) : [];
  if (entries.length >= ACCOUNT_DAILY_LIMIT) return true;
  const last = entries.reduce(function (max, key) {
    const t = Number(read.value[key] && read.value[key].t) || 0;
    return t > max ? t : max;
  }, 0);
  return !!(last && now - last < ACCOUNT_MIN_GAP_MS);
}

function buildEmailHtml(data) {
  const vip = !!data.vip;
  const headerBg = vip
    ? 'linear-gradient(135deg, #ffd700, #f0a500)'
    : 'linear-gradient(135deg, #007bb5, #005f8a)';
  const headerColor = vip ? '#1a1a1a' : '#ffffff';
  const badge = vip
    ? '<span style="display: inline-block; background: #1a1a1a; color: #ffd700; font-size: 11px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 4px 10px; border-radius: 10px; margin-bottom: 8px;">👑 Usuario VIP · Prioridad</span>'
    : '<span style="display: inline-block; background: rgba(255,255,255,0.2); color: #ffffff; font-size: 11px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 4px 10px; border-radius: 10px; margin-bottom: 8px;">Usuario estándar</span>';

  const replyLink = 'mailto:' + encodeURIComponent(data.email) +
    '?subject=' + encodeURIComponent('Re: ' + data.topic + ' — MindStack');

  return `
  <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
    <div style="background: ${headerBg}; padding: 22px 24px; border-radius: 12px 12px 0 0;">
      ${badge}
      <h1 style="margin: 0; font-size: 20px; color: ${headerColor};">✉️ Nuevo mensaje de soporte</h1>
      <p style="margin: 6px 0 0 0; font-size: 13px; color: ${vip ? '#333' : '#e8f4fa'};">MindStack · Página Equipo</p>
    </div>

    <div style="border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
      ${vip ? '<div style="background: #fff8d6; border: 1px solid #ffe58a; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px;"><b>Este usuario es VIP.</b> Se recomienda responder primero.</div>' : ''}

      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 0 0 18px 0;">
        <tr>
          <td style="padding: 7px 0; color: #666; width: 38%;">Nombre</td>
          <td style="padding: 7px 0;">${escapeHtml(data.name || '(no indicado)')}</td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">Correo de respuesta</td>
          <td style="padding: 7px 0;"><a href="${replyLink}" style="color: #007bb5;">${escapeHtml(data.email)}</a></td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">Motivo</td>
          <td style="padding: 7px 0; font-weight: bold;">${escapeHtml(data.topic)}</td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">Tipo de usuario</td>
          <td style="padding: 7px 0; font-weight: bold; color: ${vip ? '#b8860b' : '#444'};">${vip ? '👑 VIP' : 'Estándar'}</td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">Cuenta MindStack</td>
          <td style="padding: 7px 0; font-family: monospace; font-size: 12px;">${escapeHtml(data.accountEmail || data.email)}</td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">UID de Firebase</td>
          <td style="padding: 7px 0; font-family: monospace; font-size: 12px;">${escapeHtml(data.uid || '(sin sesión)')}</td>
        </tr>
        <tr>
          <td style="padding: 7px 0; color: #666;">Fecha</td>
          <td style="padding: 7px 0;">${escapeHtml(limaDateTime(data.createdAt))}</td>
        </tr>
      </table>

      <div style="background: #f7f7f7; border-left: 3px solid ${vip ? '#ffd700' : '#007bb5'}; border-radius: 8px; padding: 14px 16px; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(data.message)}</div>

      <p style="margin: 20px 0 0 0;">
        <a href="${replyLink}" style="display: inline-block; background: #007bb5; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: bold;">
          Responder a ${escapeHtml(data.name || data.email)} →
        </a>
      </p>

      <p style="font-size: 11px; color: #999; margin: 22px 0 0 0;">
        Enviado desde el formulario de contacto de MindStack. IP de origen: ${escapeHtml(data.ip || 'desconocida')}.
      </p>
    </div>
  </div>`;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Origen no permitido.' });
  }

  const ip = getClientIp(req);
  if (isIpLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados mensajes. Espera unos minutos e inténtalo de nuevo.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  /* Honeypot: solo los bots completan este campo. Se responde ok sin enviar nada. */
  if (cleanSingleLine(body.website, 200)) {
    return res.status(200).json({ ok: true, vip: false });
  }

  const name = cleanSingleLine(body.name, MAX_NAME_CHARS);
  const email = cleanSingleLine(body.email, MAX_EMAIL_CHARS).toLowerCase();
  const topic = cleanSingleLine(body.topic, 60) || 'Consulta general';
  const message = cleanMessage(body.message);
  const uid = cleanSingleLine(body.uid, 64);
  const idToken = String(body.idToken || '').trim();

  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Escribe un correo válido para poder responderte.' });
  }
  if (message.length < MIN_MESSAGE_CHARS) {
    return res.status(400).json({ error: 'Tu mensaje debe tener al menos ' + MIN_MESSAGE_CHARS + ' caracteres.' });
  }
  if (!TOPICS.includes(topic)) {
    return res.status(400).json({ error: 'Motivo de contacto inválido.' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Falta configurar RESEND_API_KEY en Vercel.' });
  }

  const now = Date.now();
  const vip = await detectVip(uid, idToken);

  if (await accountLimitReached(uid, idToken, now, limaDayKey(now))) {
    return res.status(429).json({
      error: 'Ya enviaste varios mensajes hoy. Escríbenos directamente a ' + CONTACT_TO + ' si es urgente.',
      code: 'daily_limit'
    });
  }

  const mail = {
    name: name,
    email: email,
    topic: topic,
    message: message,
    uid: uid,
    accountEmail: email,
    vip: vip,
    createdAt: now,
    ip: ip
  };

  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [CONTACT_TO],
        reply_to: email,
        subject: (vip ? '[VIP] Soporte prioritario — ' : '[Usuario] Soporte — ') +
          topic + ' — ' + (name || email),
        html: buildEmailHtml(mail)
      })
    });

    if (!emailResp.ok) {
      const detail = await emailResp.text();
      console.error('Resend error:', emailResp.status, detail);
      return res.status(502).json({ error: 'No se pudo enviar el mensaje. Inténtalo de nuevo o escríbenos a ' + CONTACT_TO + '.' });
    }
  } catch (err) {
    console.error('Error enviando correo de contacto:', err);
    return res.status(502).json({ error: 'Error enviando el mensaje. Inténtalo de nuevo o escríbenos a ' + CONTACT_TO + '.' });
  }

  /* Registro best-effort del intento (solo si las reglas lo permiten). */
  if (uid && idToken) {
    const attemptId = 'c' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    await dbPut('contact_attempts/' + encodeURIComponent(uid) + '/' + limaDayKey(now) + '/' + attemptId, { t: now }, idToken);
  }

  return res.status(200).json({ ok: true, vip: vip });
};

/**
 * POST /api/notify-yape
 *
 * Avisa por correo que un usuario registró un pago con Yape.
 * No activa el VIP: solo notifica para que el equipo valide el pago
 * manualmente en la app de Yape y luego active el VIP en Firebase.
 *
 * Variables de entorno necesarias en Vercel:
 *   RESEND_API_KEY        -> clave de https://resend.com
 *   PAYMENT_NOTIFY_EMAIL  -> correo que recibe el aviso (mindstackn7@gmail.com)
 *   PAYMENTS_FROM_EMAIL   -> remitente verificado en Resend
 *   FIREBASE_DB_URL       -> URL de Realtime Database (opcional, tiene valor por defecto)
 *   ALLOWED_ORIGIN        -> dominio de la web, ej. https://mindstack.vercel.app (opcional pero recomendado)
 */

const DB_URL = process.env.FIREBASE_DB_URL || 'https://mindstack-6749c-default-rtdb.firebaseio.com';
const NOTIFY_TO = process.env.PAYMENT_NOTIFY_EMAIL || 'mindstackn7@gmail.com';
const FROM_EMAIL = process.env.PAYMENTS_FROM_EMAIL || 'MindStack Pagos <onboarding@resend.dev>';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const RATE_LIMIT_MAX = 5;              // solicitudes
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // por 10 minutos
const rateHits = new Map();            // best-effort por instancia

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'desconocida';
}

function buildEmailHtml(data) {
  const fecha = new Date(data.createdAt).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'long',
    timeStyle: 'short'
  });

  const uid = encodeURIComponent(data.uid || '');
  const consoleUrl =
    'https://console.firebase.google.com/project/mindstack-6749c/database/mindstack-6749c-default-rtdb/data/~2Fusers~2F' + uid;

  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
    <div style="background: linear-gradient(135deg, #ffd700, #ff9900); padding: 22px 24px; border-radius: 12px 12px 0 0;">
      <h1 style="margin: 0; font-size: 20px; color: #111;">💛 Nuevo pago Yape por validar</h1>
      <p style="margin: 6px 0 0 0; font-size: 13px; color: #333;">MindStack Premium · S/ 5.00</p>
    </div>

    <div style="border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
      <p style="font-size: 14px; margin-top: 0;">
        Un usuario acaba de registrar su pago. <b>Verifica el código en la app de Yape antes de activar el VIP.</b>
      </p>

      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 18px 0;">
        <tr>
          <td style="padding: 8px 0; color: #666; width: 42%;">Código de operación</td>
          <td style="padding: 8px 0; font-size: 20px; font-weight: bold; letter-spacing: 1px;">${escapeHtml(data.operationCode)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Monto</td>
          <td style="padding: 8px 0; font-weight: bold;">S/ ${Number(data.amount || 0).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Correo de la cuenta</td>
          <td style="padding: 8px 0;">${escapeHtml(data.email)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Nombre indicado</td>
          <td style="padding: 8px 0;">${escapeHtml(data.name || '(no indicado)')}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Fecha del registro</td>
          <td style="padding: 8px 0;">${escapeHtml(fecha)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">UID de Firebase</td>
          <td style="padding: 8px 0; font-family: monospace; font-size: 12px;">${escapeHtml(data.uid)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">ID de solicitud</td>
          <td style="padding: 8px 0; font-family: monospace; font-size: 12px;">${escapeHtml(data.__requestId)}</td>
        </tr>
      </table>

      <div style="background: #fff8d6; border: 1px solid #ffe58a; border-radius: 8px; padding: 14px; font-size: 13px; line-height: 1.5;">
        <b>Pasos para activar el VIP:</b><br>
        1. Abre Yape y confirma el pago con ese código, monto y fecha.<br>
        2. En Firebase, abre el usuario y cambia <code>isVip</code> a <code>true</code>.<br>
        3. Opcional: guarda <code>vipPlan: "yape"</code>, <code>vipSince</code> y el código en <code>lastYapeCode</code>.
      </div>

      <p style="margin: 20px 0 0 0;">
        <a href="${consoleUrl}" style="display: inline-block; background: #007bb5; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: bold;">
          Abrir usuario en Firebase →
        </a>
      </p>

      <p style="font-size: 11px; color: #999; margin: 22px 0 0 0;">
        Este aviso se generó porque el usuario envió el formulario de pago en MindStack.
        Yape no envía notificaciones automáticas a este correo.
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
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Espera unos minutos.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const requestId = String(body.requestId || '').trim();
  const idToken = String(body.idToken || '').trim();

  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    return res.status(400).json({ error: 'ID de solicitud inválido.' });
  }
  if (!idToken || idToken.length < 100) {
    return res.status(401).json({ error: 'Falta el token de la sesión.' });
  }

  let payment;
  try {
    const url = DB_URL.replace(/\/$/, '') + '/payment_requests/' +
      encodeURIComponent(requestId) + '.json?auth=' + encodeURIComponent(idToken);
    const dbResp = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!dbResp.ok) {
      return res.status(502).json({ error: 'No se pudo leer la solicitud en Firebase.' });
    }

    payment = await dbResp.json();
  } catch (err) {
    return res.status(502).json({ error: 'Error de conexión con Firebase.' });
  }

  if (!payment) {
    return res.status(404).json({ error: 'La solicitud no existe.' });
  }
  if (payment.status !== 'pending') {
    return res.status(409).json({ error: 'La solicitud ya fue procesada.' });
  }
  if (Number(payment.amount) !== 5) {
    return res.status(400).json({ error: 'Monto inválido.' });
  }
  if (!/^\d{6,12}$/.test(String(payment.operationCode || ''))) {
    return res.status(400).json({ error: 'Código de operación inválido.' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Falta configurar RESEND_API_KEY en Vercel.' });
  }

  payment.__requestId = requestId;

  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_TO],
        reply_to: payment.email,
        subject: '💛 Pago Yape S/5 por validar — ' + payment.operationCode,
        html: buildEmailHtml(payment)
      })
    });

    if (!emailResp.ok) {
      const detail = await emailResp.text();
      console.error('Resend error:', emailResp.status, detail);
      return res.status(502).json({ error: 'No se pudo enviar el correo de aviso.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error enviando correo:', err);
    return res.status(502).json({ error: 'Error enviando el correo de aviso.' });
  }
};

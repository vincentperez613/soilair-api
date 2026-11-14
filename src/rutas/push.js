/**
 * src/rutas/push.js
 * -----------------------------------------------------------------------------
 *   GET    /api/push/llave-publica                      -> { publicKey }
 *   POST   /api/push/suscripciones   (Bearer) {subscription.toJSON()} -> 201/200
 *   DELETE /api/push/suscripciones   (Bearer) { endpoint }            -> 204
 *   GET    /api/push/suscripciones   (Bearer)          -> dispositivos del usuario
 *
 * No existe una ruta para ENVIAR: el envío lo hace el propio servidor cuando
 * ocurre un evento (src/eventos/nuevaEntrada.js).
 */

import { Router } from 'express';
import { config } from '../config.js';
import { consulta } from '../db.js';
import { sesionRequerida } from '../sesiones.js';

export const rutasPush = Router();

/**
 * Servicios push de los navegadores. El servidor hará POST al endpoint que
 * mande el cliente; sin esta lista, alguien con sesión podría registrar una URL
 * interna y usar el servidor para llamarla (SSRF).
 */
const SERVICIOS_PUSH = [
  'fcm.googleapis.com', // Chrome, Opera, Samsung Internet, Brave
  'android.googleapis.com',
  'updates.push.services.mozilla.com', // Firefox
  'notify.windows.com', // Edge (WNS): *.notify.windows.com
  'push.apple.com', // Safari: web.push.apple.com
];

function esServicioPush(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    SERVICIOS_PUSH.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
}

/** p256dh: punto P-256 sin comprimir (65 bytes, empieza en 0x04). auth: 16 bytes. */
function llavesValidas(keys) {
  try {
    const p256dh = Buffer.from(String(keys?.p256dh ?? ''), 'base64url');
    const auth = Buffer.from(String(keys?.auth ?? ''), 'base64url');
    return p256dh.length === 65 && p256dh[0] === 0x04 && auth.length === 16;
  } catch {
    return false;
  }
}

rutasPush.get('/llave-publica', (_req, res) => {
  // no-cache: si las llaves se rotan, la app debe ver la nueva enseguida.
  res.set('Cache-Control', 'no-cache');
  res.json({ publicKey: config.vapid.publica });
});

rutasPush.post('/suscripciones', sesionRequerida, async (req, res) => {
  const { endpoint, keys } = req.body ?? {};

  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !esServicioPush(endpoint)) {
    return res.status(400).json({ error: 'El endpoint no es de un servicio push conocido.' });
  }
  if (!llavesValidas(keys)) {
    return res.status(400).json({ error: 'Faltan las llaves p256dh y auth de la suscripción.' });
  }

  const userAgent = String(req.get('user-agent') ?? '').slice(0, 300) || null;

  // Upsert por endpoint: al reenviar la suscripción al abrir la app solo se
  // actualiza. Si en ese navegador ahora entró OTRO usuario, pasa a ser suya.
  // (xmax = 0) es true cuando la fila se acaba de insertar.
  const { rows } = await consulta(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            user_agent = EXCLUDED.user_agent,
            updated_at = now()
     RETURNING id, created_at, (xmax = 0) AS nueva`,
    [req.usuario.id, endpoint, keys.p256dh, keys.auth, userAgent]
  );

  const fila = rows[0];
  console.log(
    `[push] ${req.usuario.usuario}: suscripción #${fila.id} ${fila.nueva ? 'guardada' : 'actualizada'} (${new URL(endpoint).host})`
  );
  res.status(fila.nueva ? 201 : 200).json({ id: fila.id, creadaEn: fila.created_at, nueva: fila.nueva });
});

rutasPush.delete('/suscripciones', sesionRequerida, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Falta el endpoint.' });

  // Solo puede borrar las suyas.
  const { rowCount } = await consulta(
    'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
    [endpoint, req.usuario.id]
  );
  console.log(`[push] ${req.usuario.usuario}: baja de suscripción (${rowCount} fila)`);
  res.status(204).end();
});

rutasPush.get('/suscripciones', sesionRequerida, async (req, res) => {
  const { rows } = await consulta(
    `SELECT id, endpoint, user_agent, created_at, updated_at
       FROM push_subscriptions
      WHERE user_id = $1
      ORDER BY created_at`,
    [req.usuario.id]
  );

  // Se devuelve el endpoint para que la app reconozca "este dispositivo"; las
  // llaves p256dh/auth nunca salen del servidor.
  res.json(
    rows.map((fila) => ({
      id: fila.id,
      endpoint: fila.endpoint,
      servicio: new URL(fila.endpoint).host,
      userAgent: fila.user_agent,
      creadaEn: fila.created_at,
      actualizadaEn: fila.updated_at,
    }))
  );
});

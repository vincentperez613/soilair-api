/**
 * src/push/enviar.js
 * -----------------------------------------------------------------------------
 * Envío de notificaciones push con la librería web-push (VAPID + cifrado
 * aes128gcm). NO hay un endpoint público que llame a esto: solo lo usa el
 * propio servidor cuando ocurre un evento (ver src/eventos/nuevaEntrada.js).
 *
 * MANTENIMIENTO DE SUSCRIPCIONES, según lo que responda el servicio push:
 *
 *   201 / 2xx   entregado al servicio push.
 *   404 / 410   la suscripción ya no existe (el usuario la revocó, desinstaló
 *               o limpió datos): se BORRA de la base.
 *   429         demasiadas peticiones: se respeta Retry-After y se reintenta
 *               UNA vez (si la espera es de 20 s o menos y el aviso no
 *               habría caducado según su TTL). Si no, se descarta el aviso.
 *   5xx / red   falla del servicio push: mismo reintento único; la
 *               suscripción NO se borra (no es culpa de ella).
 *   otros 4xx   400/403/413: problema de la petición o de las llaves VAPID.
 *               Se registra en el log y no se toca la suscripción.
 *
 * Nada de esto bloquea a la aplicación: la ruta responde ANTES de enviar (ver
 * enSegundoPlano en src/rutas/bitacora.js) y cada suscripción se atiende por
 * separado con Promise.allSettled.
 *
 * En Vercel, el reintento se ESPERA dentro de esta misma promesa (que
 * waitUntil mantiene viva) en vez de programarlo con un setTimeout suelto: al
 * terminar la invocación, un temporizador pendiente no tiene garantizado
 * ejecutarse.
 */

import webpush from 'web-push';
import { config } from '../config.js';
import { consulta } from '../db.js';

webpush.setVapidDetails(config.vapid.subject, config.vapid.publica, config.vapid.privada);

/** Tiempo máximo de espera de cada petición al servicio push. */
const TIMEOUT_MS = 10_000;

/**
 * Un reintento solo si el servicio pide esperar como mucho esto. Corto a
 * propósito: la espera ocurre dentro de la invocación de la función.
 */
const MAX_ESPERA_REINTENTO_S = 20;

/** Espera por defecto si un 429/5xx no trae Retry-After. */
const ESPERA_POR_DEFECTO_S = 5;

const dormir = (segundos) => new Promise((resolver) => setTimeout(resolver, segundos * 1000));

/** Para los logs: el host del endpoint basta para saber qué servicio es. */
const servicio = (endpoint) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'endpoint inválido';
  }
};

/** Retry-After puede venir en segundos o como fecha HTTP. */
function segundosDeEspera(valor) {
  if (!valor) return null;
  const segundos = Number(valor);
  if (Number.isFinite(segundos)) return Math.max(0, Math.ceil(segundos));
  const fecha = Date.parse(valor);
  return Number.isNaN(fecha) ? null : Math.max(0, Math.ceil((fecha - Date.now()) / 1000));
}

async function borrarSuscripcion(id) {
  await consulta('DELETE FROM push_subscriptions WHERE id = $1', [id]);
}

/**
 * Envía un mensaje a UNA suscripción y aplica las reglas de arriba.
 *
 * @returns {Promise<'enviada'|'reintentada'|'eliminada'|'fallida'>}
 */
async function enviarUna(suscripcion, payload, opciones, intento = 1) {
  const { ttl, urgencia, tema } = opciones;

  try {
    const respuesta = await webpush.sendNotification(
      {
        endpoint: suscripcion.endpoint,
        keys: { p256dh: suscripcion.p256dh, auth: suscripcion.auth },
      },
      payload,
      { TTL: ttl, urgency: urgencia, topic: tema, timeout: TIMEOUT_MS }
    );

    console.log(
      `[push] suscripción #${suscripcion.id} (${servicio(suscripcion.endpoint)}): HTTP ${respuesta.statusCode}, TTL ${ttl} s`
    );
    return intento === 1 ? 'enviada' : 'reintentada';
  } catch (error) {
    const estado = error.statusCode;
    const donde = `suscripción #${suscripcion.id} (${servicio(suscripcion.endpoint)})`;

    // 404 / 410: suscripción muerta -> se elimina.
    if (estado === 404 || estado === 410) {
      await borrarSuscripcion(suscripcion.id);
      console.log(`[push] ${donde}: HTTP ${estado}, ya no existe -> eliminada de la base`);
      return 'eliminada';
    }

    // 429 o falla del servicio push: un solo reintento si todavía tiene sentido.
    if (estado === 429 || estado >= 500 || estado === undefined) {
      const espera = segundosDeEspera(error.headers?.['retry-after']) ?? ESPERA_POR_DEFECTO_S;
      const motivo = estado ? `HTTP ${estado}` : error.message;

      if (intento === 1 && espera <= MAX_ESPERA_REINTENTO_S && espera < ttl) {
        console.warn(`[push] ${donde}: ${motivo} -> se reintenta en ${espera} s`);
        await dormir(espera);
        // Lo que queda de vida al aviso: no se debe entregar más tarde de lo
        // que se prometió con el TTL original.
        return enviarUna(suscripcion, payload, { ...opciones, ttl: ttl - espera }, 2);
      }

      console.warn(`[push] ${donde}: ${motivo}; se descarta este aviso (la suscripción se conserva)`);
      return 'fallida';
    }

    // 400, 403, 413…: la petición o las llaves están mal. No se borra nada.
    console.error(`[push] ${donde}: HTTP ${estado} ${error.body ?? ''}`.trim());
    return 'fallida';
  }
}

/**
 * Envía un aviso a TODOS los dispositivos de un usuario.
 *
 * @param {number|string} userId
 * @param {{title: string, body: string, url: string, tag?: string}} mensaje
 *        `url` es RELATIVA al scope del Service Worker ("cultivo/maiz"), así
 *        funciona bajo /soilAir-pwa/ en GitHub Pages y bajo / en local.
 * @param {{ttl: number, urgencia?: 'very-low'|'low'|'normal'|'high', tema?: string}} opciones
 *        ttl en segundos: cuánto puede guardar el servicio push el aviso si el
 *        dispositivo está apagado o sin red. Pasado ese tiempo se descarta.
 */
export async function enviarAUsuario(userId, mensaje, { ttl, urgencia = 'normal', tema } = {}) {
  if (!Number.isInteger(ttl) || ttl < 0) throw new Error('enviarAUsuario: falta un TTL válido');

  const { rows } = await consulta(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );

  if (!rows.length) {
    console.log(`[push] usuario ${userId}: sin suscripciones, no se envía nada`);
    return { total: 0 };
  }

  const payload = JSON.stringify(mensaje);
  const resultados = await Promise.allSettled(
    rows.map((suscripcion) => enviarUna(suscripcion, payload, { ttl, urgencia, tema }))
  );

  const resumen = { total: rows.length, enviada: 0, reintentada: 0, eliminada: 0, fallida: 0 };
  for (const resultado of resultados) {
    resumen[resultado.status === 'fulfilled' ? resultado.value : 'fallida'] += 1;
  }

  console.log(`[push] usuario ${userId}: ${JSON.stringify(resumen)}`);
  return resumen;
}

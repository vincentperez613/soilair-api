/**
 * src/rutas/bitacora.js
 * -----------------------------------------------------------------------------
 *   POST /api/bitacora   (Bearer opcional)
 *        { idCliente, cultivo, tipo, nota, fecha, ubicacion?, referencia? }
 *        -> 201 { id }  entrada nueva
 *        -> 200 { id, duplicada: true }  ya existía (reintento de la cola)
 *
 * Es el endpoint al que la app manda la cola de la bitácora (outbox), desde la
 * página o desde el Service Worker con Background Sync. Reemplaza a
 * JSONPlaceholder: aquí la entrada sí se guarda.
 *
 * AQUÍ OCURRE EL EVENTO QUE DISPARA EL PUSH: ver avisarNuevaEntrada() abajo.
 */

import { Router } from 'express';
import { consulta } from '../db.js';
import { avisarNuevaEntrada, TIPOS } from '../eventos/nuevaEntrada.js';
import { enSegundoPlano } from '../segundoPlano.js';
import { sesionOpcional } from '../sesiones.js';

export const rutasBitacora = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CULTIVO = /^[a-z0-9-]{1,40}$/;
const MAX_NOTA = 280;
const MAX_REFERENCIA = 120;

function leerUbicacion(ubicacion) {
  if (!ubicacion) return null;
  const { lat, lon, precision, fecha } = ubicacion;
  if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    precision: Number.isFinite(precision) ? precision : null,
    fecha: typeof fecha === 'string' ? fecha.slice(0, 40) : null,
  };
}

/** Valida el cuerpo; devuelve la entrada limpia o { error }. */
function leerEntrada(cuerpo) {
  const idCliente = String(cuerpo?.idCliente ?? '');
  const cultivo = String(cuerpo?.cultivo ?? '');
  const tipo = String(cuerpo?.tipo ?? '');
  const nota = String(cuerpo?.nota ?? '').trim();

  if (!UUID.test(idCliente)) return { error: 'idCliente debe ser un UUID.' };
  if (!CULTIVO.test(cultivo)) return { error: 'Cultivo inválido.' };
  if (!(tipo in TIPOS)) return { error: 'Tipo de entrada inválido.' };
  if (!nota || nota.length > MAX_NOTA) return { error: `La nota debe tener de 1 a ${MAX_NOTA} caracteres.` };

  const fecha = new Date(cuerpo?.fecha ?? Date.now());

  return {
    idCliente,
    cultivo,
    tipo,
    nota,
    referencia: String(cuerpo?.referencia ?? '').trim().slice(0, MAX_REFERENCIA) || null,
    ubicacion: leerUbicacion(cuerpo?.ubicacion),
    fecha: Number.isNaN(fecha.getTime()) ? new Date() : fecha,
  };
}

rutasBitacora.post('/', sesionOpcional, async (req, res) => {
  const entrada = leerEntrada(req.body);
  if (entrada.error) return res.status(400).json({ error: entrada.error });

  // ON CONFLICT DO NOTHING: si la cola reenvía una entrada cuya respuesta se
  // perdió, no se crea otra fila (y tampoco se manda otro push).
  const { rows } = await consulta(
    `INSERT INTO bitacora (id_cliente, user_id, cultivo, tipo, nota, referencia, ubicacion, fecha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id_cliente) DO NOTHING
     RETURNING id`,
    [
      entrada.idCliente,
      req.usuario?.id ?? null,
      entrada.cultivo,
      entrada.tipo,
      entrada.nota,
      entrada.referencia,
      entrada.ubicacion,
      entrada.fecha,
    ]
  );

  if (!rows.length) {
    const existente = await consulta('SELECT id FROM bitacora WHERE id_cliente = $1', [entrada.idCliente]);
    return res.status(200).json({ id: existente.rows[0]?.id, duplicada: true });
  }

  const id = rows[0].id;
  res.status(201).json({ id });

  // ── DISPARADOR DEL PUSH ─────────────────────────────────────────────────
  // Se creó un registro de la bitácora con sesión: se avisa a los dispositivos
  // de ese usuario. Va DESPUÉS de responder: la app no espera al servicio
  // push, y si este falla (429, 5xx) la entrada ya quedó guardada.
  // enSegundoPlano() usa waitUntil de Vercel para que la función no se
  // congele antes de terminar de enviar.
  if (req.usuario) {
    enSegundoPlano(
      avisarNuevaEntrada(req.usuario, { id, ...entrada }),
      `aviso de la entrada #${id}`
    );
  }
});

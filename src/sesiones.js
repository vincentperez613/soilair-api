/**
 * src/sesiones.js
 * -----------------------------------------------------------------------------
 * Cuentas y sesiones. La app (GitHub Pages) y este servidor viven en orígenes
 * distintos, así que la sesión NO va en una cookie (sería de terceros y varios
 * navegadores la bloquean): el servidor entrega un token y la app lo manda en
 * cada petición como `Authorization: Bearer <token>`.
 *
 *   contraseña  hash scrypt con sal aleatoria (node:crypto, sin dependencias)
 *   token       32 bytes aleatorios; en la base solo se guarda su SHA-256
 *   duración    30 días
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { consulta } from './db.js';

const scrypt = promisify(scryptCallback);

const DIAS_SESION = 30;
const LARGO_HASH = 64;

export async function hashPassword(password) {
  const sal = randomBytes(16);
  const derivada = await scrypt(password, sal, LARGO_HASH);
  return `scrypt$${sal.toString('base64url')}$${derivada.toString('base64url')}`;
}

export async function verificarPassword(password, guardado) {
  const [algoritmo, sal, hash] = String(guardado).split('$');
  if (algoritmo !== 'scrypt' || !sal || !hash) return false;

  const esperado = Buffer.from(hash, 'base64url');
  const derivada = await scrypt(password, Buffer.from(sal, 'base64url'), esperado.length);
  return timingSafeEqual(derivada, esperado);
}

/**
 * Hash de relleno: cuando el usuario no existe se verifica contra él, para que
 * la respuesta tarde lo mismo y no delate qué usuarios están registrados.
 */
const hashDeRelleno = hashPassword(randomBytes(16).toString('hex'));

export async function verificarCredenciales(usuario, password) {
  const { rows } = await consulta(
    'SELECT id, usuario, password_hash FROM usuarios WHERE usuario = $1',
    [usuario]
  );
  const fila = rows[0];
  const correcta = await verificarPassword(password, fila?.password_hash ?? (await hashDeRelleno));
  return fila && correcta ? { id: fila.id, usuario: fila.usuario } : null;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export async function crearSesion(userId) {
  const token = randomBytes(32).toString('base64url');
  await consulta(
    `INSERT INTO sesiones (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, DIAS_SESION]
  );
  return token;
}

export async function cerrarSesion(token) {
  await consulta('DELETE FROM sesiones WHERE token_hash = $1', [hashToken(token)]);
}

async function usuarioDeToken(token) {
  const { rows } = await consulta(
    `SELECT u.id, u.usuario
       FROM sesiones s
       JOIN usuarios u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

export function leerToken(req) {
  const coincidencia = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.get('authorization') ?? '');
  return coincidencia?.[1] ?? null;
}

/** Middleware: deja en req.usuario el dueño del token, o null si no hay sesión. */
export async function sesionOpcional(req, _res, next) {
  const token = leerToken(req);
  req.token = token;
  req.usuario = token ? await usuarioDeToken(token) : null;
  next();
}

/** Middleware: igual que el anterior, pero sin sesión válida responde 401. */
export async function sesionRequerida(req, res, next) {
  await sesionOpcional(req, res, () => {});
  if (!req.usuario) {
    res.status(401).json({ error: 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.' });
    return;
  }
  next();
}

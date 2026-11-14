/**
 * src/rutas/auth.js
 * -----------------------------------------------------------------------------
 *   POST /api/auth/registro   { usuario, password }  -> 201 { token, usuario }
 *   POST /api/auth/login      { usuario, password }  -> 200 { token, usuario }
 *   GET  /api/auth/sesion     (Bearer)               -> 200 { usuario }
 *   POST /api/auth/logout     (Bearer)               -> 204
 */

import { Router } from 'express';
import { consulta } from '../db.js';
import { limitarIntentos } from '../limitador.js';
import {
  cerrarSesion,
  crearSesion,
  hashPassword,
  sesionRequerida,
  verificarCredenciales,
} from '../sesiones.js';

export const rutasAuth = Router();

const USUARIO = /^[a-z0-9._-]{3,32}$/;

/** Valida el cuerpo y devuelve { usuario, password } o un mensaje de error. */
function leerCredenciales(cuerpo) {
  const usuario = String(cuerpo?.usuario ?? '').trim().toLowerCase();
  const password = String(cuerpo?.password ?? '');

  if (!USUARIO.test(usuario)) {
    return { error: 'El usuario debe tener de 3 a 32 caracteres: letras minúsculas, números, punto, guion o guion bajo.' };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: 'La contraseña debe tener entre 8 y 128 caracteres.' };
  }
  return { usuario, password };
}

// 10 intentos cada 15 minutos por IP en registro + login.
const limite = limitarIntentos({ maximo: 10, ventanaMs: 15 * 60 * 1000 });

rutasAuth.post('/registro', limite, async (req, res) => {
  const datos = leerCredenciales(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });

  let fila;
  try {
    const { rows } = await consulta(
      'INSERT INTO usuarios (usuario, password_hash) VALUES ($1, $2) RETURNING id, usuario',
      [datos.usuario, await hashPassword(datos.password)]
    );
    fila = rows[0];
  } catch (error) {
    // 23505 = unique_violation: ese nombre ya está tomado.
    if (error.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe.' });
    throw error;
  }

  const token = await crearSesion(fila.id);
  console.log(`[auth] cuenta nueva: ${fila.usuario}`);
  res.status(201).json({ token, usuario: fila.usuario });
});

rutasAuth.post('/login', limite, async (req, res) => {
  const datos = leerCredenciales(req.body);
  if (datos.error) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  const usuario = await verificarCredenciales(datos.usuario, datos.password);
  if (!usuario) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  const token = await crearSesion(usuario.id);
  res.json({ token, usuario: usuario.usuario });
});

rutasAuth.get('/sesion', sesionRequerida, (req, res) => {
  res.json({ usuario: req.usuario.usuario });
});

rutasAuth.post('/logout', sesionRequerida, async (req, res) => {
  await cerrarSesion(req.token);
  res.status(204).end();
});

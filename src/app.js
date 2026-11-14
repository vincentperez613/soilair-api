/**
 * src/app.js
 * -----------------------------------------------------------------------------
 * Aplicación Express. ES LA ENTRADA DE VERCEL.
 *
 * Vercel detecta Express cuando un archivo con uno de sus nombres de entrada
 * (src/app.js es uno) importa express y exporta la app por defecto. Toda la
 * app se vuelve UNA función serverless (Fluid compute). Por eso aquí:
 *   - no hay app.listen(): el puerto lo pone Vercel (en local lo abre
 *     src/servidor.js);
 *   - no hay express.static(): Vercel lo ignora (esta API no sirve archivos).
 */

import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { asegurarEsquema } from './db.js';
import { rutasAuth } from './rutas/auth.js';
import { rutasBitacora } from './rutas/bitacora.js';
import { rutasPush } from './rutas/push.js';

const app = express();

app.disable('x-powered-by');

// Vercel pone un proxy delante: sin esto, req.ip sería la del proxy y el
// límite de intentos de inicio de sesión contaría a todos como uno solo.
app.set('trust proxy', 1);

// CORS: solo el origen EXACTO del frontend (https://vperez25.github.io),
// nunca "*". La sesión viaja en el encabezado Authorization (no en cookies),
// por eso no hace falta credentials. maxAge guarda el preflight 10 min.
app.use(
  cors({
    origin: config.origenesPermitidos,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '16kb' }));

// Respuestas de la API: nunca se guardan en cachés intermedias (ni en la CDN
// de Vercel).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/salud', (_req, res) => res.json({ ok: true }));

// Primera petición de cada instancia: crea las tablas que falten.
app.use('/api', async (_req, _res, next) => {
  await asegurarEsquema();
  next();
});

app.use('/api/auth', rutasAuth);
app.use('/api/push', rutasPush);
app.use('/api/bitacora', rutasBitacora);

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// Express 5 manda aquí también los errores de las rutas async. Hay que
// responder siempre: un error tragado deja la función de Vercel colgada.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo no es JSON válido.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El cuerpo es demasiado grande.' });
  }
  console.error('[api] error no controlado:', error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

export default app;

/**
 * src/servidor.js  ->  npm run dev
 * -----------------------------------------------------------------------------
 * SOLO PARA DESARROLLO LOCAL. En Vercel no se usa: allá la entrada es
 * src/app.js y Vercel pone el servidor. Aquí se abre un puerto normal con la
 * misma app, leyendo las variables de .env.
 */

import app from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const servidor = app.listen(config.puerto, () => {
  console.log(`[api] SoilAir API en http://localhost:${config.puerto}`);
  console.log(`[api] CORS permitido para: ${config.origenesPermitidos.join(', ')}`);
});

async function cerrar(senal) {
  console.log(`[api] ${senal}: cerrando`);
  servidor.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);

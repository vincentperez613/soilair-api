/**
 * src/db.js
 * -----------------------------------------------------------------------------
 * Conexión a PostgreSQL (Neon). Las suscripciones viven aquí, no en memoria:
 * en Vercel cada instancia de la función es efímera y lo que quede en memoria
 * se pierde.
 *
 * AJUSTES PARA VERCEL
 *   - attachDatabasePool(): con Fluid compute la instancia se congela entre
 *     peticiones; esto cierra las conexiones inactivas antes de congelarla.
 *     Fuera de Vercel no hace nada.
 *   - idleTimeoutMillis corto: Vercel mantiene viva la función ese tiempo
 *     después de cada consulta, así que conviene que sea poco.
 *   - DATABASE_URL debe ser la cadena "pooled" de Neon (host con -pooler).
 */

import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { config } from './config.js';
import { ESQUEMA } from './esquema.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 5_000,
  // Neon suspende la base tras 5 min sin uso; despertarla tarda unos segundos.
  connectionTimeoutMillis: 10_000,
});

attachDatabasePool(pool);

// Un cliente inactivo que pierde la conexión emite 'error'. Sin este
// manejador, la instancia entera se caería.
pool.on('error', (error) => {
  console.warn(`[db] conexión inactiva cerrada: ${error.message}`);
});

/** Ejecuta una consulta con parámetros ($1, $2…). Nunca concatenar valores. */
export function consulta(sql, parametros = []) {
  return pool.query(sql, parametros);
}

/**
 * Crea las tablas que falten. En serverless no hay un "arranque del servidor"
 * donde migrar: se hace una vez por instancia, en su primera petición, y la
 * promesa se reutiliza. Si falla, se olvida para reintentar en la siguiente.
 */
let esquemaListo = null;

export function asegurarEsquema() {
  esquemaListo ??= pool.query(ESQUEMA).then(
    () => console.log('[db] esquema listo'),
    (error) => {
      esquemaListo = null;
      throw error;
    }
  );
  return esquemaListo;
}

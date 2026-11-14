/**
 * src/segundoPlano.js
 * -----------------------------------------------------------------------------
 * Trabajo que sigue DESPUÉS de responder (el envío del push).
 *
 * En un servidor normal bastaría con no poner await. En Vercel no: en cuanto
 * la función responde, la instancia puede congelarse y la promesa se queda a
 * medias (el push nunca sale). waitUntil() de @vercel/functions le dice a
 * Vercel que mantenga viva la invocación hasta que la promesa termine (con el
 * mismo límite de duración que la función: 300 s en el plan Hobby).
 *
 * Fuera de Vercel (npm run dev) waitUntil no hace nada y la promesa corre
 * normalmente en el proceso de Node.
 */

import { waitUntil } from '@vercel/functions';

/**
 * @param {Promise<unknown>} promesa
 * @param {string} descripcion para el log si falla
 */
export function enSegundoPlano(promesa, descripcion) {
  const segura = promesa.catch((error) =>
    console.error(`[segundo plano] ${descripcion}: ${error.message}`)
  );
  waitUntil(segura);
  return segura;
}

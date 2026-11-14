/**
 * scripts/generar-llaves.js  ->  npm run llaves
 * -----------------------------------------------------------------------------
 * Genera un par de llaves VAPID (curva P-256) con web-push y lo imprime.
 * No escribe ningún archivo: las llaves se copian a mano a las variables de
 * entorno (Vercel -> Settings -> Environment Variables, o .env en local). Equivale a
 * `npx web-push generate-vapid-keys`.
 *
 * Se genera UNA vez. Si se cambian, todas las suscripciones existentes dejan de
 * funcionar (ver README, "Rotar las llaves VAPID").
 */

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('\nGuárdalas como variables de entorno. La privada nunca va al repositorio.');

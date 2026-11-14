/**
 * src/config.js
 * -----------------------------------------------------------------------------
 * Lee y valida las variables de entorno. Es el ÚNICO archivo que toca
 * process.env: si falta un secreto, el servidor no arranca y lo dice aquí,
 * en vez de fallar a medias en el primer push.
 *
 * Ningún secreto está escrito en el código ni en el repositorio:
 *   - en producción se capturan en Vercel -> Settings -> Environment Variables;
 *   - en local van en .env (ignorado por git), que lee `npm run dev`.
 *
 * En Vercel este módulo se evalúa al arrancar cada instancia de la función:
 * si falta una variable, la función responde 500 y el log dice cuál.
 */

function requerida(nombre) {
  const valor = process.env[nombre]?.trim();
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}. Revisa .env.example.`);
  }
  return valor;
}

/**
 * CORS_ORIGIN admite uno o varios orígenes separados por coma (útil en local).
 * En producción debe ser UNO: https://vperez25.github.io
 *
 * Cada valor tiene que ser un origen exacto: sin "*", sin la ruta del
 * repositorio (/soilAir-pwa) y sin diagonal final. El navegador manda el
 * encabezado Origin así, y el paquete cors compara texto contra texto.
 */
function leerOrigenes() {
  const origenes = requerida('CORS_ORIGIN')
    .split(',')
    .map((origen) => origen.trim())
    .filter(Boolean);

  for (const origen of origenes) {
    let valido = false;
    try {
      valido = new URL(origen).origin === origen;
    } catch {
      valido = false;
    }
    if (!valido) {
      throw new Error(
        `CORS_ORIGIN inválido: "${origen}". Usa solo esquema y dominio, p. ej. https://vperez25.github.io`
      );
    }
  }

  return origenes;
}

function leerSubject() {
  const subject = requerida('VAPID_SUBJECT');
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    throw new Error('VAPID_SUBJECT debe empezar con "mailto:" o "https://".');
  }
  return subject;
}

export const config = Object.freeze({
  puerto: Number(process.env.PORT) || 3000,
  produccion: process.env.NODE_ENV === 'production',
  databaseUrl: requerida('DATABASE_URL'),
  origenesPermitidos: leerOrigenes(),
  vapid: Object.freeze({
    publica: requerida('VAPID_PUBLIC_KEY'),
    privada: requerida('VAPID_PRIVATE_KEY'),
    subject: leerSubject(),
  }),
});

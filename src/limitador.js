/**
 * src/limitador.js
 * -----------------------------------------------------------------------------
 * Límite de intentos por IP para las rutas de cuenta (registro e inicio de
 * sesión), para que nadie pruebe contraseñas por fuerza bruta. Vive en la
 * memoria de cada instancia de la función de Vercel: con Fluid compute una
 * instancia atiende muchas peticiones seguidas, así que frena los intentos
 * en ráfaga; si Vercel crea otra instancia, esa empieza su propio conteo.
 */

export function limitarIntentos({ maximo, ventanaMs }) {
  const intentos = new Map();

  return (req, res, next) => {
    const ahora = Date.now();

    // Limpieza ocasional para que el mapa no crezca sin fin.
    if (intentos.size > 5000) {
      for (const [ip, registro] of intentos) {
        if (ahora - registro.desde > ventanaMs) intentos.delete(ip);
      }
    }

    let registro = intentos.get(req.ip);
    if (!registro || ahora - registro.desde > ventanaMs) {
      registro = { cuenta: 0, desde: ahora };
      intentos.set(req.ip, registro);
    }

    registro.cuenta += 1;
    if (registro.cuenta > maximo) {
      const segundos = Math.ceil((registro.desde + ventanaMs - ahora) / 1000);
      res.set('Retry-After', String(segundos));
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' });
      return;
    }

    next();
  };
}

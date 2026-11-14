# SoilAir API

Backend de [SoilAir](https://vperez25.github.io/soilAir-pwa/): sesiones, bitácora de
campo y notificaciones push (Web Push con VAPID). Se despliega en **Vercel** como
función serverless de Express, con PostgreSQL en **Neon**.

El frontend vive en GitHub Pages, que es hosting estático: no ejecuta código de
servidor ni puede guardar secretos. Este servicio corre en otro origen
(`https://soilair-api.vercel.app`, con HTTPS), guarda los datos en Neon y es el
único que conoce la llave privada VAPID.

```
GitHub Pages (https://vperez25.github.io/soilAir-pwa/)
   │  fetch + Authorization: Bearer <token>        (CORS: solo https://vperez25.github.io)
   ▼
SoilAir API (Vercel, Express) ──► PostgreSQL (Neon)
   │  web-push (VAPID, aes128gcm, TTL)
   ▼
Servicio push del navegador (FCM, Mozilla, WNS, Apple) ──► Service Worker → showNotification
```

## Configuración específica de Vercel

| Qué | Dónde | Por qué |
| --- | --- | --- |
| Entrada `src/app.js` con `import express` y `export default app`, sin `app.listen()` | [`src/app.js`](src/app.js) | Así detecta Vercel una app Express y la convierte en **una** función (Fluid compute). El puerto lo pone Vercel; `src/servidor.js` solo abre uno en local. |
| `waitUntil()` de `@vercel/functions` para enviar el push **después** de responder | [`src/segundoPlano.js`](src/segundoPlano.js) | Al responder, Vercel puede congelar la función; sin `waitUntil` el push quedaría a medias. |
| Reintento del 429 esperado dentro de la misma promesa (máx. 20 s) | [`src/push/enviar.js`](src/push/enviar.js) | Un `setTimeout` suelto no tiene garantizado ejecutarse cuando termina la invocación. |
| `attachDatabasePool(pool)` e `idleTimeoutMillis` corto | [`src/db.js`](src/db.js) | Cierra las conexiones inactivas antes de que la instancia se suspenda. |
| Esquema embebido en JS y creado en la primera petición de cada instancia | [`src/esquema.js`](src/esquema.js), `asegurarEsquema()` | En serverless no hay "arranque del servidor" donde migrar, y un `.sql` leído con `fs` podría quedar fuera del bundle. |
| `regions: ["iad1"]` | [`vercel.json`](vercel.json) | La función corre en la misma región que la base de Neon (us-east-1). Cámbiala si tu base está en otra. |
| Variables en *Settings → Environment Variables* | Panel de Vercel | Los secretos no van en el repositorio. |
| Sin `express.static()` | — | Vercel lo ignora; esta API no sirve archivos. |

## Endpoints

| Método | Ruta | Sesión | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/salud` | — | Verificación de salud |
| POST | `/api/auth/registro` | — | Crea la cuenta y devuelve `{ token, usuario }` |
| POST | `/api/auth/login` | — | Inicia sesión y devuelve `{ token, usuario }` |
| GET | `/api/auth/sesion` | sí | Comprueba el token |
| POST | `/api/auth/logout` | sí | Invalida el token |
| GET | `/api/push/llave-publica` | — | Llave pública VAPID |
| POST | `/api/push/suscripciones` | sí | Guarda o actualiza la suscripción (`subscription.toJSON()`) |
| DELETE | `/api/push/suscripciones` | sí | Elimina la suscripción `{ endpoint }` del usuario |
| GET | `/api/push/suscripciones` | sí | Dispositivos suscritos del usuario |
| POST | `/api/bitacora` | opcional | Guarda una entrada de la bitácora. **Dispara el push** |

No hay endpoint para enviar notificaciones: el envío lo hace el servidor cuando
ocurre el evento.

## Variables de entorno

| Variable | Ejemplo | Para qué |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://…-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require` | Conexión a Neon (cadena *pooled*) |
| `VAPID_PUBLIC_KEY` | `BLZgx…` | Llave pública VAPID (también la recibe el navegador) |
| `VAPID_PRIVATE_KEY` | `bc3Zl…` | Llave privada VAPID. **Secreta** |
| `VAPID_SUBJECT` | `mailto:correo@dominio.com` | Contacto real del responsable (`mailto:` o `https://`) |
| `CORS_ORIGIN` | `https://vperez25.github.io` | Origen exacto del frontend, sin ruta ni `*` |
| `PORT` | `3000` | Solo en local (`npm run dev`) |

Si falta una, la función responde 500 y el log de Vercel dice cuál (`src/config.js`).

## Generar las llaves VAPID

```bash
npm install
npm run llaves          # equivale a: npx web-push generate-vapid-keys
```

Imprime `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`. Se generan **una vez** y se copian
a las variables de entorno; no se escriben en ningún archivo del repositorio.

## Dónde se guardan los secretos

- **Producción:** Vercel → proyecto → *Settings* → *Environment Variables*
  (cifradas por Vercel; marcar `VAPID_PRIVATE_KEY` y `DATABASE_URL` como
  *Sensitive*). Si la base se crea desde la integración de Neon en Vercel,
  `DATABASE_URL` se agrega sola.
- **Local:** en `.env`, que está en `.gitignore`. `.env.example` solo tiene
  marcadores.
- El repositorio no contiene ninguna llave ni contraseña. Las contraseñas de los
  usuarios se guardan como hash scrypt y los tokens de sesión como SHA-256.

## Esquema

[`src/esquema.js`](src/esquema.js) (idempotente; se ejecuta solo). Tabla de
suscripciones:

```sql
CREATE TABLE push_subscriptions (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);
```

Un usuario puede tener varias filas (celular, laptop). Guardar la misma
suscripción otra vez (la app la reenvía al abrir) actualiza la fila en lugar de
duplicarla (`ON CONFLICT (endpoint) DO UPDATE`).

Además: `usuarios`, `sesiones` y `bitacora` (con `id_cliente` único para que un
reintento de la cola no duplique la entrada ni el aviso).

## Qué dispara el push

Una **entrada nueva en la bitácora**. En [`src/rutas/bitacora.js`](src/rutas/bitacora.js),
después del `INSERT` (solo si la fila es nueva y llegó con sesión), se responde
`201` y en segundo plano se llama a `avisarNuevaEntrada()` de
[`src/eventos/nuevaEntrada.js`](src/eventos/nuevaEntrada.js), que envía a **todos**
los dispositivos del usuario:

```json
{ "title": "Plaga reportada · Chile Manzano",
  "body": "Plagas y enfermedades: Mosca blanca en el envés…",
  "url": "cultivo/chile-manzano", "tag": "bitacora-chile-manzano" }
```

`url` es relativa al scope del Service Worker, así funciona bajo `/soilAir-pwa/`.

| Tipo de entrada | TTL | Urgency | Por qué |
| --- | --- | --- | --- |
| Plagas y enfermedades | 6 h | high | Hay que atenderla el mismo día |
| Riego, fertilización, cosecha, observación | 1 h | normal | Es una confirmación; tarde ya no aporta |

`Topic` = `bitacora-<cultivo>`: si el dispositivo está sin red, el servicio push
reemplaza el aviso pendiente del mismo cultivo en vez de acumularlos.

## Limpieza de suscripciones muertas

En [`src/push/enviar.js`](src/push/enviar.js), según la respuesta del servicio push:

| Respuesta | Acción |
| --- | --- |
| 2xx | Entregado |
| **404 / 410** | La suscripción ya no existe → **se borra** de `push_subscriptions` |
| 429 | Se respeta `Retry-After` y se reintenta **una** vez si la espera es ≤ 20 s y el aviso no caducaría (con el TTL reducido); si no, se descarta el aviso |
| 5xx / red | Igual que 429; la suscripción se conserva |
| 400 / 403 / 413 | Se registra en el log; no se borra (suele ser un problema de llaves o del mensaje) |

El envío nunca bloquea: la ruta responde `201` **antes** de enviar
(`waitUntil`), y cada suscripción se atiende por separado (`Promise.allSettled`).
Cuando el usuario se da de baja o cierra sesión, la app borra su fila
(`DELETE /api/push/suscripciones`).

## Qué pasa si cambian las llaves VAPID

Cada suscripción queda atada a la llave pública con la que se creó
(`applicationServerKey`). Si se cambian las llaves:

1. Todos los envíos a suscripciones viejas fallan (el servicio push responde
   401/403 porque la firma ya no coincide). Nadie recibe avisos.
2. La app lo corrige sola **al abrirse**: `reenviarSuscripcion()` compara la llave
   de la suscripción con `/api/push/llave-publica`; si no coincide hace
   `unsubscribe()`, se vuelve a suscribir con la nueva y la manda al backend.
3. Los dispositivos que no vuelvan a abrir la app se quedan sin avisos; sus
   filas pueden borrarse a mano (`DELETE FROM push_subscriptions WHERE updated_at < …`).

En Vercel, cambiar una variable de entorno no afecta al despliegue que ya está
publicado: hay que **volver a desplegar** (*Deployments → Redeploy*).

## Despliegue en Vercel

1. **Repositorio:** subir esta carpeta a GitHub (por ejemplo `soilAir-api`).
2. **Proyecto:** [vercel.com](https://vercel.com) → *Add New… → Project* → importar
   el repositorio. *Framework Preset*: Express (lo detecta solo por `src/app.js`).
   Sin *Build Command* ni *Output Directory*. Nombre del proyecto: `soilair-api`.
3. **Base de datos:** en el proyecto, *Storage → Create Database → Neon*
   (región us-east-1) y conectarla al proyecto: agrega `DATABASE_URL`. También
   sirve crearla en [neon.tech](https://neon.tech) y pegar la cadena *pooled*.
4. **Variables:** *Settings → Environment Variables* (Production): `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` (de `npm run llaves`), `VAPID_SUBJECT` y
   `CORS_ORIGIN=https://vperez25.github.io`.
5. **Desplegar** (o *Redeploy* si el primer despliegue fue sin variables).
6. Abrir `https://soilair-api.vercel.app/api/salud` → `{"ok":true}`.
7. Si Vercel asignó otro dominio, cambiar `API_BASE` en
   `soilAir-pwa/src/config.js`.

Las tablas se crean solas con la primera petición a `/api/...`. Para verlas:
Neon → *SQL Editor*.

## Desarrollo local

```bash
cp .env.example .env        # y llenar los valores (una base de pruebas de Neon)
npm install
npm run dev                 # http://localhost:3000
```

El frontend abierto en `http://127.0.0.1:5500` (Live Server) usa
`http://localhost:3000` automáticamente (`API_BASE` en `src/config.js`), por eso
`CORS_ORIGIN=http://127.0.0.1:5500` en `.env`. También funciona `vercel dev`.

## Cómo probar el push

1. Abrir https://vperez25.github.io/soilAir-pwa/cuenta, crear cuenta o entrar.
2. *Activar avisos push* y aceptar el permiso. La lista muestra el dispositivo.
3. Cerrar la pestaña de SoilAir (el navegador puede seguir abierto).
4. Desde otro dispositivo (o navegador) con la misma cuenta, registrar una entrada
   en la Bitácora. En Vercel → *Logs* aparece:
   ```
   [evento] nueva entrada #12 de vincent (chile-manzano/plagas) -> push
   [push] suscripción #3 (fcm.googleapis.com): HTTP 201, TTL 21600 s
   ```
5. Llega la notificación; al tocarla se abre `…/soilAir-pwa/cultivo/chile-manzano`.

Para ver la tabla: Neon → *SQL Editor* →
`SELECT id, user_id, left(endpoint, 45) AS endpoint, created_at FROM push_subscriptions;`

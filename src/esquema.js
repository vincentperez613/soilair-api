/**
 * src/esquema.js
 * -----------------------------------------------------------------------------
 * Tablas de SoilAir en PostgreSQL (Neon). Va como texto dentro de un módulo JS
 * y no como archivo .sql para que Vercel lo meta seguro en el bundle de la
 * función (un archivo leído con fs en tiempo de ejecución podría quedar fuera).
 *
 * src/db.js lo ejecuta la primera vez que una instancia de la función atiende
 * una petición. Todo es IF NOT EXISTS: correrlo muchas veces no borra ni
 * duplica nada. También se puede pegar tal cual en el SQL Editor de Neon.
 */

export const ESQUEMA = /* sql */ `
-- Cuentas. La contraseña se guarda como hash scrypt con sal, nunca en claro.
CREATE TABLE IF NOT EXISTS usuarios (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario       TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sesiones. Se guarda el SHA-256 del token, no el token: quien lea la tabla no
-- puede usarlo para entrar.
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sesiones_user_id_idx ON sesiones (user_id);

-- Suscripciones push. Una fila por navegador/dispositivo: un usuario puede
-- tener varias (celular, laptop). El endpoint es único porque identifica a ESE
-- navegador ante su servicio push.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id);

-- Bitácora de campo. id_cliente lo genera la app (crypto.randomUUID) y es
-- único: si la cola reintenta un envío cuya respuesta se perdió, no se duplica
-- la entrada ni se manda otro push.
CREATE TABLE IF NOT EXISTS bitacora (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_cliente UUID        NOT NULL UNIQUE,
  user_id    BIGINT      REFERENCES usuarios (id) ON DELETE SET NULL,
  cultivo    TEXT        NOT NULL,
  tipo       TEXT        NOT NULL,
  nota       TEXT        NOT NULL,
  referencia TEXT,
  ubicacion  JSONB,
  fecha      TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bitacora_user_id_idx ON bitacora (user_id);
`;

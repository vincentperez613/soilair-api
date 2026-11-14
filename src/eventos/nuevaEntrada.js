/**
 * src/eventos/nuevaEntrada.js
 * -----------------------------------------------------------------------------
 * DISPARADOR DEL PUSH: se registró una entrada nueva en la bitácora.
 *
 * Lo llama src/rutas/bitacora.js justo después de que el INSERT creó la fila
 * (no en un reintento duplicado). Avisa a todos los dispositivos del usuario
 * que la registró: el técnico la anota en el celular en la parcela y la laptop
 * de la oficina se entera; el mismo celular recibe la confirmación del
 * servidor aunque la entrada haya salido por Background Sync con la pestaña
 * cerrada.
 *
 * El clic abre la ficha del cultivo (cultivo/<id>): esa pantalla existe en
 * todos los dispositivos, mientras que la lista de la bitácora es local de
 * cada navegador (IndexedDB).
 */

import { enviarAUsuario } from '../push/enviar.js';

/** Los mismos cultivos del catálogo de la app (src/services/cultivosIndex.js). */
const CULTIVOS = {
  jitomate: 'Jitomate',
  maiz: 'Maíz',
  lechuga: 'Lechuga',
  fresa: 'Fresa',
  'chile-manzano': 'Chile Manzano',
  trigo: 'Trigo',
};

/** Los mismos tipos de entrada que el formulario (src/views/BitacoraView.js). */
export const TIPOS = {
  riego: 'Riego',
  fertilizacion: 'Fertilización',
  plagas: 'Plagas y enfermedades',
  cosecha: 'Cosecha',
  observacion: 'Observación',
};

/**
 * TTL y urgencia según lo que dice el aviso:
 *
 *   plagas   urgencia alta, vive 6 h: una plaga hay que atenderla ese mismo día
 *            aunque el celular haya estado sin señal un rato.
 *   resto    urgencia normal, vive 1 h: es una confirmación; si el dispositivo
 *            estuvo apagado más tiempo, el aviso ya no aporta y se descarta.
 */
const HORA = 60 * 60;
const POLITICA = {
  plagas: { ttl: 6 * HORA, urgencia: 'high' },
  normal: { ttl: 1 * HORA, urgencia: 'normal' },
};

const nombreCultivo = (id) =>
  CULTIVOS[id] ?? id.replace(/-/g, ' ').replace(/^\p{L}/u, (letra) => letra.toUpperCase());

function recortar(texto, maximo) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo - 1)}…` : limpio;
}

/**
 * @param {{id: number|string, usuario: string}} usuario dueño de la entrada
 * @param {{id: number|string, cultivo: string, tipo: string, nota: string}} entrada
 */
export function avisarNuevaEntrada(usuario, entrada) {
  const cultivo = nombreCultivo(entrada.cultivo);
  const tipo = TIPOS[entrada.tipo] ?? entrada.tipo;
  const { ttl, urgencia } = POLITICA[entrada.tipo] ?? POLITICA.normal;

  const mensaje = {
    title: entrada.tipo === 'plagas' ? `Plaga reportada · ${cultivo}` : `Nueva entrada · ${cultivo}`,
    body: `${tipo}: ${recortar(entrada.nota, 110)}`,
    // Relativa al scope del Service Worker: sin "/" inicial ni nombre del repo.
    url: `cultivo/${encodeURIComponent(entrada.cultivo)}`,
    // Una notificación por cultivo: la nueva reemplaza a la anterior.
    tag: `bitacora-${entrada.cultivo}`,
    entradaId: String(entrada.id),
  };

  console.log(
    `[evento] nueva entrada #${entrada.id} de ${usuario.usuario} (${entrada.cultivo}/${entrada.tipo}) -> push`
  );

  // `topic` hace que el servicio push reemplace un aviso del mismo cultivo que
  // siga sin entregarse (dispositivo sin red), en vez de acumularlos.
  return enviarAUsuario(usuario.id, mensaje, {
    ttl,
    urgencia,
    tema: `bitacora-${entrada.cultivo}`.slice(0, 32),
  });
}

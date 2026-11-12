/* ============================================================================
 * config.js  ·  Configuración del proyecto
 * ----------------------------------------------------------------------------
 *  - Supabase: guarda la "data" (tareas, media, notas).
 *  - Cloudinary: guarda los archivos (imágenes y videos).
 *
 * La anon key de Supabase y el preset de Cloudinary son públicos por diseño
 * (van en el navegador). La seguridad real la da el RLS de Supabase
 * (ver supabase/schema.sql) y las restricciones del preset de Cloudinary.
 * ==========================================================================*/

window.APP_CONFIG = {
  /* ------------------------------------------------------------------ */
  /* 1) Supabase  (base de datos)                                        */
  /* ------------------------------------------------------------------ */
  SUPABASE_URL: "https://qqjhadwxboeichxtxree.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxamhhZHd4Ym9laWNoeHR4cmVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDY4ODAsImV4cCI6MjA5NTQyMjg4MH0.dM1VaV-lDPxoPlOHGAIbgfCSE3RMdURcVubq8tTs6yQ",

  /* ------------------------------------------------------------------ */
  /* 2) Cloudinary  (archivos: imágenes y videos)                        */
  /* ------------------------------------------------------------------ */
  CLOUDINARY: {
    CLOUD_NAME: "dp776nphp",
    UPLOAD_PRESET: "vit0x7dr",   // preset "unsigned"
    FOLDER: "",                  // opcional: carpeta destino en Cloudinary

    // Borrado de archivos. Cloudinary exige la API secret (no puede ir en el
    // navegador), así que se hace con una Edge Function de Supabase que la
    // guarda en secreto. Ver supabase/functions/limpieza/index.ts.
    DELETE_FUNCTION: "limpieza", // nombre de la Edge Function
    DELETE_TOKEN: "",            // solo si pusiste DELETE_TOKEN en la función
  },

  /* ------------------------------------------------------------------ */
  /* 3) Optimización (ahorro de ancho de banda)                          */
  /* ------------------------------------------------------------------ */
  // Las URLs que se piden a Cloudinary aplican transformaciones para
  // entregar el archivo lo más liviano posible (formato y calidad automáticos).
  MEDIA_TRANSFORMS: {
    // Imagen a pantalla completa (carrusel). f_auto -> WebP/AVIF, q_auto -> calidad
    IMAGE_FULL: "f_auto,q_auto,c_limit,w_900",
    // Miniatura en el editor
    IMAGE_THUMB: "f_auto,q_auto,c_fill,w_140,h_100",
    // Video a pantalla completa (reducido y recomprimido)
    VIDEO_FULL: "q_auto,c_limit,w_960",
    // Fotograma (poster) del video: evita descargar el video solo para verlo
    VIDEO_POSTER: "so_0,q_auto,c_fill,w_480",
    VIDEO_THUMB: "so_0,q_auto,c_fill,w_140,h_100",
  },

  // Tamaño máximo por archivo antes de subir (en MB). 0 = sin límite.
  MAX_UPLOAD_MB: 100,

  /* ------------------------------------------------------------------ */
  /* 4) Tablas                                                           */
  /* ------------------------------------------------------------------ */
  TABLES: {
    TASKS: "tasks",
    MEDIA: "task_media",
    NOTES: "task_notes",
  },

  /* ------------------------------------------------------------------ */
  /* 5) Comportamiento                                                   */
  /* ------------------------------------------------------------------ */
  // Extensiones que se tratan como video (el resto como imagen).
  VIDEO_EXTENSIONS: ["mp4", "webm", "ogg", "mov", "m4v", "avi", "mkv"],

  // Texto que se muestra cuando una tarea no tiene progreso asignado.
  DEFAULT_STATUS_LABEL: "Sin empezar",
};

/* ============================================================================
 * cloudinary.js · Subida de archivos y URLs optimizadas
 * ----------------------------------------------------------------------------
 * Sube imágenes y videos a Cloudinary con un preset "unsigned" (sin backend)
 * y construye las URLs aplicando transformaciones para gastar el mínimo
 * ancho de banda posible:
 *
 *   - Imágenes : f_auto (WebP/AVIF) + q_auto (calidad automática) + w_900
 *   - Videos   : q_auto + w_960, y un "poster" (fotograma) para no descargar
 *                el video completo hasta que el usuario le dé play.
 *
 * El "cómo se ve" cada transformación se define en config.js (MEDIA_TRANSFORMS),
 * así puedes ajustarlo sin tocar este archivo.
 * ==========================================================================*/

const Cloudinary = (() => {
  const cfg = window.APP_CONFIG || {};
  const cld = cfg.CLOUDINARY || {};
  const TR = cfg.MEDIA_TRANSFORMS || {};

  const CLOUD_NAME = (cld.CLOUD_NAME || "").trim();
  const PRESET = (cld.UPLOAD_PRESET || "").trim();
  const FOLDER = (cld.FOLDER || "").trim();

  const SUPABASE_URL = (cfg.SUPABASE_URL || "").replace(/\/+$/, "");
  const SUPABASE_KEY = (cfg.SUPABASE_ANON_KEY || "").trim();
  const DELETE_FUNCTION = (cld.DELETE_FUNCTION || "").trim();
  const DELETE_TOKEN = (cld.DELETE_TOKEN || "").trim();

  const configured = () => Boolean(CLOUD_NAME && PRESET);

  // El borrado real lo hace una Edge Function (necesita la API secret).
  const canDelete = () => Boolean(SUPABASE_URL && SUPABASE_KEY && DELETE_FUNCTION);

  /* ------------------------------------------------------------- subida -- */
  // Sube un File/Blob y devuelve { public_id, resource_type, format, url }.
  // onProgress(porcentaje) se llama durante la subida (0-100).
  function upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      if (!configured()) {
        reject(new Error("Cloudinary no está configurado en config.js"));
        return;
      }

      const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;
      const form = new FormData();
      form.append("upload_preset", PRESET);
      if (FOLDER) form.append("folder", FOLDER);
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint);

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }

        if (xhr.status >= 200 && xhr.status < 300 && data && data.public_id) {
          resolve({
            public_id: data.public_id,
            resource_type: data.resource_type || "image",
            format: data.format || "",
            url: data.secure_url || data.url || "",
            bytes: data.bytes || 0,
          });
        } else {
          const msg = (data && (data.error?.message || data.message)) ||
            `Error ${xhr.status} al subir el archivo`;
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => reject(new Error("Fallo de red al subir a Cloudinary"));
      xhr.send(form);
    });
  }

  /* ----------------------------------------------------------- borrado -- */
  // Borra un archivo de Cloudinary llamando a la Edge Function de Supabase.
  // Devuelve { result } o lanza un error con el mensaje del servidor.
  async function remove(publicId, resourceType) {
    if (!canDelete()) {
      throw new Error(
        "El borrado no está configurado (revisa CLOUDINARY.DELETE_FUNCTION en config.js)",
      );
    }
    if (!publicId) throw new Error("Falta el public_id del archivo");

    const headers = {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };
    if (DELETE_TOKEN) headers["x-delete-token"] = DELETE_TOKEN;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${DELETE_FUNCTION}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        public_id: publicId,
        resource_type: isVideo(resourceType) ? "video" : "image",
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Error ${res.status} al borrar el archivo`);
    }
    return data;
  }

  // Borra de Cloudinary los archivos que ya no están en la base de datos.
  // Devuelve { scanned, orphans, deleted, failures }.
  async function cleanup() {
    if (!canDelete()) {
      throw new Error(
        "La limpieza no está configurada (revisa CLOUDINARY.DELETE_FUNCTION en config.js)",
      );
    }

    const headers = {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };
    if (DELETE_TOKEN) headers["x-delete-token"] = DELETE_TOKEN;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${DELETE_FUNCTION}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "cleanup" }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Error ${res.status} al limpiar`);
    }
    return data;
  }

  /* -------------------------------------------------------------- URLs --- */
  const isVideo = (resourceType) => resourceType === "video";

  // Arma la URL de entrega con una transformación concreta.
  // kind: "image" | "video". ext: extensión opcional (para fotogramas -> .jpg).
  function build(kind, publicId, transform, ext = "") {
    if (!configured() || !publicId) return "";
    const t = transform ? `${transform}/` : "";
    return `https://res.cloudinary.com/${CLOUD_NAME}/${kind}/upload/${t}${publicId}${ext}`;
  }

  // Quita la extensión del public_id para poder añadir la nuestra.
  const stripExt = (publicId) => String(publicId).replace(/\.[a-z0-9]+$/i, "");

  const fullUrl = (item) =>
    isVideo(item.resource_type)
      ? build("video", item.public_id, TR.VIDEO_FULL)
      : build("image", item.public_id, TR.IMAGE_FULL);

  // Miniatura. Para video se pide un fotograma (image/jpeg generado desde el
  // recurso de video), así se descarga una imagen pequeña en vez del video.
  const thumbUrl = (item) =>
    isVideo(item.resource_type)
      ? build("video", stripExt(item.public_id), TR.VIDEO_THUMB, ".jpg")
      : build("image", item.public_id, TR.IMAGE_THUMB);

  // Fotograma del video para usarlo como poster.
  const posterUrl = (item) =>
    isVideo(item.resource_type)
      ? build("video", stripExt(item.public_id), TR.VIDEO_POSTER, ".jpg")
      : "";

  return { configured, canDelete, upload, remove, cleanup, fullUrl, thumbUrl, posterUrl, isVideo };
})();

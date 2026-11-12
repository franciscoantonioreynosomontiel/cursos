// ============================================================================
// limpieza · Edge Function de Supabase
// ----------------------------------------------------------------------------
// Administra los archivos de Cloudinary. Necesita la API secret, que NUNCA
// debe ir en el navegador, por eso vive aquí como secreto.
//
// Acciones (POST, JSON):
//   { "action": "delete", "public_id": "carpeta/archivo", "resource_type": "image" | "video" }
//   { "action": "cleanup" }   // borra los archivos que ya no usa la base de datos
//
// Secretos a configurar (Project Settings → Edge Functions → Secrets, o
// `supabase secrets set`):
//   CLOUDINARY_CLOUD_NAME   = dp776nphp
//   CLOUDINARY_API_KEY      = <tu api key>      (Cloudinary → Dashboard)
//   CLOUDINARY_API_SECRET   = <tu api secret>   (Cloudinary → Dashboard)
//   DELETE_TOKEN            = (opcional) token que debe enviar el frontend
//
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase solo.
// ============================================================================

const CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "";
const API_KEY = Deno.env.get("CLOUDINARY_API_KEY") ?? "";
const API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET") ?? "";
const DELETE_TOKEN = Deno.env.get("DELETE_TOKEN") ?? ""; // opcional

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MEDIA_TABLE = Deno.env.get("MEDIA_TABLE") ?? "task_media";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-delete-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Cloudinary firma con SHA-1 de los parámetros (orden alfabético) + api_secret.
async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Borra un archivo concreto de Cloudinary (firmado).
async function destroy(
  publicId: string,
  resourceType: string,
): Promise<{ result: string; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sha1Hex(
    `public_id=${publicId}&timestamp=${timestamp}${API_SECRET}`,
  );

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", API_KEY);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/destroy`,
    { method: "POST", body: form },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === "error") {
    return { result: "error", error: data?.error?.message ?? `HTTP ${res.status}` };
  }
  return { result: data.result }; // "ok" o "not found"
}

// Lista todos los archivos de Cloudinary de un tipo (con paginación).
async function listAll(resourceType: string): Promise<string[]> {
  const ids: string[] = [];
  const auth = btoa(`${API_KEY}:${API_SECRET}`);
  let cursor: string | undefined;

  do {
    const url = new URL(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/${resourceType}`,
    );
    url.searchParams.set("max_results", "500");
    if (cursor) url.searchParams.set("next_cursor", cursor);

    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Cloudinary respondió ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const r of data.resources ?? []) ids.push(String(r.public_id));
    cursor = data.next_cursor || undefined;
  } while (cursor);

  return ids;
}

// public_ids que la base de datos sigue usando.
async function usedPublicIds(): Promise<Set<string>> {
  const url = `${SUPABASE_URL}/rest/v1/${MEDIA_TABLE}?select=public_id`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`No se pudo leer ${MEDIA_TABLE}: ${res.status} ${detail.slice(0, 200)}`);
  }
  const rows: Array<{ public_id: string }> = await res.json();
  return new Set(rows.map((r) => String(r.public_id)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return json({ error: "Faltan los secretos de Cloudinary en esta función" }, 500);
  }
  if (DELETE_TOKEN && req.headers.get("x-delete-token") !== DELETE_TOKEN) {
    return json({ error: "Token de borrado inválido" }, 401);
  }

  let body: { action?: string; public_id?: string; resource_type?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const action = body.action ?? "delete";

  /* ------------------------------------------------------- borrar uno -- */
  if (action === "delete") {
    const publicId = String(body.public_id ?? "").trim();
    const resourceType = body.resource_type === "video" ? "video" : "image";
    if (!publicId) return json({ error: "Falta public_id" }, 400);

    const out = await destroy(publicId, resourceType);
    if (out.result === "error") {
      return json({ error: out.error ?? "Cloudinary rechazó el borrado" }, 502);
    }
    return json({ result: out.result, public_id: publicId });
  }

  /* ------------------------------------------ limpiar los huérfanos --- */
  if (action === "cleanup") {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json({ error: "Falta la configuración de Supabase" }, 500);
    }

    const used = await usedPublicIds();
    const [images, videos] = await Promise.all([listAll("image"), listAll("video")]);

    const orphans: Array<{ public_id: string; resource_type: string }> = [];
    for (const id of images) {
      if (!used.has(id)) orphans.push({ public_id: id, resource_type: "image" });
    }
    for (const id of videos) {
      if (!used.has(id)) orphans.push({ public_id: id, resource_type: "video" });
    }

    const failures: string[] = [];
    let deleted = 0;
    for (const o of orphans) {
      const out = await destroy(o.public_id, o.resource_type);
      if (out.result === "error") failures.push(`${o.public_id}: ${out.error}`);
      else deleted++;
    }

    return json({
      scanned: images.length + videos.length,
      orphans: orphans.length,
      deleted,
      failures,
    });
  }

  return json({ error: `Acción desconocida: ${action}` }, 400);
});

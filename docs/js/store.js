/* ============================================================================
 * store.js · Capa de datos
 * ----------------------------------------------------------------------------
 * Dos modos, elegidos automáticamente:
 *   - "supabase": si config.js tiene SUPABASE_URL y SUPABASE_ANON_KEY.
 *   - "local"   : si no, guarda todo en localStorage (modo demo).
 *
 * La interfaz solo habla con Store.*, así que no le importa de dónde
 * vienen los datos.
 * ==========================================================================*/

const Store = (() => {
  const cfg = window.APP_CONFIG || {};
  const LS_KEY = "task-tracker-db-v1";
  const T = cfg.TABLES || { TASKS: "tasks", MEDIA: "task_media", NOTES: "task_notes" };

  let client = null;
  let mode = "local";

  /* ------------------------------------------------------------ helpers -- */
  const uid = () =>
    "local-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const nowIso = () => new Date().toISOString();

  function readLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { tasks: [], media: [], notes: [] };
      const db = JSON.parse(raw);
      return {
        tasks: db.tasks || [],
        media: db.media || [],
        notes: db.notes || [],
      };
    } catch {
      return { tasks: [], media: [], notes: [] };
    }
  }

  function writeLocal(db) {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  }

  /* -------------------------------------------------------------- init --- */
  async function init() {
    const url = (cfg.SUPABASE_URL || "").trim();
    const key = (cfg.SUPABASE_ANON_KEY || "").trim();

    if (!url || !key) {
      mode = "local";
      return { mode, reason: "Falta configurar Supabase en config.js" };
    }

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      mode = "local";
      return { mode, reason: "No se pudo cargar la librería de Supabase (¿sin internet?)" };
    }

    try {
      client = window.supabase.createClient(url, key);
      mode = "supabase";
      return { mode, reason: "Conectado a Supabase" };
    } catch (err) {
      mode = "local";
      return { mode, reason: "Error al conectar con Supabase: " + err.message };
    }
  }

  const getMode = () => mode;

  /* ----------------------------------------------------- leer todo ------ */
  async function listAll() {
    if (mode === "supabase") {
      const [tasksRes, mediaRes, notesRes] = await Promise.all([
        client.from(T.TASKS).select("*").order("position", { ascending: true })
          .order("created_at", { ascending: true }),
        client.from(T.MEDIA).select("*").order("position", { ascending: true })
          .order("created_at", { ascending: true }),
        client.from(T.NOTES).select("*").order("created_at", { ascending: true }),
      ]);

      const err = tasksRes.error || mediaRes.error || notesRes.error;
      if (err) throw new Error(err.message);

      return {
        tasks: tasksRes.data || [],
        media: mediaRes.data || [],
        notes: notesRes.data || [],
      };
    }

    return readLocal();
  }

  /* ----------------------------------------------------- tasks ---------- */
  async function createTask(input) {
    const payload = {
      title: input.title,
      description: input.description || "",
      progress: clampProgress(input.progress),
      status_label: input.status_label || cfg.DEFAULT_STATUS_LABEL || "Sin empezar",
      is_done: clampProgress(input.progress) >= 100,
      is_updated: false,
      position: input.position ?? Date.now(),
    };

    if (mode === "supabase") {
      const { data, error } = await client.from(T.TASKS).insert(payload).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const db = readLocal();
    const row = { id: uid(), created_at: nowIso(), updated_at: nowIso(), ...payload };
    db.tasks.push(row);
    writeLocal(db);
    return row;
  }

  async function updateTask(id, patch) {
    const payload = { ...patch };
    if (payload.progress !== undefined) {
      payload.progress = clampProgress(payload.progress);
      payload.is_done = payload.progress >= 100;
    }

    if (mode === "supabase") {
      const { data, error } = await client.from(T.TASKS).update(payload)
        .eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const db = readLocal();
    const row = db.tasks.find((t) => t.id === id);
    if (!row) throw new Error("Tarea no encontrada");

    const changed = ["title", "description", "progress", "status_label", "is_done"]
      .some((k) => k in payload && payload[k] !== row[k]);

    Object.assign(row, payload);
    row.updated_at = nowIso();
    if (changed && payload.is_updated === undefined) row.is_updated = true;
    writeLocal(db);
    return row;
  }

  // Quita la etiqueta "Update" sin marcar la tarea como cambiada otra vez.
  async function markReviewed(id) {
    return updateTask(id, { is_updated: false });
  }

  async function deleteTask(id) {
    if (mode === "supabase") {
      const { error } = await client.from(T.TASKS).delete().eq("id", id);
      if (error) throw new Error(error.message);
      return;
    }
    const db = readLocal();
    db.tasks = db.tasks.filter((t) => t.id !== id);
    db.media = db.media.filter((m) => m.task_id !== id);
    db.notes = db.notes.filter((n) => n.task_id !== id);
    writeLocal(db);
  }

  /* ----------------------------------------------------- media ---------- */
  async function addMedia(taskId, { public_id, resource_type, format, bytes, caption }) {
    const payload = {
      task_id: taskId,
      public_id: String(public_id).trim(),
      resource_type: resource_type || "image",
      format: format || "",
      bytes: bytes || 0,
      caption: caption || "",
      position: Date.now(),
    };

    if (mode === "supabase") {
      const { data, error } = await client.from(T.MEDIA).insert(payload).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const db = readLocal();
    const row = { id: uid(), created_at: nowIso(), ...payload };
    db.media.push(row);
    writeLocal(db);
    return row;
  }

  async function updateMedia(id, patch) {
    const payload = {};
    if (patch.public_id !== undefined) payload.public_id = String(patch.public_id).trim();
    if (patch.resource_type !== undefined) payload.resource_type = patch.resource_type;
    if (patch.format !== undefined) payload.format = patch.format;
    if (patch.caption !== undefined) payload.caption = patch.caption;

    if (mode === "supabase") {
      const { data, error } = await client.from(T.MEDIA).update(payload)
        .eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const db = readLocal();
    const row = db.media.find((m) => m.id === id);
    if (!row) throw new Error("Archivo no encontrado");
    Object.assign(row, payload);
    writeLocal(db);
    return row;
  }

  async function deleteMedia(id) {
    if (mode === "supabase") {
      const { error } = await client.from(T.MEDIA).delete().eq("id", id);
      if (error) throw new Error(error.message);
      return;
    }
    const db = readLocal();
    db.media = db.media.filter((m) => m.id !== id);
    db.notes = db.notes.filter((n) => n.media_id !== id);
    writeLocal(db);
  }

  /* ----------------------------------------------------- notes ---------- */
  async function addNote({ task_id, media_id = null, body }) {
    const payload = { task_id, media_id, body: body.trim() };

    if (mode === "supabase") {
      const { data, error } = await client.from(T.NOTES).insert(payload).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const db = readLocal();
    const row = { id: uid(), created_at: nowIso(), ...payload };
    db.notes.push(row);
    writeLocal(db);
    return row;
  }

  async function deleteNote(id) {
    if (mode === "supabase") {
      const { error } = await client.from(T.NOTES).delete().eq("id", id);
      if (error) throw new Error(error.message);
      return;
    }
    const db = readLocal();
    db.notes = db.notes.filter((n) => n.id !== id);
    writeLocal(db);
  }

  /* ----------------------------------------------------- utilidades ----- */
  function clampProgress(value) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  return {
    init, getMode, listAll,
    createTask, updateTask, markReviewed, deleteTask,
    addMedia, updateMedia, deleteMedia,
    addNote, deleteNote,
    clampProgress,
  };
})();

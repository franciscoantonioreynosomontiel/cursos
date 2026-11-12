/* ============================================================================
 * app.js · Interfaz de seguimiento de funciones
 * ----------------------------------------------------------------------------
 * - Pinta la tabla, el carrusel de imágenes/video, las notas y el badge Update.
 * - Los archivos se suben a Cloudinary (js/cloudinary.js) y se piden con
 *   transformaciones para gastar el mínimo ancho de banda.
 * - Los datos (funciones, media, notas) se guardan vía Store (js/store.js).
 * ==========================================================================*/

(() => {
  const cfg = window.APP_CONFIG || {};
  const MAX_MB = Number(cfg.MAX_UPLOAD_MB) || 0;

  /* ------------------------------------------------------------- estado -- */
  const state = {
    tasks: [],
    media: [],
    notes: [],
    query: "",
    filter: "all",     // all | updated | pending | done
    sliderIndex: {},   // taskId -> índice visible del carrusel
    editing: null,     // función en edición (null = nueva)
    draftMedia: [],    // medios en el modal antes de guardar
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  /* ------------------------------------------------------------ helpers -- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));

  const isVideo = (item) => (item?.resource_type || "image") === "video";

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }) +
      " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  };

  const fmtBytes = (n) => {
    const b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  };

  const notesOf = (taskId, mediaId = null) =>
    state.notes.filter((n) => n.task_id === taskId && (n.media_id || null) === mediaId);

  const mediaOf = (taskId) =>
    state.media
      .filter((m) => m.task_id === taskId)
      .sort((a, b) => (a.position || 0) - (b.position || 0));

  /* ------------------------------------------------------------- toasts -- */
  function toast(message, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .25s, transform .25s";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => el.remove(), 260);
    }, 3000);
  }

  async function guard(action, okMessage) {
    try {
      const result = await action();
      if (okMessage) toast(okMessage, "ok");
      return result;
    } catch (err) {
      console.error(err);
      const msg = String(err.message || err);
      // Error típico cuando todavía no se ejecutó supabase/schema.sql.
      if (/schema cache|does not exist|relation .* does not exist/i.test(msg)) {
        toast("Faltan las tablas en Supabase. Ejecuta docs/supabase/schema.sql.", "error");
      } else {
        toast("Error: " + msg, "error");
      }
      return null;
    }
  }

  // Borra de Cloudinary los archivos indicados. Es "best effort": si algo
  // falla, no impide borrar la fila de la base de datos.
  async function purgeCloudinary(mediaRows) {
    const rows = mediaRows.filter((m) => m && m.public_id);
    if (!rows.length) return;

    if (!Cloudinary.canDelete()) {
      toast(
        "Se quitó de la tabla, pero el archivo sigue en Cloudinary " +
        "(falta configurar el borrado: ver README).",
        "warn",
      );
      return;
    }

    let failed = 0;
    for (const m of rows) {
      try {
        await Cloudinary.remove(m.public_id, m.resource_type);
      } catch (err) {
        console.error("No se pudo borrar en Cloudinary:", m.public_id, err);
        failed++;
      }
    }
    if (failed) {
      toast(`${failed} archivo(s) no se pudieron borrar en Cloudinary`, "warn");
    }
  }

  // Botón "Limpiar archivos": borra de Cloudinary lo que ya no usa la base de
  // datos (subidas canceladas, borrados que fallaron, etc.).
  async function runCleanup() {
    if (!Cloudinary.canDelete()) {
      toast(
        "La limpieza no está disponible: falta desplegar la Edge Function (ver README).",
        "warn",
      );
      return;
    }

    const btn = $("#btn-cleanup");
    if (btn.disabled) return;
    if (!confirm(
      "Se borrarán de Cloudinary los archivos que ya no están en la tabla.\n\n" +
      "No afecta a ninguna función ni nota. ¿Continuar?",
    )) return;

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Limpiando…";
    try {
      const r = await Cloudinary.cleanup();
      if (!r.orphans) {
        toast(`Todo limpio: ${r.scanned} archivo(s) revisados, ninguno sobra.`, "ok");
      } else {
        toast(`Limpieza: ${r.deleted} de ${r.orphans} archivo(s) huérfanos borrados.`, "ok");
      }
      if (r.failures && r.failures.length) {
        console.error("Fallos al limpiar:", r.failures);
        toast(`${r.failures.length} archivo(s) no se pudieron borrar (ver consola)`, "warn");
      }
    } catch (err) {
      console.error(err);
      toast("Error al limpiar: " + (err.message || err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  /* ---------------------------------------------------------- cargar ----- */
  async function loadData() {
    const db = await Store.listAll();
    state.tasks = db.tasks;
    state.media = db.media;
    state.notes = db.notes;
  }

  async function refresh() {
    await guard(loadData);
    render();
  }

  /* ---------------------------------------------------------- render ----- */
  function visibleTasks() {
    const q = state.query.trim().toLowerCase();

    return state.tasks
      .filter((t) => {
        if (!q) return true;
        const hay = `${t.title} ${t.description || ""} ${t.status_label || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .filter((t) => {
        if (state.filter === "updated") return t.is_updated;
        if (state.filter === "done") return t.is_done || t.progress >= 100;
        if (state.filter === "pending") return !t.is_done && t.progress < 100;
        return true;
      })
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  function render() {
    const tbody = $("#task-rows");
    const tasks = visibleTasks();
    const hasTasks = state.tasks.length > 0;

    $("#empty-state").classList.toggle("hidden", tasks.length > 0);
    if (!tasks.length) {
      $("#empty-title").textContent = hasTasks
        ? "Ninguna función coincide con el filtro"
        : "Todavía no hay funciones";
      $("#empty-text").textContent = hasTasks
        ? "Prueba con otro texto de búsqueda o cambia el filtro."
        : "Crea tu primera función para empezar a llevar el control de tu sistema.";
      tbody.innerHTML = "";
    } else {
      tbody.innerHTML = tasks.map(rowHtml).join("");
    }
  }

  function rowHtml(task) {
    const media = mediaOf(task.id);
    const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
    const done = task.is_done || progress >= 100;

    return `
      <tr data-id="${esc(task.id)}" class="${done ? "is-done" : ""}">
        <td class="cell-task">
          <div class="task-title">
            ${esc(task.title)}
            ${task.is_updated ? '<span class="badge update">Update</span>' : ""}
            ${done ? '<span class="badge done">Completado</span>' : ""}
          </div>
          ${task.description ? `<div class="task-desc">${esc(task.description)}</div>` : ""}
          <div class="meta-line">
            ${esc(task.status_label || cfg.DEFAULT_STATUS_LABEL || "Sin empezar")}
            · creado ${esc(fmtDate(task.created_at))}
            ${task.updated_at ? `· actualizado ${esc(fmtDate(task.updated_at))}` : ""}
          </div>
        </td>

        <td>
          <span class="progress-value">${progress}%</span>
        </td>

        <td>${sliderHtml(task.id, media)}</td>

        <td class="notes">${notesHtml(task.id, null, "Función")}</td>

        <td class="cell-actions">
          <div class="stack">
            <div class="inline">
              <button class="tiny" data-action="edit" data-id="${esc(task.id)}">Editar</button>
              ${task.is_updated
                ? `<button class="tiny ghost" data-action="review" data-id="${esc(task.id)}">Revisado</button>`
                : ""}
            </div>
            <div class="inline">
              <button class="tiny ghost" data-action="bump" data-id="${esc(task.id)}">+10%</button>
              <button class="tiny danger" data-action="delete" data-id="${esc(task.id)}">Borrar</button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  /* ---------------------------------------------------------- slider ----- */
  function sliderHtml(taskId, media) {
    if (!media.length) {
      return `
        <div class="slider" data-slider="${esc(taskId)}">
          <div class="slider-frame">
            <div class="slider-empty">Sin vista<br>
              <span style="font-size:11px">Añádela con "Editar"</span></div>
          </div>
        </div>`;
    }

    const idx = Math.min(state.sliderIndex[taskId] || 0, media.length - 1);
    const current = media[idx];

    const nav = media.length > 1
      ? `<button class="slider-nav prev" data-action="slide" data-id="${esc(taskId)}" data-dir="-1" title="Anterior">&#8249;</button>
         <button class="slider-nav next" data-action="slide" data-id="${esc(taskId)}" data-dir="1" title="Siguiente">&#8250;</button>
         <span class="slider-counter">${idx + 1}/${media.length}</span>`
      : "";

    const dots = media.length > 1
      ? `<div class="slider-dots">
           ${media.map((_, i) => `<button class="${i === idx ? "active" : ""}"
              data-action="slide-to" data-id="${esc(taskId)}" data-index="${i}" title="Ir a ${i + 1}"></button>`).join("")}
         </div>`
      : "";

    const caption = current.caption
      ? `<div class="slider-caption">${esc(current.caption)}</div>`
      : `<div class="slider-caption">${esc(current.format ? current.format.toUpperCase() : "")}</div>`;

    return `
      <div class="slider" data-slider="${esc(taskId)}">
        <div class="slider-frame">${mediaFrame(current)}${nav}</div>
        ${caption}
        ${dots}
        ${notesHtml(taskId, current.id, "Archivo " + (idx + 1))}
      </div>`;
  }

  // Imagen o video con URLs ya optimizadas.
  function mediaFrame(item) {
    if (isVideo(item)) {
      const src = Cloudinary.fullUrl(item);
      const poster = Cloudinary.posterUrl(item);
      return `<video src="${esc(src)}"${poster ? ` poster="${esc(poster)}"` : ""}
                controls preload="none" data-media-id="${esc(item.id)}"></video>`;
    }
    const src = Cloudinary.fullUrl(item);
    return `<img src="${esc(src)}" alt="${esc(item.caption || "")}"
              loading="lazy" data-media-id="${esc(item.id)}">`;
  }

  /* ---------------------------------------------------------- notas ------ */
  function notesHtml(taskId, mediaId, tag) {
    const list = notesOf(taskId, mediaId);
    const mediaAttr = mediaId ? ` data-media="${esc(mediaId)}"` : "";

    return `
      <div class="notes-block" data-notes-for="${esc(taskId)}"${mediaAttr}>
        <div class="notes-list">
          ${list.map((n) => `
            <div class="note ${n.media_id ? "media-note" : ""}">
              <div class="note-body">${esc(n.body)}</div>
              <div class="note-foot">
                <span>
                  <span class="note-tag">${esc(mediaId ? tag : "Función")}</span>
                  ${esc(fmtDate(n.created_at))}
                </span>
                <button class="tiny ghost" data-action="del-note" data-id="${esc(n.id)}">✕</button>
              </div>
            </div>`).join("") || `<div class="meta-line">Sin notas.</div>`}
        </div>
        <div class="note-add">
          <textarea placeholder="Escribe una nota…" data-note-input${mediaAttr}></textarea>
          <div class="note-add-actions">
            <button class="tiny primary" data-action="add-note" data-id="${esc(taskId)}"${mediaAttr}>Añadir nota</button>
          </div>
        </div>
      </div>`;
  }

  /* ----------------------------------------------------- modal función --- */
  function openTaskModal(taskId = null) {
    const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
    state.editing = task || null;

    if (task) {
      state.draftMedia = mediaOf(task.id).map((m) => ({
        id: m.id,
        public_id: m.public_id,
        resource_type: m.resource_type || "image",
        format: m.format || "",
        bytes: m.bytes || 0,
        caption: m.caption || "",
        _existing: true,
        _status: "saved",
      }));
    } else {
      state.draftMedia = [];
    }

    $("#modal-title").textContent = task ? "Editar función" : "Nueva función";
    $("#field-title").value = task ? task.title : "";
    $("#field-desc").value = task ? task.description || "" : "";
    $("#field-progress").value = task ? task.progress : 0;
    $("#field-progress-value").textContent = $("#field-progress").value + "%";
    $("#field-status").value = task ? task.status_label || "" : (cfg.DEFAULT_STATUS_LABEL || "Sin empezar");
    $("#btn-delete-task").classList.toggle("hidden", !task);

    renderMediaEditor();
    $("#modal-backdrop").classList.remove("hidden");
    $("#field-title").focus();
  }

  function closeTaskModal({ discardUploads = true } = {}) {
    // Si se cancela, los archivos subidos pero no guardados se borran de
    // Cloudinary para no dejarlos huérfanos.
    if (discardUploads) {
      const orphans = state.draftMedia.filter((m) => !m._existing && m.public_id);
      purgeCloudinary(orphans);
    }
    $("#modal-backdrop").classList.add("hidden");
    state.editing = null;
    state.draftMedia = [];
  }

  function renderMediaEditor() {
    const box = $("#media-editor");
    const hint = $(".dropzone-hint");
    const cloudOk = Cloudinary.configured();

    if (hint) hint.classList.toggle("hidden", state.draftMedia.length > 0);

    if (!cloudOk) {
      box.innerHTML = `<div class="meta-line" style="margin-bottom:10px;color:var(--warn)">
        Cloudinary no está configurado en config.js: no se podrán subir archivos.</div>`;
      return;
    } else if (!state.draftMedia.length) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML = state.draftMedia.map((m, i) => {
      const pending = m._status === "uploading";
      const failed = m._status === "error";

      const preview = m.public_id
        ? (isVideo(m)
            ? `<img src="${esc(Cloudinary.thumbUrl(m))}" alt="" loading="lazy">`
            : `<img src="${esc(Cloudinary.thumbUrl(m))}" alt="" loading="lazy">`)
        : "…";

      const badge = pending
        ? `<span class="badge pending">Subiendo ${m._progress || 0}%</span>`
        : failed
          ? `<span class="badge update">Error al subir</span>`
          : `<span class="badge done">${esc(isVideo(m) ? "Video" : "Imagen")}${m.bytes ? " · " + esc(fmtBytes(m.bytes)) : ""}</span>`;

      return `
        <div class="media-row" data-media-row="${i}">
          <div class="preview">${preview}</div>
          <div class="fields">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${badge}
              <span class="meta-line" style="margin:0">${esc(m.public_id || "subiendo…")}</span>
            </div>
            <input type="text" placeholder="Texto bajo la imagen/video (opcional)"
              value="${esc(m.caption)}" data-media-field="caption" data-index="${i}">
          </div>
          <button class="tiny danger" data-action="remove-draft-media" data-index="${i}" title="Quitar">✕</button>
        </div>`;
    }).join("");
  }

  /* ------------------------------------------------- subir archivos ------ */
  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      if (MAX_MB && file.size > MAX_MB * 1024 * 1024) {
        toast(`"${file.name}" supera el límite de ${MAX_MB} MB`, "warn");
        continue;
      }

      const idx = state.draftMedia.length;
      state.draftMedia.push({
        id: null,
        public_id: "",
        resource_type: file.type.startsWith("video/") ? "video" : "image",
        format: "",
        bytes: 0,
        caption: "",
        _existing: false,
        _status: "uploading",
        _progress: 0,
      });
      renderMediaEditor();

      const row = $(`[data-media-row="${idx}"]`);
      const setProgress = (p) => {
        state.draftMedia[idx]._progress = p;
        const badge = row && $(".badge", row);
        if (badge) badge.textContent = `Subiendo ${p}%`;
      };

      try {
        const res = await Cloudinary.upload(file, setProgress);
        Object.assign(state.draftMedia[idx], {
          public_id: res.public_id,
          resource_type: res.resource_type,
          format: res.format,
          bytes: res.bytes,
          _status: "ready",
        });
      } catch (err) {
        console.error(err);
        state.draftMedia[idx]._status = "error";
        toast(`No se pudo subir "${file.name}": ${err.message}`, "error");
      }
      renderMediaEditor();
    }
  }

  /* ------------------------------------------------------ guardar ------- */
  async function saveTask() {
    const title = $("#field-title").value.trim();
    if (!title) {
      toast("El título es obligatorio", "warn");
      $("#field-title").focus();
      return;
    }

    if (state.draftMedia.some((m) => m._status === "uploading")) {
      toast("Espera a que terminen las subidas", "warn");
      return;
    }

    const payload = {
      title,
      description: $("#field-desc").value.trim(),
      progress: Store.clampProgress($("#field-progress").value),
      status_label: $("#field-status").value.trim() || (cfg.DEFAULT_STATUS_LABEL || "Sin empezar"),
    };

    const mediaToSave = state.draftMedia.filter((m) => m.public_id);
    const editingId = state.editing?.id || null;

    await guard(async () => {
      let taskId = editingId;

      if (editingId) {
        await Store.updateTask(editingId, payload);
      } else {
        const created = await Store.createTask({ ...payload, position: Date.now() });
        taskId = created.id;
      }

      const existing = state.media.filter((m) => m.task_id === taskId);
      const keptIds = new Set(mediaToSave.filter((m) => m._existing).map((m) => m.id));

      const removed = existing.filter((old) => !keptIds.has(old.id));
      for (const old of removed) await Store.deleteMedia(old.id);

      for (const m of mediaToSave) {
        if (!m._existing) {
          await Store.addMedia(taskId, {
            public_id: m.public_id,
            resource_type: m.resource_type,
            format: m.format,
            bytes: m.bytes,
            caption: m.caption,
          });
        } else {
          const prev = existing.find((e) => e.id === m.id);
          if (prev && (prev.caption || "") !== m.caption) {
            await Store.updateMedia(m.id, { caption: m.caption });
          }
        }
      }

      // Los archivos quitados también se borran de Cloudinary.
      await purgeCloudinary(removed);
    }, editingId ? "Función actualizada" : "Función creada");

    // Ya están guardados: no hay que borrarlos al cerrar.
    closeTaskModal({ discardUploads: false });
    await refresh();
  }

  /* -------------------------------------------------------- eventos ------ */
  function bindEvents() {
    $("#btn-new").addEventListener("click", () => openTaskModal(null));
    $("#btn-refresh").addEventListener("click", () => refresh().then(() => toast("Datos actualizados")));
    $("#btn-cleanup").addEventListener("click", runCleanup);

    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      render();
    });

    $("#filter").addEventListener("change", (e) => {
      state.filter = e.target.value;
      render();
    });

    // Delegación: tabla
    $("#task-rows").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "edit") return openTaskModal(id);

      if (action === "review") {
        await guard(() => Store.markReviewed(id), "Marcada como revisada");
        return refresh();
      }

      if (action === "delete") {
        const task = state.tasks.find((t) => t.id === id);
        if (!confirm(`¿Borrar la función "${task?.title || ""}"? Se borrarán también sus archivos en Cloudinary. Esta acción no se puede deshacer.`)) return;
        const media = mediaOf(id);
        await guard(() => Store.deleteTask(id), "Función borrada");
        await purgeCloudinary(media);
        return refresh();
      }

      if (action === "bump") {
        const task = state.tasks.find((t) => t.id === id);
        const next = Math.min(100, (Number(task?.progress) || 0) + 10);
        await guard(() => Store.updateTask(id, { progress: next }), `Progreso: ${next}%`);
        return refresh();
      }

      if (action === "slide" || action === "slide-to") {
        const media = mediaOf(id);
        if (!media.length) return;
        let idx = state.sliderIndex[id] || 0;
        if (action === "slide") {
          idx = (idx + Number(btn.dataset.dir) + media.length) % media.length;
        } else {
          idx = Number(btn.dataset.index);
        }
        state.sliderIndex[id] = idx;
        render();
        return;
      }

      if (action === "del-note") {
        if (!confirm("¿Borrar esta nota?")) return;
        await guard(() => Store.deleteNote(id), "Nota borrada");
        return refresh();
      }

      if (action === "add-note") {
        const block = btn.closest(".notes-block");
        const input = $("[data-note-input]", block);
        const body = input.value.trim();
        if (!body) { input.focus(); return; }
        const mediaId = btn.dataset.media || null;
        await guard(() => Store.addNote({ task_id: id, media_id: mediaId, body }), "Nota añadida");
        return refresh();
      }
    });

    // Modal: abrir/cerrar
    $("#btn-cancel").addEventListener("click", closeTaskModal);
    $("#modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") closeTaskModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) closeTaskModal();
    });

    // Modal: guardar / borrar
    $("#btn-save").addEventListener("click", saveTask);

    $("#btn-delete-task").addEventListener("click", async () => {
      const id = state.editing?.id;
      if (!id) return;
      if (!confirm("¿Borrar esta función y todo su contenido? También se borrarán sus archivos en Cloudinary.")) return;
      const media = mediaOf(id);
      await guard(() => Store.deleteTask(id), "Función borrada");
      closeTaskModal();
      await purgeCloudinary(media);
      await refresh();
    });

    // Modal: subir archivos (zona de drag & drop + clic para elegir)
    const fileInput = $("#media-file-input");
    const dropZone = $("#media-dropzone");

    dropZone.addEventListener("click", (e) => {
      // No abrir el selector si el clic es sobre un archivo ya listado.
      if (e.target.closest("#media-editor")) return;
      fileInput.click();
    });
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", async (e) => {
      await uploadFiles(e.target.files);
      fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      }));
    ["dragleave", "drop"].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
      }));
    dropZone.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

    // Modal: barra de progreso -> refleja el número
    $("#field-progress").addEventListener("input", (e) => {
      $("#field-progress-value").textContent = e.target.value + "%";
    });

    // Modal: editar caption / quitar
    $("#media-editor").addEventListener("input", (e) => {
      const field = e.target.dataset.mediaField;
      if (!field) return;
      const i = Number(e.target.dataset.index);
      state.draftMedia[i][field] = e.target.value;
    });

    $("#media-editor").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='remove-draft-media']");
      if (!btn) return;
      const i = Number(btn.dataset.index);
      const m = state.draftMedia[i];
      // Si es un archivo recién subido y aún sin guardar, se borra ya de
      // Cloudinary. Los que ya estaban guardados se borran al pulsar Guardar.
      if (m && !m._existing && m.public_id) purgeCloudinary([m]);
      state.draftMedia.splice(i, 1);
      renderMediaEditor();
    });
  }

  /* ------------------------------------------------------------ inicio --- */
  async function boot() {
    const info = await Store.init();

    if (info.mode === "local") {
      $("#demo-banner").classList.remove("hidden");
      $("#demo-banner-text").textContent =
        "Modo demo (datos en este navegador). " + info.reason +
        " Para guardar en la nube, revisa docs/config.js y ejecuta docs/supabase/schema.sql.";
    } else if (!Cloudinary.configured()) {
      $("#demo-banner").classList.remove("hidden");
      $("#demo-banner-text").textContent =
        "Supabase conectado, pero Cloudinary no está configurado: no se podrán subir archivos.";
    }

    bindEvents();
    await refresh();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

-- ============================================================================
--  Proyecto: Seguimiento de tareas (docs/)
--  Motor: PostgreSQL / Supabase
-- ----------------------------------------------------------------------------
--  Cómo usarlo:
--    1. Entra a tu proyecto en https://supabase.com
--    2. Menú lateral -> SQL Editor -> New query
--    3. Pega TODO este archivo y pulsa "Run"
--
--  Modelo de datos:
--    tasks       -> una fila por tarea (título, descripción, % completado, ...)
--    task_media  -> imágenes/videos asociados a una tarea (para el slider)
--    task_notes  -> notas/comentarios sobre una tarea o sobre una imagen
--
--  Sobre "Update":
--    Cuando editas una tarea, un trigger marca is_updated = true y guarda
--    la fecha en updated_at. La interfaz muestra la etiqueta "Update".
--    Tú la quitas manualmente con el botón "Marcar como revisado".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensión para generar UUIDs
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ============================================================================
-- TABLA: tasks
-- ============================================================================
create table if not exists public.tasks (
    id              uuid primary key default gen_random_uuid(),
    title           text        not null,
    description     text,
    progress        smallint    not null default 0
                    check (progress >= 0 and progress <= 100),
    status_label    text        not null default 'Sin empezar',
    is_updated      boolean     not null default false,
    is_done         boolean     not null default false,
    position        integer     not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table  public.tasks is 'Tareas del sistema que se están desarrollando';
comment on column public.tasks.progress    is 'Porcentaje de completado (0-100)';
comment on column public.tasks.is_updated  is 'true = hubo cambios nuevos -> etiqueta Update';
comment on column public.tasks.position    is 'Orden manual de las filas en la tabla';

-- ============================================================================
-- TABLA: task_media  (imágenes y videos alojados en Cloudinary)
-- ============================================================================
create table if not exists public.task_media (
    id              uuid primary key default gen_random_uuid(),
    task_id         uuid        not null references public.tasks(id) on delete cascade,
    public_id       text        not null,  -- id del archivo en Cloudinary
    resource_type   text        not null default 'image'
                    check (resource_type in ('image', 'video')),
    format          text,                   -- jpg, png, mp4, webm...
    bytes           bigint,                 -- tamaño original (informativo)
    caption         text,                   -- texto bajo la imagen/video
    position        integer     not null default 0,
    created_at      timestamptz not null default now()
);

comment on table  public.task_media is 'Imágenes y videos de Cloudinary asociados a una tarea';
comment on column public.task_media.public_id     is 'public_id devuelto por Cloudinary';
comment on column public.task_media.resource_type is 'image | video';
comment on column public.task_media.bytes         is 'Peso original del archivo en bytes';

create index if not exists task_media_task_id_idx on public.task_media(task_id);

-- ============================================================================
-- TABLA: task_notes  (notas / comentarios)
-- ============================================================================
create table if not exists public.task_notes (
    id              uuid primary key default gen_random_uuid(),
    task_id         uuid        not null references public.tasks(id) on delete cascade,
    media_id        uuid        references public.task_media(id) on delete cascade,
    body            text        not null,
    created_at      timestamptz not null default now()
);

comment on table  public.task_notes is 'Notas sobre una tarea o sobre una imagen/video concreta';
comment on column public.task_notes.media_id is 'Si es null, la nota es de la tarea; si no, es de esa imagen';

create index if not exists task_notes_task_id_idx  on public.task_notes(task_id);
create index if not exists task_notes_media_id_idx on public.task_notes(media_id);

-- ============================================================================
-- TRIGGER: mantener updated_at y encender la etiqueta Update
-- ============================================================================
create or replace function public.touch_task()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();

    -- Si cambió algo relevante (no solo "marcar como revisado"),
    -- encendemos la etiqueta Update.
    if (new.title       is distinct from old.title)
       or (new.description is distinct from old.description)
       or (new.progress  is distinct from old.progress)
       or (new.status_label is distinct from old.status_label)
       or (new.is_done   is distinct from old.is_done) then
        new.is_updated := true;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_tasks_touch on public.tasks;
create trigger trg_tasks_touch
    before update on public.tasks
    for each row
    execute function public.touch_task();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Ajusta esto según tu caso:
--   * Un solo desarrollador -> políticas abiertas (las de abajo).
--   * Varios usuarios       -> cambia "using (true)" por "using (auth.uid() = user_id)"
--                             y añade la columna user_id a cada tabla.
-- ============================================================================
alter table public.tasks      enable row level security;
alter table public.task_media enable row level security;
alter table public.task_notes enable row level security;

-- tasks -------------------------------------------------------------------
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
    for select using (true);

drop policy if exists "tasks_insert" on public.tasks;
create policy "tasks_insert" on public.tasks
    for insert with check (true);

drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
    for update using (true) with check (true);

drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
    for delete using (true);

-- task_media --------------------------------------------------------------
drop policy if exists "media_select" on public.task_media;
create policy "media_select" on public.task_media
    for select using (true);

drop policy if exists "media_insert" on public.task_media;
create policy "media_insert" on public.task_media
    for insert with check (true);

drop policy if exists "media_update" on public.task_media;
create policy "media_update" on public.task_media
    for update using (true) with check (true);

drop policy if exists "media_delete" on public.task_media;
create policy "media_delete" on public.task_media
    for delete using (true);

-- task_notes --------------------------------------------------------------
drop policy if exists "notes_select" on public.task_notes;
create policy "notes_select" on public.task_notes
    for select using (true);

drop policy if exists "notes_insert" on public.task_notes;
create policy "notes_insert" on public.task_notes
    for insert with check (true);

drop policy if exists "notes_update" on public.task_notes;
create policy "notes_update" on public.task_notes
    for update using (true) with check (true);

drop policy if exists "notes_delete" on public.task_notes;
create policy "notes_delete" on public.task_notes
    for delete using (true);

-- ============================================================================
-- DATOS DE EJEMPLO (opcional)
-- ----------------------------------------------------------------------------
-- Descomenta para tener una tarea lista y ver la interfaz con contenido.
-- Reemplaza los public_id por los de tus archivos ya subidos a Cloudinary
-- (los ves en el panel de Cloudinary, columna "Public ID").
-- ============================================================================
/*
with nueva as (
    insert into public.tasks (title, description, progress, status_label, position)
    values ('Módulo de login', 'Formulario, validación y sesión con Supabase.',
            60, 'En progreso', 1)
    returning id
)
insert into public.task_media (task_id, public_id, resource_type, format, caption, position)
select id, 'muestras/login', 'image', 'png', 'Pantalla de login terminada', 1 from nueva
union all
select id, 'muestras/dashboard', 'video', 'mp4', 'Recorrido del dashboard', 2 from nueva;
*/

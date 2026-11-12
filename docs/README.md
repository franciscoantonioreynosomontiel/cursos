# Seguimiento de tareas · mi sistema

Interfaz web (HTML + CSS + JS) para llevar el control de lo que vas
desarrollando. Cada tarea tiene descripción, porcentaje de completado, un
carrusel de imágenes/videos y notas. Cuando editas algo, la fila muestra la
etiqueta **Update** hasta que la marcas como revisada.

- **Datos** (tareas, media, notas): Supabase.
- **Archivos** (imágenes y videos): Cloudinary, servidos con transformaciones
  para gastar el mínimo ancho de banda.

## Estructura

```
docs/
├── index.html            Interfaz principal
├── config.js             Credenciales de Supabase y Cloudinary
├── css/styles.css        Estilos
├── js/
│   ├── store.js          Datos: Supabase (o modo demo local)
│   ├── cloudinary.js     Subida y URLs optimizadas de archivos
│   └── app.js            Lógica de la interfaz
├── supabase/
│   ├── schema.sql        Tablas + RLS + triggers para Supabase
│   └── functions/        Edge Functions (TypeScript), una carpeta por función
│       └── limpieza/     Borra y limpia archivos en Cloudinary
└── README.md
```

## Puesta en marcha

### 1. Crear las tablas en Supabase

1. Entra a tu proyecto en <https://supabase.com>.
2. **SQL Editor → New query**, pega `supabase/schema.sql` y pulsa **Run**.
   Crea las tablas `tasks`, `task_media` y `task_notes`, con sus políticas
   de acceso y el trigger que enciende la etiqueta *Update*.

### 2. Revisar `config.js`

Ya viene con tus credenciales. Si cambias de proyecto, actualiza:

```js
SUPABASE_URL, SUPABASE_ANON_KEY,          // base de datos
CLOUDINARY: { CLOUD_NAME, UPLOAD_PRESET } // archivos
```

> Si dejas Supabase vacío, la app arranca en **modo demo** (guarda en el
> navegador). Cloudinary sí necesita estar configurado para subir archivos.

### 3. Abrir la interfaz

```bash
cd docs
python3 -m http.server 8000
# abre http://localhost:8000
```

## Cómo se usan las imágenes y los videos

Ya no se guardan archivos en el repo. En el modal de la tarea:

1. Pulsa **+ Subir archivo** o **arrastra** las imágenes/videos.
2. Cada archivo se sube a Cloudinary y aparece una miniatura con su peso.
3. Escribe el texto que quieras bajo cada uno (opcional).
4. **Guardar**.

El carrusel de la tabla pide los archivos ya optimizados:

| Elemento | Transformación | Efecto |
|---|---|---|
| Imagen | `f_auto,q_auto,c_limit,w_900` | WebP/AVIF, calidad y ancho automáticos |
| Video | `q_auto,c_limit,w_960` | Recomprimido y limitado a 960px |
| Poster del video | `so_0,q_auto,c_fill,w_480` | Fotograma inicial (no descarga el video hasta dar play) |
| Miniatura | `c_fill,w_140,h_100` | Vista previa ligera en el editor |

Los videos usan `preload="none"` + poster, así **no se descargan hasta que
el usuario le da play**. Las imágenes usan `loading="lazy"`.

Puedes ajustar todas las transformaciones en `config.js` → `MEDIA_TRANSFORMS`.

## Borrar archivos (también en Cloudinary)

Cuando quitas un archivo o borras una tarea, el archivo se elimina también de
Cloudinary. Esto **no se puede hacer desde el navegador**, porque Cloudinary
exige la *API secret*. Por eso hay una **Edge Function** de Supabase
(`supabase/functions/limpieza`) que guarda ese secreto y expone un endpoint
de borrado.

### Activarlo (una sola vez)

1. **Instala la CLI de Supabase** y entra a tu proyecto:

   ```bash
   npm install -g supabase
   supabase login
   supabase link --project-ref qqjhadwxboeichxtxree
   ```

2. **Guarda los secretos** (los encuentras en Cloudinary → Dashboard). El
   `cloud_name` ya lo sabes; la *API key* y el *API secret* son los que
   aparecen junto a él:

   ```bash
   supabase secrets set \
     CLOUDINARY_CLOUD_NAME=dp776nphp \
     CLOUDINARY_API_KEY=tu_api_key \
     CLOUDINARY_API_SECRET=tu_api_secret
   ```

3. **Despliega la función**:

   ```bash
   supabase functions deploy limpieza
   ```

   (Por defecto la función es invocable con la `anon key`, la misma que ya usa
   la app. Opcionalmente puedes definir un `DELETE_TOKEN` y ponerlo también en
   `config.js` → `CLOUDINARY.DELETE_TOKEN` para exigir un token extra.)

#### Añadir más funciones TypeScript

Todas las Edge Functions viven en `supabase/functions/`, **una carpeta por
función** con su `index.ts` (así lo exige Supabase):

```
supabase/functions/
├── limpieza/       index.ts   ← borra y limpia archivos en Cloudinary
└── otra-funcion/   index.ts   ← cuando haga falta
```

Para crear una nueva: crea la carpeta con su `index.ts`, y despliégala con
`supabase functions deploy <carpeta>`. Los secretos que definas con
`supabase secrets set` quedan disponibles para todas las funciones.

> Si **no** activas esto, la app sigue funcionando: al quitar un archivo te
> avisa de que se quitó de la tabla pero que el archivo sigue en Cloudinary.

### Cuándo se borra

| Acción | Qué pasa en Cloudinary |
|---|---|
| Quitar un archivo recién subido (✕ en el modal) | Se borra al instante |
| Quitar un archivo ya guardado y pulsar **Guardar** | Se borra al guardar |
| Borrar una tarea (botón **Borrar**) | Se borran todos sus archivos |
| Cancelar el modal con archivos sin guardar | Se borran (evita huérfanos) |

### Botón "Limpiar archivos" 🧹

En la cabecera hay un botón para mantener Cloudinary ordenado. Al pulsarlo, la
Edge Function:

1. Lista **todos** los archivos de tu cuenta de Cloudinary.
2. Lee qué `public_id` siguen usados en la tabla `task_media`.
3. Borra los que ya no usa nadie (subidas canceladas, borrados que fallaron,
   archivos subidos a mano…).

Antes de borrar pide confirmación, y al terminar te dice cuántos revisó y
cuántos borró. No toca ninguna tarea ni nota: solo elimina archivos huérfanos.

> Úsalo cuando quieras; no borra nada que esté en uso. Si prefieres control
> total, no lo pulses y los huérfanos se quedarán ahí.

## Cómo funciona la etiqueta "Update"

- Al editar título, descripción, progreso, estado o marcar como completada,
  el trigger marca `is_updated = true` automáticamente.
- La fila muestra el badge morado **Update**.
- Pulsa **Revisado** para quitarla (no vuelve a activarse sola).

## Seguridad

- La `anon key` de Supabase y el preset de Cloudinary son públicos por diseño
  (van en el navegador). El control real lo hace:
  - el **RLS** de Supabase (ver `supabase/schema.sql`), y
  - las **restricciones del preset** de Cloudinary (tamaño, formatos, carpeta).
- La **API secret de Cloudinary nunca se pone en el navegador**: vive solo como
  secreto de la Edge Function (`supabase secrets set`).
- Si usas esto con varias personas, cambia en `schema.sql` las políticas
  `using (true)` por `using (auth.uid() = user_id)` y añade `user_id` a cada tabla.
- Recomendado: en Cloudinary, limita el preset a formatos imagen/video y a un
  tamaño máximo para evitar subidas no deseadas.

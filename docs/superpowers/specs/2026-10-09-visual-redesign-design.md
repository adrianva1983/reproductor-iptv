# Mejora de diseño visual: acento cálido + grupos plegables

## Problema

La interfaz actual (`www/css/index.css`) es funcional pero plana: fondo oscuro liso, acento azul genérico, y la biblioteca de canales muestra todos los grupos abiertos de golpe. Con listas grandes (441 canales en la lista de prueba, grupos de hasta 16+ canales) esto obliga a desplazarse mucho para encontrar algo.

Validado con mockups reales en el companion visual de brainstorming (no solo descripciones): el usuario eligió un acento cálido en degradado sobre el fondo oscuro actual, y pidió explícitamente que los grupos de canales se puedan plegar/desplegar.

## Alcance

- Nueva paleta de acento (degradado rojo→naranja) aplicada consistentemente en toda la app: biblioteca, reproductor, menú "Enviar a TV" y banner de Cast/DLNA ya existentes. El resto de la paleta (fondos, texto, tarjetas) no cambia.
- Los grupos de canales (incluido "Favoritos") pasan a ser secciones plegables con cabecera tocable y chevron, colapsadas por defecto salvo el primer grupo.
- Al buscar un canal, los grupos que tengan coincidencias se abren automáticamente (si no, habría que abrir cada grupo a mano mientras se busca).

No cubre:

- Cambios de estructura más allá de plegar/desplegar (se descartó la variante de cuadrícula tipo mosaico que también se mostró en los mockups).
- Persistencia de qué grupos están abiertos entre sesiones — se reinicia siempre al abrir la app.
- Cambios al modelo de datos, parser M3U o almacenamiento: es puramente visual/interacción en la capa de renderizado ya existente.

## Diseño visual

Variable de acento nueva en `:root` (sustituye a `--accent: #3d8bfd`): un degradado `linear-gradient(90deg, #ff3d6e, #ff8a3d)`, usado como:
- Color de título de sección ("Canales") vía `background-clip: text`.
- Franja lateral (`border-left`) + fondo tenue en el canal activo/favorito dentro de un grupo.
- Fondo de `button.primary` y de los elementos interactivos del reproductor (icono "Enviar a TV", botón "Dejar de enviar").

Como un `linear-gradient` no sirve directamente como valor de `border`/`background` de botón sólido vía una sola variable CSS, se definen dos variables: `--accent-start: #ff3d6e` y `--accent-end: #ff8a3d`, más `--accent-gradient: linear-gradient(90deg, var(--accent-start), var(--accent-end))` para los casos que sí aceptan un gradiente (texto, franjas). Los botones sólidos (`button.primary`) usan `--accent-start` como color de fondo plano (un degradado en un botón pequeño no se nota y complica el estado `:active`/`:hover`).

## Grupos plegables

Cada grupo renderizado por `section(title, channels)` en `www/js/index.js` pasa a tener:
- Una cabecera (`<button>`, no `<h2>` suelto, para que sea accesible/tocable) con el título + contador y un chevron (`▾`) que rota al abrir/cerrar.
- Un contenedor `<ul class="channels">` que se oculta (`hidden`) cuando el grupo está colapsado.

Estado de apertura: un `Set` de nombres de grupo en memoria (no en `state` persistido ni en `localStorage`), inicializado con solo el primer grupo abierto cada vez que se llama a `renderLibrary()`. Al escribir en el campo de búsqueda, antes de renderizar se añaden al `Set` todos los grupos que tengan al menos un canal coincidente, para que aparezcan ya abiertos.

## Cambios de código

- `www/css/index.css`: variables de acento nuevas; estilos de `.grp-head` (cabecera plegable), `.chevron`, ajuste de `.channel` activo/favorito con la franja del degradado; `button.primary` y los botones del reproductor pasan a usar `--accent-start`.
- `www/js/index.js`:
  - Nuevo estado en memoria (no en `state`, ver arriba) para los grupos abiertos.
  - `section(title, channels)`: añade la cabecera plegable con su manejador de click (toggle del grupo en el `Set` + re-render de la lista, o simplemente alternar `hidden` sin re-renderizar todo — más barato, se decide en la fase de plan).
  - `renderLibrary()`: al construir `visible` con un `state.query` activo, calcula qué grupos tienen coincidencias y los añade al `Set` de abiertos antes de pintar.
- No se toca `m3u.js`, `storage.js`, `player.js` ni ningún plugin nativo.

## Testing

No es testeable con el runner de Node (es visual/interacción de UI). Validación manual en el dispositivo ya usado en esta sesión:

1. Abrir la biblioteca con una lista grande — confirmar que solo el primer grupo aparece abierto.
2. Tocar la cabecera de un grupo cerrado — se abre; tocarla de nuevo — se cierra.
3. Escribir algo en "Buscar canal" que solo coincida con canales de un grupo cerrado — confirmar que ese grupo se abre solo.
4. Revisar visualmente el nuevo acento en: lista de canales, reproductor, menú "Enviar a TV", banner "Reproduciendo en X".

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

Un plugin de Claude Code que delega trabajo a **Google Antigravity CLI (`agy`)** y trae de vuelta los resultados, igual que el plugin de Codex. agy ejecuta Gemini (además de los modelos Claude y GPT-OSS que aloja) y cuenta con Google Search, generación de imágenes y una ventana de contexto muy grande. Eso lo convierte en un buen segundo agente para Claude.

## Instalación

```bash
claude plugin marketplace add MrJasonZhou/claude-code-antigravity
claude plugin install agy@agy-plugin
```

Requisitos: Node ≥ 18 y `agy` en el `PATH` (o define `AGY_BIN`). Debes haber ejecutado `agy` una vez e iniciado sesión. Ejecuta `/agy:setup` para comprobarlo todo y ver tu cuota y tus modelos.

## Comandos

| Comando | Qué hace |
|---|---|
| `/agy:task <task>` | Delegar trabajo: implementar, corregir, investigar. Ofrece continuar la conversación anterior de agy para seguimientos. |
| `/agy:ask <question>` | Preguntas de solo lectura sobre todo el código, o una segunda opinión. |
| `/agy:review` | Revisión de código estructurada. Objetivos: cambios sin confirmar, una rama (`--base`), un commit (`--commit <sha>`) o un PR de GitHub (`--pr <n>`, usa `gh`). Los hallazgos se ordenan por gravedad e incluyen file:line. |
| `/agy:adversarial-review` | Revisión que cuestiona el diseño, sus supuestos y cómo falla en el uso real. |
| `/agy:critique <plan or file>` | Revisión adversarial de un plan, documento de diseño o RFC antes de escribir código. agy contrasta cada supuesto con el código real. |
| `/agy:compare <question>` | Hacer la misma pregunta a varios modelos en paralelo (por defecto `gemini,opus,gpt`, es decir, Gemini, Claude y GPT a través de agy). Después Claude resume en qué coinciden y en qué difieren. |
| `/agy:apply [id]` | Aplicar el parche de una tarea `--worktree`. Recurre a una fusión de tres vías cuando hace falta. |
| `/agy:research <question>` | Responder a partir de Google Search en vivo, con las URL de las fuentes. |
| `/agy:image <description>` | Generar imágenes. Los archivos se guardan en `agy-images/`, o en el directorio indicado con `--out`. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Gestionar trabajos en segundo plano. |
| `/agy:transfer [note]` | Traspasar la sesión actual de Claude Code a agy. agy lee una transcripción condensada, revisa el espacio de trabajo y responde con el objetivo, el progreso, los problemas abiertos y los siguientes pasos. Continúa con `agy --conversation <id>` en una terminal, o con `/agy:task --resume-last` desde Claude. |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Comprobar la instalación y la autenticación, mostrar cuota y modelos, y activar o desactivar la puerta de revisión al detenerse para este espacio de trabajo. |

### Puerta de revisión al detenerse

Está desactivada por defecto. Actívala por espacio de trabajo con `/agy:setup --enable-review-gate`. Cuando Claude está a punto de detenerse y el árbol de trabajo tiene cambios sin confirmar que agy aún no ha revisado, agy los revisa. Si encuentra un defecto concreto, bloquea la detención y devuelve a Claude al trabajo con los hallazgos.

- Cada estado distinto del árbol de trabajo se revisa una sola vez, usando una huella de todo su contenido. Un estado que agy bloqueó sigue bloqueado hasta que el código cambie; volver a detenerse no llama a agy una segunda vez.
- Tras 3 bloqueos seguidos, la puerta deja pasar la detención, así que no puede entrar en un bucle infinito.
- Si agy falla (caída, cuota, tiempo de espera), la detención se permite. Una puerta rota nunca atrapa la sesión.

Claude también puede llamar por su cuenta al subagente **`agy-delegate`**. Lo hace para segundas opiniones, preguntas sobre todo el código, datos actuales de la web o tareas bien acotadas.

### Opciones comunes

- **Política de permisos.** El modo headless de agy no puede pedirte aprobación. Cualquier herramienta fuera de la política elegida detiene la ejecución, y la salida te lo indica.
  - *(por defecto)* solo lectura: agy puede leer archivos, pero no editarlos ni ejecutar comandos de shell.
  - `--write`: agy puede editar archivos del espacio de trabajo (`agy --mode accept-edits`).
  - `--worktree`: agy edita un git worktree desechable, precargado con tus archivos actuales sin confirmar y sin seguimiento (los enlaces simbólicos se mantienen como enlaces). Las carpetas de dependencias ignoradas, como `node_modules` y `.venv`, se enlazan para que se puedan ejecutar las pruebas, y nunca forman parte del parche. Necesita al menos un commit y se niega a ejecutarse si un submódulo tiene cambios sin confirmar. El resultado vuelve como un parche que aplicas con `/agy:apply`. Tu propio árbol de trabajo nunca se toca, así que varias tareas de agy y Claude pueden trabajar a la vez.
  - `--sandbox`: agy puede editar archivos y ejecutar cualquier comando de shell, como compilaciones y pruebas, dentro del sandbox de agy (`agy --sandbox --dangerously-skip-permissions`). Los comandos de shell ven un sistema de archivos de solo lectura salvo `/tmp`, así que no pueden cambiar tus archivos; las ediciones pasan por las herramientas de archivos de agy. La red sigue abierta y los archivos de tu directorio personal se pueden leer. Combínalo con `--worktree` para que agy implemente, ejecute las pruebas e itere sin tocar tu árbol de trabajo.
  - `--yolo`: agy también puede ejecutar comandos de shell y descargar URL (`agy --dangerously-skip-permissions`). Úsalo solo cuando lo pidas explícitamente.
- **Dejar que agy ejecute pruebas.** Usa `/agy:setup --allow-command "npm test"`. La regla se guarda en el `settings.json` global de agy, así que también se aplica a tus sesiones interactivas de agy. Elimínala con `--revoke-command`. A agy se le indica exactamente qué comandos puede ejecutar, de modo que puede correr las pruebas e iterar hasta que pasen, sin `--yolo`. Las reglas abiertas (`bash -c`, `python3 -c`, `npm exec`, `uv run`, …) y los metacaracteres de shell se rechazan. Esta comprobación evita reglas demasiado amplias por accidente. No es un sandbox: un comando de prueba permitido ejecuta código del proyecto, y en modo `--write` agy puede editar ese código. Si no quieres añadir una regla, `--sandbox` permite a agy ejecutar las pruebas sin ella.
- **Best-of-N.** `/agy:task --worktree --models gemini,opus,gpt <task>` hace que cada modelo implemente la tarea por su cuenta en su propio worktree. Claude compara los parches y tú aplicas el que prefieras.
- `--prompt-file <path>` añade el contenido de un archivo al prompt. Úsalo para logs grandes, trazas de pila o especificaciones; en Linux un solo argumento de línea de comandos está limitado a 128 KB.
- `/agy:result <id> --wait` espera hasta que termine un trabajo en segundo plano.
- `--background` ejecuta el trabajo en segundo plano. Desde los comandos slash se ejecuta como tarea en segundo plano de Claude, así que Claude recibe un aviso cuando agy termina. Sigue con `/agy:status` y `/agy:result`.
- `--resume-last` continúa la última conversación de agy completada en este espacio de trabajo. `--resume <conversation-id>` continúa una concreta.
- `--model <id|gemini|flash|opus|sonnet|gpt>` elige un modelo. Un alias se resuelve al modelo coincidente más reciente y prefiere la variante `-high`. Con `--effort`, el alias se resuelve en cambio al nombre base del modelo (por ejemplo `claude-opus-5-5`), porque agy rechaza un id `-high` combinado con otro nivel de esfuerzo. Un alias que no coincide con ningún modelo disponible produce un error.
- `--effort low|medium|high|xhigh|max`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

### Qué recibe agy y qué obtienes tú

- **Reglas de proyecto compartidas.** agy lee `GEMINI.md` y `AGENTS.md` por sí mismo. El plugin además le señala cada `CLAUDE.md` / `CLAUDE.local.md` desde el directorio de trabajo hasta la raíz del repositorio, para que ambos agentes sigan las mismas convenciones.
- **Imágenes como entrada.** agy es multimodal. Menciona una captura de pantalla, una maqueta o un diagrama por su ruta en cualquier tarea, por ejemplo "implement design/mock.png" o "why is the chart in bug.png empty?".
- **Comprobaciones en el navegador.** agy tiene herramientas de navegador. Donde Chrome esté instalado, una tarea `--yolo` puede abrir tu servidor de desarrollo, hacer clic por la interfaz y tomar capturas de pantalla.
- **Registro de auditoría.** Cada resultado lista los comandos de shell que ejecutó agy, marcados con ✓ o ✗. `/agy:status <id>` muestra la cronología completa de llamadas a herramientas, con duraciones y errores.

## Cómo funciona

`plugins/agy/scripts/agy-companion.mjs` es un único script de Node sin dependencias. Hace lo siguiente:

1. Construye un prompt con un preámbulo fijo: la raíz del espacio de trabajo, la política de herramientas y "nadie está mirando". El prompt llega a agy por **stdin**, así que los diffs grandes no chocan con los límites de argv. Ejecuta `agy --output-format stream-json`.
2. Transmite los eventos a un registro de trabajo en `~/.cache/agy-plugin/jobs/` (se puede cambiar con `AGY_PLUGIN_DATA`). El registro guarda el progreso en vivo, los archivos que editó agy, las herramientas denegadas, el uso de tokens y el id de conversación de agy.
3. Genera un informe en Markdown. Las revisiones usan `--json-schema` con `schemas/review.schema.json` y se muestran como hallazgos ordenados por gravedad. Los archivos que agy crea en `~/.gemini/antigravity-cli/brain/<conversation>/` se listan como artefactos, y las imágenes se copian al proyecto.

## Pruebas

```bash
node tests/companion.test.mjs   # usa un binario agy falso; sin red ni cuota
```

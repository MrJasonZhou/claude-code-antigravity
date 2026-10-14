[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

Ein Claude-Code-Plugin, das Arbeit an die **Google Antigravity CLI (`agy`)** übergibt und die Ergebnisse zurückholt – genauso wie das Codex-Plugin. agy führt Gemini aus (dazu die Claude- und GPT-OSS-Modelle, die es hostet) und bietet Google-Suche, Bildgenerierung und ein sehr großes Kontextfenster. Damit ist es ein guter zweiter Agent für Claude.

## Installation

```bash
claude plugin marketplace add MrJasonZhou/claude-code-antigravity
claude plugin install agy@agy-plugin
```

Voraussetzungen: Node ≥ 18 und `agy` im `PATH` (oder `AGY_BIN` setzen). Du musst `agy` einmal gestartet und dich angemeldet haben. Führe `/agy:setup` aus, um alles zu prüfen und dein Kontingent und deine Modelle zu sehen.

## Befehle

| Befehl | Was er tut |
|---|---|
| `/agy:task <task>` | Arbeit delegieren: implementieren, beheben, untersuchen. Bietet bei Folgeaufträgen an, die vorherige agy-Unterhaltung fortzusetzen. |
| `/agy:ask <question>` | Nur-Lese-Fragen zur gesamten Codebasis oder eine Zweitmeinung. |
| `/agy:review` | Strukturiertes Code-Review. Ziele: nicht committete Änderungen, ein Branch (`--base`), ein Commit (`--commit <sha>`) oder ein GitHub-PR (`--pr <n>`, nutzt `gh`). Befunde sind nach Schweregrad sortiert und enthalten file:line. |
| `/agy:adversarial-review` | Review, das das Design, seine Annahmen und sein Versagen im realen Einsatz hinterfragt. |
| `/agy:critique <plan or file>` | Kritisches Review eines Plans, Designdokuments oder RFC, bevor Code geschrieben wird. agy prüft jede Annahme am tatsächlichen Code. |
| `/agy:compare <question>` | Dieselbe Frage parallel an mehrere Modelle stellen (Standard `gemini,opus,gpt`, also Gemini, Claude und GPT über agy). Claude fasst anschließend zusammen, worin sie übereinstimmen und worin nicht. |
| `/agy:apply [id]` | Den Patch einer `--worktree`-Aufgabe anwenden. Weicht bei Bedarf auf einen 3-Wege-Merge aus. |
| `/agy:research <question>` | Antwort aus der Live-Google-Suche, mit Quell-URLs. |
| `/agy:image <description>` | Bilder erzeugen. Die Dateien werden in `agy-images/` gespeichert oder in dem mit `--out` angegebenen Verzeichnis. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Hintergrundjobs verwalten. |
| `/agy:transfer [note]` | Die aktuelle Claude-Code-Sitzung an agy übergeben. agy liest ein verdichtetes Transkript, prüft den Workspace und antwortet mit Ziel, Fortschritt, offenen Problemen und nächsten Schritten. Weiter geht es mit `agy --conversation <id>` im Terminal oder mit `/agy:task --resume-last` aus Claude. |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Installation und Anmeldung prüfen, Kontingent und Modelle anzeigen und das Review-Gate beim Stoppen für diesen Workspace ein- oder ausschalten. |

### Review-Gate beim Stoppen

Standardmäßig aus. Pro Workspace aktivierst du es mit `/agy:setup --enable-review-gate`. Wenn Claude gerade stoppen will und der Arbeitsbaum nicht committete Änderungen enthält, die agy noch nicht geprüft hat, prüft agy sie. Findet es einen konkreten Fehler, blockiert es den Stopp und schickt Claude mit den Befunden zurück an die Arbeit.

- Jeder unterschiedliche Zustand des Arbeitsbaums wird nur einmal geprüft, anhand eines Fingerabdrucks des vollständigen Inhalts. Ein von agy blockierter Zustand bleibt blockiert, bis sich der Code ändert; ein erneuter Stopp ruft agy kein zweites Mal auf.
- Nach 3 Blockaden in Folge lässt das Gate den Stopp durch, es kann also nicht endlos schleifen.
- Wenn agy fehlschlägt (Ausfall, Kontingent, Zeitüberschreitung), geht der Stopp durch. Ein defektes Gate hält die Sitzung nie fest.

Claude kann den Subagenten **`agy-delegate`** auch selbst aufrufen – für Zweitmeinungen, Fragen zur gesamten Codebasis, aktuelle Fakten aus dem Web oder klar abgegrenzte Aufgaben.

### Häufige Optionen

- **Berechtigungsrichtlinie.** Der Headless-Modus von agy kann dich nicht um Zustimmung bitten. Jedes Werkzeug außerhalb der gewählten Richtlinie beendet den Lauf, und die Ausgabe sagt dir das.
  - *(Standard)* nur lesen: agy kann Dateien lesen, sie aber weder bearbeiten noch Shell-Befehle ausführen.
  - `--write`: agy kann Dateien im Workspace bearbeiten (`agy --mode accept-edits`).
  - `--worktree`: agy bearbeitet einen Wegwerf-Git-Worktree, der mit deinen aktuellen nicht committeten und nicht verfolgten Dateien befüllt ist (symbolische Links bleiben Links). Ignorierte Abhängigkeitsordner wie `node_modules` und `.venv` werden verlinkt, damit Tests laufen können, und sind nie Teil des Patches. Es wird mindestens ein Commit benötigt, und der Lauf wird verweigert, wenn ein Submodul nicht committete Änderungen hat. Das Ergebnis kommt als Patch zurück, den du mit `/agy:apply` anwendest. Dein eigener Arbeitsbaum wird nie angefasst, sodass mehrere agy-Aufgaben und Claude gleichzeitig arbeiten können.
  - `--sandbox`: agy kann Dateien bearbeiten und beliebige Shell-Befehle wie Builds und Tests in agys eigener Sandbox ausführen (`agy --sandbox --dangerously-skip-permissions`). Shell-Befehle sehen ein schreibgeschütztes Dateisystem außer `/tmp` und können deine Dateien daher nicht ändern; Änderungen laufen über agys Datei-Werkzeuge. Das Netzwerk bleibt offen, und Dateien in deinem Home-Verzeichnis sind lesbar. Kombiniere es mit `--worktree`, damit agy implementieren, die Tests laufen lassen und iterieren kann, ohne deinen Arbeitsbaum anzufassen.
  - `--yolo`: agy kann zusätzlich Shell-Befehle ausführen und URLs abrufen (`agy --dangerously-skip-permissions`). Nur verwenden, wenn du es ausdrücklich verlangst.
- **agy Tests ausführen lassen.** Verwende `/agy:setup --allow-command "npm test"`. Die Regel wird in agys eigener globaler `settings.json` gespeichert und gilt daher auch für deine interaktiven agy-Sitzungen. Entferne sie mit `--revoke-command`. agy erfährt genau, welche Befehle es ausführen darf, und kann so die Tests laufen lassen und iterieren, bis sie bestehen – ohne `--yolo`. Offene Regeln (`bash -c`, `python3 -c`, `npm exec`, `uv run`, …) und Shell-Metazeichen werden abgelehnt. Diese Prüfung verhindert versehentlich zu weit gefasste Regeln. Sie ist keine Sandbox: Ein erlaubter Testbefehl führt Projektcode aus, und im `--write`-Modus kann agy diesen Code bearbeiten. Wenn du keine Regel anlegen willst, lässt `--sandbox` agy die Tests auch ohne Regel ausführen.
- **Best-of-N.** `/agy:task --worktree --models gemini,opus,gpt <task>` lässt jedes Modell die Aufgabe unabhängig in einem eigenen Worktree umsetzen. Claude vergleicht die Patches, und du wendest den an, der dir am besten gefällt.
- `--prompt-file <path>` fügt den Inhalt einer Datei zum Prompt hinzu. Gedacht für große Logs, Stacktraces oder Spezifikationen; unter Linux ist ein einzelnes Kommandozeilenargument auf 128 KB begrenzt.
- `/agy:result <id> --wait` wartet, bis ein Hintergrundjob fertig ist.
- `--background` führt den Job im Hintergrund aus. Aus Slash-Befehlen läuft er als Claude-Hintergrundaufgabe, sodass Claude benachrichtigt wird, wenn agy fertig ist. Danach `/agy:status` und `/agy:result` verwenden.
- `--resume-last` setzt die letzte abgeschlossene agy-Unterhaltung in diesem Workspace fort. `--resume <conversation-id>` setzt eine bestimmte fort.
- `--model <id|gemini|flash|opus|sonnet|gpt>` wählt ein Modell. Ein Alias wird auf das neueste passende Modell aufgelöst und bevorzugt die `-high`-Variante. Mit `--effort` wird der Alias stattdessen auf den Basisnamen des Modells aufgelöst (zum Beispiel `claude-opus-5-5`), da agy eine `-high`-ID zusammen mit einer anderen Effort-Stufe ablehnt. Ein Alias, der zu keinem verfügbaren Modell passt, führt zu einem Fehler.
- `--effort low|medium|high|xhigh|max`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

### Was agy mitbekommt und was du zurückbekommst

- **Gemeinsame Projektregeln.** agy liest `GEMINI.md` und `AGENTS.md` selbstständig. Das Plugin verweist es zusätzlich auf jede `CLAUDE.md` / `CLAUDE.local.md` vom Arbeitsverzeichnis bis zur Repo-Wurzel, damit beide Agenten denselben Konventionen folgen.
- **Bilder als Eingabe.** agy ist multimodal. Nenne in einer beliebigen Aufgabe einen Screenshot, ein Mockup oder ein Diagramm über seinen Pfad, zum Beispiel „implement design/mock.png“ oder „why is the chart in bug.png empty?“.
- **Browser-Prüfungen.** agy hat Browser-Werkzeuge. Wo Chrome installiert ist, kann eine `--yolo`-Aufgabe deinen Dev-Server öffnen, sich durchklicken und Screenshots machen.
- **Prüfprotokoll.** Jedes Ergebnis listet die Shell-Befehle auf, die agy ausgeführt hat, jeweils mit ✓ oder ✗ markiert. `/agy:status <id>` zeigt die vollständige Zeitleiste der Werkzeugaufrufe, einschließlich Dauer und Fehlern.

## Funktionsweise

`plugins/agy/scripts/agy-companion.mjs` ist ein einzelnes Node-Skript ohne Abhängigkeiten. Es macht Folgendes:

1. Es baut einen Prompt mit festem Vorspann: Workspace-Wurzel, Werkzeugrichtlinie und „niemand schaut zu“. Der Prompt geht über **stdin** an agy, damit große Diffs nicht an argv-Grenzen stoßen. Es startet `agy --output-format stream-json`.
2. Es streamt die Ereignisse in einen Job-Datensatz unter `~/.cache/agy-plugin/jobs/` (änderbar mit `AGY_PLUGIN_DATA`). Der Datensatz enthält den Live-Fortschritt, die von agy bearbeiteten Dateien, abgelehnte Werkzeuge, den Token-Verbrauch und die agy-Unterhaltungs-id.
3. Es erzeugt einen Markdown-Bericht. Reviews nutzen `--json-schema` mit `schemas/review.schema.json` und werden als nach Schweregrad sortierte Befunde dargestellt. Dateien, die agy in `~/.gemini/antigravity-cli/brain/<conversation>/` anlegt, werden als Artefakte aufgelistet, und Bilder werden ins Projekt kopiert.

## Tests

```bash
node tests/companion.test.mjs   # nutzt eine gefälschte agy-Binary; kein Netzwerk, kein Kontingent
```

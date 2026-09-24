[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

Un plugin Claude Code qui confie du travail à **Google Antigravity CLI (`agy`)** et en rapporte les résultats, de la même manière que le plugin Codex. agy exécute Gemini (ainsi que les modèles Claude et GPT-OSS qu'il héberge) et dispose de la recherche Google, de la génération d'images et d'une très grande fenêtre de contexte. C'est donc un bon second agent pour Claude.

## Installation

```bash
claude plugin marketplace add /path/to/agy_plugin
claude plugin install agy@agy-plugin
```

Prérequis : Node ≥ 18 et `agy` dans le `PATH` (ou définissez `AGY_BIN`). Vous devez avoir lancé `agy` une fois et vous être connecté. Lancez `/agy:setup` pour tout vérifier et voir votre quota et vos modèles.

## Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `/agy:task <task>` | Déléguer du travail : implémenter, corriger, enquêter. Propose de reprendre la conversation agy précédente pour les suites. |
| `/agy:ask <question>` | Questions en lecture seule sur l'ensemble du code, ou un second avis. |
| `/agy:review` | Revue de code structurée. Cibles : modifications non commitées, une branche (`--base`), un commit (`--commit <sha>`) ou une PR GitHub (`--pr <n>`, utilise `gh`). Les constats sont triés par gravité et indiquent file:line. |
| `/agy:adversarial-review` | Revue qui remet en cause la conception, ses hypothèses et la façon dont elle échoue en usage réel. |
| `/agy:critique <plan or file>` | Revue contradictoire d'un plan, d'un document de conception ou d'une RFC avant d'écrire le moindre code. agy confronte chaque hypothèse au code réel. |
| `/agy:compare <question>` | Poser la même question à plusieurs modèles en parallèle (par défaut `pro,opus,gpt`, c.-à-d. Gemini, Claude et GPT via agy). Claude résume ensuite leurs points d'accord et de désaccord. |
| `/agy:apply [id]` | Appliquer le patch d'une tâche `--worktree`. Bascule sur une fusion à trois voies si nécessaire. |
| `/agy:research <question>` | Répondre à partir de la recherche Google en direct, avec les URL des sources. |
| `/agy:image <description>` | Générer des images. Les fichiers sont enregistrés dans `agy-images/`, ou dans le répertoire indiqué par `--out`. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Gérer les tâches en arrière-plan. |
| `/agy:transfer [note]` | Transmettre la session Claude Code en cours à agy. agy lit une transcription condensée, examine l'espace de travail et répond avec l'objectif, l'avancement, les problèmes ouverts et les prochaines étapes. Continuez avec `agy --conversation <id>` dans un terminal, ou `/agy:task --resume-last` depuis Claude. |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Vérifier l'installation et l'authentification, afficher le quota et les modèles, et activer ou désactiver la porte de revue à l'arrêt pour cet espace de travail. |

### Porte de revue à l'arrêt

Désactivée par défaut. Activez-la par espace de travail avec `/agy:setup --enable-review-gate`. Lorsque Claude s'apprête à s'arrêter et que l'arbre de travail contient des modifications non commitées qu'agy n'a pas encore revues, agy les examine. S'il trouve un défaut concret, il bloque l'arrêt et renvoie Claude au travail avec les constats.

- Chaque état distinct de l'arbre de travail n'est revu qu'une fois, grâce à une empreinte de son contenu complet. Un état bloqué par agy le reste jusqu'à ce que le code change ; s'arrêter à nouveau n'appelle pas agy une deuxième fois.
- Après 3 blocages consécutifs, la porte laisse passer l'arrêt, elle ne peut donc pas boucler indéfiniment.
- Si agy échoue (panne, quota, délai dépassé), l'arrêt passe. Une porte défaillante ne bloque jamais la session.

Claude peut aussi appeler de lui-même le sous-agent **`agy-delegate`**. Il le fait pour un second avis, des questions portant sur tout le code, des informations web récentes ou des tâches bien délimitées.

### Options courantes

- **Politique de permissions.** Le mode headless d'agy ne peut pas vous demander d'approbation. Tout outil hors de la politique choisie arrête l'exécution, et la sortie vous l'indique.
  - *(par défaut)* lecture seule : agy peut lire les fichiers, mais ne peut ni les modifier ni exécuter de commandes shell.
  - `--write` : agy peut modifier les fichiers de l'espace de travail (`agy --mode accept-edits`).
  - `--worktree` : agy modifie un git worktree jetable, pré-rempli avec vos fichiers actuels non commités et non suivis (les liens symboliques restent des liens). Les dossiers de dépendances ignorés comme `node_modules` et `.venv` y sont liés pour que les tests puissent s'exécuter, et ne font jamais partie du patch. Il faut au moins un commit, et l'exécution est refusée si un sous-module a des modifications non commitées. Le résultat revient sous forme de patch à appliquer avec `/agy:apply`. Votre propre arbre de travail n'est jamais touché, donc plusieurs tâches agy et Claude peuvent travailler en même temps.
  - `--yolo` : agy peut aussi exécuter des commandes shell et récupérer des URL (`agy --dangerously-skip-permissions`). À n'utiliser que si vous le demandez explicitement.
- **Laisser agy lancer les tests.** Utilisez `/agy:setup --allow-command "npm test"`. La règle est enregistrée dans le `settings.json` global d'agy, elle s'applique donc aussi à vos sessions agy interactives. Supprimez-la avec `--revoke-command`. agy sait exactement quelles commandes il peut lancer, il peut donc exécuter les tests et itérer jusqu'à ce qu'ils passent, sans `--yolo`. Les règles ouvertes (`bash -c`, `python3 -c`, `npm exec`, `uv run`, …) et les métacaractères du shell sont refusés. Ce contrôle empêche les règles trop larges par inadvertance. Ce n'est pas un bac à sable : une commande de test autorisée exécute le code du projet, et en mode `--write` agy peut modifier ce code.
- **Best-of-N.** `/agy:task --worktree --models pro,opus,gpt <task>` fait implémenter la tâche par chaque modèle, indépendamment, dans son propre worktree. Claude compare les patches et vous appliquez celui que vous préférez.
- `--prompt-file <path>` ajoute le contenu d'un fichier au prompt. Utile pour de gros journaux, des traces de pile ou des spécifications ; un argument de ligne de commande est limité à 128 Ko sous Linux.
- `/agy:result <id> --wait` attend la fin d'une tâche en arrière-plan.
- `--background` exécute la tâche en arrière-plan. Depuis les commandes slash, elle s'exécute comme tâche d'arrière-plan de Claude, qui est donc notifié quand agy termine. Enchaînez avec `/agy:status` et `/agy:result`.
- `--resume-last` reprend la dernière conversation agy terminée dans cet espace de travail. `--resume <conversation-id>` reprend une conversation précise.
- `--model <id|pro|flash|opus|sonnet|gpt>` choisit un modèle. Un alias se résout vers le modèle correspondant le plus récent et privilégie la variante `-high`.
- `--effort low|medium|high`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

### Ce qu'agy reçoit et ce que vous obtenez

- **Règles de projet partagées.** agy lit `GEMINI.md` et `AGENTS.md` de lui-même. Le plugin lui indique en plus chaque `CLAUDE.md` / `CLAUDE.local.md` du répertoire de travail jusqu'à la racine du dépôt, afin que les deux agents suivent les mêmes conventions.
- **Images en entrée.** agy est multimodal. Mentionnez une capture d'écran, une maquette ou un diagramme par son chemin dans n'importe quelle tâche, par exemple « implement design/mock.png » ou « why is the chart in bug.png empty? ».
- **Vérifications dans le navigateur.** agy dispose d'outils de navigateur. Là où Chrome est installé, une tâche `--yolo` peut ouvrir votre serveur de développement, cliquer dans l'interface et prendre des captures d'écran.
- **Piste d'audit.** Chaque résultat liste les commandes shell lancées par agy, marquées ✓ ou ✗. `/agy:status <id>` affiche la chronologie complète des appels d'outils, avec durées et erreurs.

## Fonctionnement

`plugins/agy/scripts/agy-companion.mjs` est un unique script Node sans dépendances. Il fait ceci :

1. Il construit un prompt avec un préambule fixe : la racine de l'espace de travail, la politique d'outils et « personne ne regarde ». Le prompt est transmis à agy via **stdin**, donc les gros diffs ne butent pas sur les limites d'argv. Il lance `agy --output-format stream-json`.
2. Il diffuse les événements dans un enregistrement de tâche sous `~/.cache/agy-plugin/jobs/` (modifiable avec `AGY_PLUGIN_DATA`). L'enregistrement contient la progression en direct, les fichiers modifiés par agy, les outils refusés, la consommation de tokens et l'id de conversation agy.
3. Il produit un rapport Markdown. Les revues utilisent `--json-schema` avec `schemas/review.schema.json` et sont rendues sous forme de constats triés par gravité. Les fichiers qu'agy crée dans `~/.gemini/antigravity-cli/brain/<conversation>/` sont listés comme artefacts, et les images sont copiées dans le projet.

## Tests

```bash
node tests/companion.test.mjs   # utilise un faux binaire agy ; ni réseau ni quota
```

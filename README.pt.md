[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

Um plugin do Claude Code que entrega trabalho ao **Google Antigravity CLI (`agy`)** e traz os resultados de volta, do mesmo jeito que o plugin do Codex. O agy executa o Gemini (além dos modelos Claude e GPT-OSS que ele hospeda) e tem Google Search, geração de imagens e uma janela de contexto muito grande. Isso faz dele um bom segundo agente para o Claude.

## Instalação

```bash
claude plugin marketplace add MrJasonZhou/claude-code-antigravity
claude plugin install agy@agy-plugin
```

Requisitos: Node ≥ 18 e `agy` no `PATH` (ou defina `AGY_BIN`). Você precisa ter executado o `agy` uma vez e feito login. Execute `/agy:setup` para verificar tudo e ver sua cota e seus modelos.

## Comandos

| Comando | O que faz |
|---|---|
| `/agy:task <task>` | Delegar trabalho: implementar, corrigir, investigar. Oferece continuar a conversa anterior do agy em acompanhamentos. |
| `/agy:ask <question>` | Perguntas somente leitura sobre todo o código, ou uma segunda opinião. |
| `/agy:review` | Revisão de código estruturada. Alvos: alterações não commitadas, um branch (`--base`), um commit (`--commit <sha>`) ou um PR do GitHub (`--pr <n>`, usa `gh`). Os achados são ordenados por gravidade e incluem file:line. |
| `/agy:adversarial-review` | Revisão que questiona o design, suas premissas e como ele falha no uso real. |
| `/agy:critique <plan or file>` | Revisão adversarial de um plano, documento de design ou RFC antes de escrever qualquer código. O agy confronta cada premissa com o código real. |
| `/agy:compare <question>` | Fazer a mesma pergunta a vários modelos em paralelo (padrão `gemini,opus,gpt`, ou seja, Gemini, Claude e GPT via agy). Depois o Claude resume onde eles concordam e discordam. |
| `/agy:apply [id]` | Aplicar o patch de uma tarefa `--worktree`. Recorre a um merge de três vias quando necessário. |
| `/agy:research <question>` | Responder com base no Google Search ao vivo, com as URLs das fontes. |
| `/agy:image <description>` | Gerar imagens. Os arquivos são salvos em `agy-images/`, ou no diretório indicado por `--out`. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Gerenciar jobs em segundo plano. |
| `/agy:transfer [note]` | Passar a sessão atual do Claude Code para o agy. O agy lê uma transcrição condensada, verifica o workspace e responde com objetivo, progresso, problemas em aberto e próximos passos. Continue com `agy --conversation <id>` em um terminal, ou `/agy:task --resume-last` pelo Claude. |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Verificar instalação e autenticação, mostrar cota e modelos, e ativar ou desativar o portão de revisão na parada para este workspace. |

### Portão de revisão na parada

Fica desativado por padrão. Ative-o por workspace com `/agy:setup --enable-review-gate`. Quando o Claude está prestes a parar e a árvore de trabalho tem alterações não commitadas que o agy ainda não revisou, o agy as revisa. Se encontrar um defeito concreto, ele bloqueia a parada e manda o Claude de volta com os achados.

- Cada estado distinto da árvore de trabalho é revisado só uma vez, usando uma impressão digital do conteúdo completo. Um estado que o agy bloqueou continua bloqueado até o código mudar; parar de novo não chama o agy uma segunda vez.
- Depois de 3 bloqueios seguidos, o portão deixa a parada passar, então não há loop infinito.
- Se o agy falhar (indisponibilidade, cota, timeout), a parada passa. Um portão quebrado nunca prende a sessão.

O Claude também pode chamar por conta própria o subagente **`agy-delegate`**. Ele faz isso para segundas opiniões, perguntas sobre todo o código, fatos atuais da web ou tarefas bem delimitadas.

### Opções comuns

- **Política de permissões.** O modo headless do agy não pode pedir sua aprovação. Qualquer ferramenta fora da política escolhida interrompe a execução, e a saída informa isso.
  - *(padrão)* somente leitura: o agy pode ler arquivos, mas não pode editá-los nem executar comandos de shell.
  - `--write`: o agy pode editar arquivos no workspace (`agy --mode accept-edits`).
  - `--worktree`: o agy edita um git worktree descartável, pré-carregado com seus arquivos atuais não commitados e não rastreados (links simbólicos continuam como links). Pastas de dependências ignoradas, como `node_modules` e `.venv`, são vinculadas para que os testes possam rodar, e nunca fazem parte do patch. É preciso ter pelo menos um commit, e a execução é recusada se um submódulo tiver alterações não commitadas. O resultado volta como um patch que você aplica com `/agy:apply`. Sua própria árvore de trabalho nunca é tocada, então várias tarefas do agy e o Claude podem trabalhar ao mesmo tempo.
  - `--yolo`: o agy também pode executar comandos de shell e buscar URLs (`agy --dangerously-skip-permissions`). Use apenas quando você pedir isso explicitamente.
- **Deixar o agy rodar testes.** Use `/agy:setup --allow-command "npm test"`. A regra é armazenada no `settings.json` global do próprio agy, então também vale para suas sessões interativas do agy. Remova-a com `--revoke-command`. O agy é informado exatamente de quais comandos pode executar, então consegue rodar os testes e iterar até passarem, sem `--yolo`. Regras abertas (`bash -c`, `python3 -c`, `npm exec`, `uv run`, …) e metacaracteres de shell são recusados. Essa verificação impede regras amplas demais por acidente. Não é um sandbox: um comando de teste permitido executa código do projeto, e no modo `--write` o agy pode editar esse código.
- **Best-of-N.** `/agy:task --worktree --models gemini,opus,gpt <task>` faz cada modelo implementar a tarefa sozinho, no seu próprio worktree. O Claude compara os patches e você aplica o que preferir.
- `--prompt-file <path>` adiciona o conteúdo de um arquivo ao prompt. Use para logs grandes, stack traces ou especificações; no Linux, um único argumento de linha de comando é limitado a 128 KB.
- `/agy:result <id> --wait` aguarda até um job em segundo plano terminar.
- `--background` executa o job em segundo plano. A partir de slash commands, ele roda como tarefa em segundo plano do Claude, então o Claude é notificado quando o agy termina. Continue com `/agy:status` e `/agy:result`.
- `--resume-last` continua a última conversa concluída do agy neste workspace. `--resume <conversation-id>` continua uma específica.
- `--model <id|gemini|flash|opus|sonnet|gpt>` escolhe um modelo. Um alias resolve para o modelo correspondente mais recente e prefere a variante `-high`. Com `--effort`, o alias resolve para o nome base do modelo (por exemplo `claude-opus-5-5`), pois o agy rejeita um id `-high` combinado com outro nível de esforço. Um alias que não corresponde a nenhum modelo disponível gera um erro.
- `--effort low|medium|high|xhigh|max`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

### O que o agy recebe e o que você recebe de volta

- **Regras de projeto compartilhadas.** O agy lê `GEMINI.md` e `AGENTS.md` sozinho. O plugin também aponta para ele cada `CLAUDE.md` / `CLAUDE.local.md` do diretório de trabalho até a raiz do repositório, para que os dois agentes sigam as mesmas convenções.
- **Imagens como entrada.** O agy é multimodal. Mencione uma captura de tela, um mockup ou um diagrama pelo caminho em qualquer tarefa, por exemplo "implement design/mock.png" ou "why is the chart in bug.png empty?".
- **Verificações no navegador.** O agy tem ferramentas de navegador. Onde o Chrome estiver instalado, uma tarefa `--yolo` pode abrir seu servidor de desenvolvimento, clicar pela interface e tirar capturas de tela.
- **Trilha de auditoria.** Cada resultado lista os comandos de shell que o agy executou, marcados com ✓ ou ✗. `/agy:status <id>` mostra a linha do tempo completa das chamadas de ferramentas, incluindo durações e erros.

## Como funciona

`plugins/agy/scripts/agy-companion.mjs` é um único script Node sem dependências. Ele faz o seguinte:

1. Monta um prompt com um preâmbulo fixo: a raiz do workspace, a política de ferramentas e "ninguém está observando". O prompt vai para o agy pela **stdin**, então diffs grandes não esbarram nos limites de argv. Ele executa `agy --output-format stream-json`.
2. Transmite os eventos para um registro de job em `~/.cache/agy-plugin/jobs/` (altere com `AGY_PLUGIN_DATA`). O registro guarda o progresso ao vivo, os arquivos que o agy editou, as ferramentas negadas, o uso de tokens e o id da conversa do agy.
3. Gera um relatório em Markdown. As revisões usam `--json-schema` com `schemas/review.schema.json` e são exibidas como achados ordenados por gravidade. Os arquivos que o agy cria em `~/.gemini/antigravity-cli/brain/<conversation>/` são listados como artefatos, e as imagens são copiadas para o projeto.

## Testes

```bash
node tests/companion.test.mjs   # usa um binário agy falso; sem rede nem cota
```

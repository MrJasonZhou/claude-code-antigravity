[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

作業を **Google Antigravity CLI（`agy`）** に引き渡し、結果を持ち帰る Claude Code プラグインです。使い方は Codex プラグインと同じです。agy は Gemini（およびホストしている Claude や GPT-OSS モデル）を実行し、Google 検索、画像生成、非常に大きなコンテキストウィンドウを備えています。そのため Claude の 2 つ目のエージェントとして適しています。

## インストール

```bash
claude plugin marketplace add MrJasonZhou/claude-code-antigravity
claude plugin install agy@agy-plugin
```

要件：Node ≥ 18、`agy` が `PATH` 上にあること（または `AGY_BIN` を設定）。事前に一度 `agy` を実行してサインインしておく必要があります。`/agy:setup` を実行すると、すべての設定を確認し、クォータとモデルを表示できます。

## コマンド

| コマンド | 内容 |
|---|---|
| `/agy:task <task>` | 作業を委任します：実装、修正、調査。フォローアップ時には前回の agy 会話の継続を提案します。 |
| `/agy:ask <question>` | コードベース全体に関する読み取り専用の質問、またはセカンドオピニオン。 |
| `/agy:review` | 構造化されたコードレビュー。対象：未コミットの変更、ブランチ（`--base`）、単一コミット（`--commit <sha>`）、GitHub PR（`--pr <n>`、`gh` を使用）。指摘は重大度順に並び、file:line が付きます。 |
| `/agy:adversarial-review` | 設計、その前提、そして実運用でどう壊れるかに異議を唱えるレビュー。 |
| `/agy:critique <plan or file>` | コードを書く前に、計画・設計書・RFC を批判的にレビューします。agy は各前提を実際のコードと照合します。 |
| `/agy:compare <question>` | 同じ質問を複数のモデルに並列で投げます（既定は `gemini,opus,gpt`、つまり agy 経由の Gemini、Claude、GPT）。その後 Claude が一致点と相違点をまとめます。 |
| `/agy:apply [id]` | `--worktree` タスクのパッチを適用します。必要に応じて 3-way マージにフォールバックします。 |
| `/agy:research <question>` | リアルタイムの Google 検索に基づき、ソース URL 付きで回答します。 |
| `/agy:image <description>` | 画像を生成します。ファイルは `agy-images/`、または `--out` で指定したディレクトリに保存されます。 |
| `/agy:status [id]`、`/agy:result [id]`、`/agy:cancel [id]` | バックグラウンドジョブを管理します。 |
| `/agy:transfer [note]` | 現在の Claude Code セッションを agy に引き継ぎます。agy は要約されたトランスクリプトを読み、ワークスペースを確認し、目標・進捗・未解決の問題・次のステップを返します。ターミナルで `agy --conversation <id>`、または Claude から `/agy:task --resume-last` で続行できます。 |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | インストールと認証を確認し、クォータとモデルを表示し、このワークスペースの停止時レビューゲートをオン／オフします。 |

### 停止時レビューゲート

既定ではオフです。`/agy:setup --enable-review-gate` でワークスペースごとに有効にします。Claude が停止しようとしたとき、作業ツリーに agy がまだレビューしていない未コミットの変更があれば、agy がそれをレビューします。具体的な欠陥が見つかれば停止をブロックし、指摘とともに Claude に作業を戻します。

- 異なる作業ツリーの状態はそれぞれ一度だけ、内容全体のフィンガープリントに基づいてレビューされます。agy がブロックした状態は、コードが変わるまでブロックされたままです。再度停止しても agy を二度呼び出すことはありません。
- 3 回連続でブロックした後は停止を通すため、無限ループにはなりません。
- agy が失敗した場合（障害、クォータ、タイムアウト）、停止はそのまま通ります。壊れたゲートがセッションを閉じ込めることはありません。

Claude は **`agy-delegate`** サブエージェントを自ら呼び出すこともできます。セカンドオピニオン、コードベース全体に関する質問、最新の Web 情報、範囲が明確なタスクに使います。

### よく使うフラグ

- **権限ポリシー。** agy のヘッドレスモードでは承認を求めることができません。選択したポリシー外のツールを使うと実行は停止し、その旨が出力に表示されます。
  - *（既定）* 読み取り専用：agy はファイルを読めますが、編集やシェルコマンドの実行はできません。
  - `--write`：agy はワークスペース内のファイルを編集できます（`agy --mode accept-edits`）。
  - `--worktree`：agy は使い捨ての git worktree で編集します。この worktree には現在の未コミット・未追跡ファイルが事前に入ります（シンボリックリンクはリンクのまま）。`node_modules` や `.venv` など無視された依存ディレクトリはテストを実行できるようリンクされ、パッチには決して含まれません。少なくとも 1 つのコミットが必要で、サブモジュールに未コミットの変更がある場合は実行を拒否します。結果はパッチとして返り、`/agy:apply` で適用します。自分の作業ツリーには一切触れないため、複数の agy タスクと Claude が同時に作業できます。
  - `--yolo`：agy はシェルコマンドの実行や URL の取得もできます（`agy --dangerously-skip-permissions`）。明示的に求めた場合にのみ使ってください。
- **agy にテストを実行させる。** `/agy:setup --allow-command "npm test"` を使います。ルールは agy 自身のグローバル `settings.json` に保存されるため、対話型の agy セッションにも適用されます。`--revoke-command` で削除します。agy には実行してよいコマンドが正確に伝えられるので、`--yolo` なしでテストを実行し、通るまで反復できます。制限のないルール（`bash -c`、`python3 -c`、`npm exec`、`uv run` など）やシェルのメタ文字は拒否されます。このチェックはうっかり広すぎるルールを防ぐためのもので、サンドボックスではありません。許可したテストコマンドはプロジェクトのコードを実行し、`--write` モードでは agy がそのコードを編集できます。
- **Best-of-N。** `/agy:task --worktree --models gemini,opus,gpt <task>` では、各モデルがそれぞれの worktree で独立にタスクを実装します。Claude がパッチを比較し、あなたが好きなものを適用します。
- `--prompt-file <path>` はファイルの内容をプロンプトに追加します。大きなログ、スタックトレース、仕様書に使います。Linux ではコマンドライン引数 1 つあたり 128 KB が上限です。
- `/agy:result <id> --wait` はバックグラウンドジョブが終わるまで待機します。
- `--background` はジョブをバックグラウンドで実行します。スラッシュコマンドからは Claude のバックグラウンドタスクとして実行されるため、agy が終わると Claude に通知されます。その後 `/agy:status` と `/agy:result` を使います。
- `--resume-last` はこのワークスペースで最後に完了した agy 会話を続けます。`--resume <conversation-id>` は特定の会話を続けます。
- `--model <id|gemini|flash|opus|sonnet|gpt>` でモデルを選びます。エイリアスは一致する最新のモデルに解決され、`-high` バリアントが優先されます。`--effort` を指定した場合は、エイリアスはモデルの基本名（例：`claude-opus-5-5`）に解決されます。agy は `-high` 付きの id と異なる effort の組み合わせを拒否するためです。利用可能なモデルに一致しないエイリアスはエラーになります。
- `--effort low|medium|high|xhigh|max`、`--add-dir <dir>`、`--timeout <sec>`、`--agent <custom agy agent>`、`--json`。

### agy に伝わる内容と返ってくるもの

- **共有プロジェクトルール。** agy は `GEMINI.md` と `AGENTS.md` を自分で読みます。プラグインはさらに、作業ディレクトリからリポジトリのルートまでのすべての `CLAUDE.md` / `CLAUDE.local.md` を指し示すため、両方のエージェントが同じ規約に従います。
- **画像入力。** agy はマルチモーダルです。任意のタスクでスクリーンショット、モックアップ、図をパスで指定できます。例："implement design/mock.png"、"why is the chart in bug.png empty?"。
- **ブラウザでの確認。** agy はブラウザツールを持っています。Chrome がインストールされていれば、`--yolo` タスクで開発サーバーを開き、クリック操作やスクリーンショットができます。
- **監査ログ。** すべての結果に agy が実行したシェルコマンドが ✓ または ✗ 付きで一覧表示されます。`/agy:status <id>` では、所要時間やエラーを含むツール呼び出しの完全なタイムラインを表示します。

## 仕組み

`plugins/agy/scripts/agy-companion.mjs` は依存関係のない単一の Node スクリプトで、次の処理を行います。

1. 固定の前文（ワークスペースのルート、ツールポリシー、「誰も見ていない」）付きでプロンプトを組み立てます。プロンプトは **stdin** で agy に渡すため、大きな diff でも argv の制限に当たりません。`agy --output-format stream-json` を実行します。
2. イベントを `~/.cache/agy-plugin/jobs/` のジョブ記録にストリーミングします（`AGY_PLUGIN_DATA` で変更可能）。記録にはリアルタイムの進捗、agy が編集したファイル、拒否されたツール、トークン使用量、agy の会話 id が含まれます。
3. Markdown レポートを生成します。レビューは `--json-schema` と `schemas/review.schema.json` を使い、重大度順の指摘として表示されます。agy が `~/.gemini/antigravity-cli/brain/<conversation>/` に作成したファイルは成果物として一覧表示され、画像はプロジェクトにコピーされます。

## テスト

```bash
node tests/companion.test.mjs   # 偽の agy バイナリを使用。ネットワークやクォータは不要
```

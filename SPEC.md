# ChatDango (旧 V-Cmdango / chat-cmd)

Claude Code / Codex を LINE風チャットで使うローカルツール。会話に名前をつけて管理し、続きから話すと自動で resume される。

## 起動
`start.bat`(サーバー起動 + Brave/Edge/Chromeのアプリ画面で http://127.0.0.1:5178)。依存なし(Node のみ)。

## 構成
- `server.js` — 127.0.0.1:5178 のHTTP+SSEサーバー。1メッセージ=1プロセス起動。
  - Claude: `claude -p --output-format stream-json --verbose [--resume <session_id>]`
  - Codex: `codex exec --json --skip-git-repo-check [resume <thread_id>] -`
  - 入力は stdin 渡し(引数のクォート問題回避)。停止は `taskkill /T /F`。
  - Host/Origin がローカル以外は403(他サイトからの操作対策)。
- `public/index.html` — UI。左=会話リスト(未読バッジ/実行中ドット/色アイコン)、右=吹き出し。ツール実行は小さい灰色行。
- `data/sessions.json` — 会話(名前/ツール/フォルダ/権限/色/nativeId/履歴)。

## 仕様メモ
- 権限: 「全許可」(既定。claude=--dangerously-skip-permissions / codex=--dangerously-bypass-approvals-and-sandbox)、「安全寄り」(claude=acceptEdits / codex=workspace-write)。会話ごとに設定可。
- 色: ANSIカラー(`ESC[..m`)を吹き出し内で色表示 + 会話ごとのアイコン色。
- Enter送信 / Shift+Enter改行(IME変換中は送信しない)。実行中は送信不可、■停止あり。
- 取り込み: 左上「取り込み」で既存セッション一覧(新しい順300件、絞り込み可)→クリック→名前をつけて取り込み。`importer.js` が `~/.claude/projects/*/*.jsonl` と `~/.codex/sessions/**/*.jsonl` を読み、履歴(直近300件)と nativeId/cwd を引き継ぐ。以降は通常の会話と同じく resume で続きを話せる。取り込み済みは一覧から消える。元ファイルは読むだけ(変更しない)。一覧に出たファイルしか読まない。

- 絞り込み: 左リスト・取り込み一覧とも「全部/CC/CX」タブ+文字検索。
- AI検索(2026-10-06 作り直し): 取り込み画面で自然文を入れ、Claude Code か Codex を選んで実行。
  1. `data/glossary.txt`(`TBH = TaskBarHero = タスクバーヒーロー` の形式、手で追記可)で略語を確実に展開
  2. AIには**検索キーワードの展開だけ**させる(ツールなし・セッション非保存 `--no-session-persistence` / `--ephemeral`)
  3. 全セッション(取り込み前の全件)の本文(人間の発言+ツール入力のパス/コマンド+フォルダ名)を全文検索。珍しい語ほど高得点(IDF)、全会話の30%超に出る語は無視、英数キーワードは単語境界つき
  - 旧方式(題名80字+フォルダだけをAIに見せて番号を選ばせる)は「TBH」を略語と知らず精度が悪かったので廃止。
  - インデックスは起動直後に裏で作成(mtimeキャッシュ)。初回のみ30秒前後、以降は数秒。
  - 一覧は全件保持(UIは無検索時のみ300件表示)。
- 自動起動: `shell:startup` の `chat-cmd.lnk` → `server-hidden.vbs`(ウィンドウなしでサーバーだけ起動、ポート使用中なら何もしない)。ブラウザは開かない。画面は start.bat か http://127.0.0.1:5178 。解除はその lnk を削除。

- 残量表示(2026-10-07): 左サイドバー下に Claude Code(5時間/7日)と Codex(週)の使用率バー。
  - Claude: `claude -p stream-json` が出す `rate_limit_event`(unifiedWindows.utilization=0〜1)をメッセージ送信のたびに `data/limits.json` へ保存。**CCで送信しないと更新されない**(取得だけの手段はなし)。
  - Codex: `~/.codex/sessions` の最新jsonlの `rate_limits`(used_percent, window_minutes)を読む。60秒ごと+Codex完了時に更新。
  - リセット時刻を過ぎた枠は「リセット済み 0%」表示。70%以上=黄、90%以上=赤。API: `GET /api/limits`。

## 落とし穴
- Git Bash の curl で日本語JSONを送ると Shift-JIS になり文字化けする(テストはnode fetchで)。

## 2026-10-07 追加
- 会話ごとのアイコン: 絵文字 or 画像(96px正方形にリサイズしてdata URLで保存)。設定ダイアログで指定。`icon` フィールド、色(color)は背景色として併用。
- 実行中も送信可: サーバー側で `s.queue` に積み、現在の処理が終わったら全部まとめて1メッセージで自動送信。■停止すると待機分は破棄。リストに「待機N」バッジ。
- 残量表示(左下 #lim)は既存: Claude=実行時のrate_limit_event、Codex=最新セッションログ。
- 左リストの会話を右クリック → メニュー(設定/削除)。
- 左下は「⚙ 設定」ボタン(CC/CXの使用%を併記)。押すと設定ダイアログにトークン残量をカード表示(Claude Code / Codex 別、バー+リセット時刻)。今後の全体設定もここに足す。

## 2026-10-07 Markdown/画像
- 吹き出しは自前Markdownレンダラ(`md()`/`inline()` in index.html): 見出し/太字/斜体/打消し/`==強調==`/`{red|文字}`(色名: red,青,#ff0000等)/コード/リスト/引用/表/リンク(http(s)のみ)/画像/水平線。ANSIカラーも従来どおり。生HTMLは全てエスケープ。
- 画像添付: Ctrl+V貼り付け / ドラッグ&ドロップ / 📎ボタン。`POST /api/upload`(dataURL→`data/images/<uuid>.ext`、20MBまで)、`GET /img/<名前>`で配信。送信時 `images:[名前]` を渡す。
  - Claude: プロンプト末尾に画像の絶対パスを付記(Readツールで見る)。Codex: `--image=<path>` で添付 + パスも付記。
  - メッセージに `images` を保存、クリックで拡大表示。
- 途中で止まる件(2026-10-07): 原因=①サーバー再起動で実行中のAIプロセスが死ぬ(→起動時に「中断されました」表示) ②AIが結果(result/turn.completed)を出さずに終了した場合も従来は無表示だった(→「返答の途中で終了」を表示)。**サーバー再起動は全会話の実行中の返答を切る**ので、会話中の再起動は避ける。
- 待ち時間ゲージ(2026-10-07): 返答中は「入力中… 0:42 / 目安 1:10」+バー(経過÷その会話の直近10回の平均応答時間、上限95%)。平均が無い/超過時は流れるバー。左リストの実行中会話にも細いバー。`startedAt`/`durs`(sessions.json)で保持、正常完了時のみ記録(停止・エラーは除外)。
- 再起動ボタン(2026-10-08): 設定ダイアログ「アプリ」→サーバーを再起動。POST /api/restart(返答中の会話があれば409+確認、force指定で強行)。2秒後にserver-hiddenで再起動し、画面は復帰を待って自動リロード。
- モデル選択(2026-10-08): 会話ごとに `model`。**チャット入力欄の左のプルダウン**で選ぶ(既存モデルのみ: Claude=Fable5.1/Opus5.5/Sonnet5.5/Haiku4.5、Codex=models_cache.jsonの表示可能なもの。空=既定、切替は次の送信から)。Claude=`--model`、Codex=`-m`(候補は ~/.codex/models_cache.json、既定は config.toml)。ヘッダーに実際に使われたモデル(`modelUsed`: claudeはinit/assistantイベントから、codexは指定or既定)を表示。GET /api/models。
- 途切れ対策(2026-10-08): `claude -p` はターン終了でプロセスごと終了し、バックグラウンドのAgent/Bash/Monitorも道連れで落ちる。→ `--append-system-prompt` で「バックグラウンド実行禁止・同期で完了」を毎回指示。根本対策は常駐プロセス(--input-format stream-json)化だが未実装。
- 高速化(2026-10-08): ①ストリーミング表示(claudeは --include-partial-messages の text_delta をSSE `delta` で配信→吹き出しがリアルタイムに伸びる。open時は GET の `live` で復元) ②思考の深さプルダウン(入力欄左 #esel: 既定/low/medium/high/xhigh/max → claude `--effort` / codex `-c model_reasoning_effort`、Codexはmax無し)。codexのライブ表示は未対応(agent_messageは完了時のみ)。
- ★根本対策(2026-10-08): Claudeは**会話ごとの常駐プロセス**に変更(`claude -p --input-format stream-json`、`claudeProc()`)。ターンが終わってもプロセスが生きるので、バックグラウンドのAgent/Bash/Monitorが落ちず、完了通知で自動的に次ターンが始まる(吹き出しとして流れてくる)。2通目以降は起動待ちなし。モデル/思考/権限/フォルダを変えると次の送信で作り直し。未使用30分(バックグラウンド作業中は3時間)で自動終了→次の送信で `--resume` 復帰。■停止はプロセスを殺す(次の送信で復帰)。先の「バックグラウンド禁止の指示」は撤廃。Codexは従来どおり1メッセージ=1プロセス。
- 注意: **サーバー再起動は常駐プロセスも殺す**(返答中だと途切れる)。再起動ボタンは返答中の会話があれば確認を出す。
- トークン節約支援(2026-10-08): ヘッダーに「コンテキスト N万」(直近API呼び出しの入力合計=`ctx`)。入力欄の上に警告(#warn): ①15万超で黄/30万超で赤「新しい会話をおすすめ」 ②ターン終了から5分超&3万超で「キャッシュ切れ→次の送信は重い」。既存会話は起動時にログ末尾から復元(backfillCtx)。新規Claude会話は思考「中」を既定で作成(Codexは設定ファイルの既定=low を尊重)。思考プルダウンはモデルの隣(#esel)。claude設定: 既定モデル=sonnet、effortLevel=medium は opus-5 のみ指定。
- 割り込み送信(2026-10-08): Claude常駐中は返答中の発言をstdinへ直接書き込み(キューしない)→ターミナル同様、進行中のターンに反映(実測: 実行中に「英語だけにして」→反映された)。送信ボタンは「割り込み送信」表示。Codexは従来どおり待機キュー(完了後にまとめて1通)。
- トークン節約(2026-10-08): Claude起動時に CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000(自動compactを20万で発動)+CLAUDE_CODE_PROMPT_CACHE_TTL=1h。キャッシュ切れ警告は60分超に変更。-pモードは/compact不可(公式)。
- MCP: 会話ごと auto(既定:ブラウザ/メール/カレンダー/YouTube/Vercel等の語を検知したら有効化し以後維持)/on/off。無効時は --strict-mcp-config。切替で常駐プロセス作り直し。
- 記憶を整理(2026-10-08): ヘッダー「記憶を整理」→詳細な引き継ぎ資料(9項目)を作らせ、同じチャットのままAIの native 会話だけ新規に入れ替えて資料を送る(画面の履歴は残る)。資料は data/handoffs/ にも保存。
- スマホ接続(2026-10-08): Tailscale(100.x)アドレスでも待受。ローカル以外は合言葉(data/auth.json)必須・5回失敗で60秒ロック。スマホ幅(760px以下)は一覧⇄チャット切替。Tailscaleは未ログインなら60秒毎に自動検出して待受開始。
- 節約追加(2026-10-09): MCP既定OFF時は Claude に `--settings data/no-plugins.json`(Vercelプラグイン無効、実測 初回入力 約4,700トークン減)、Codex に `-c mcp_servers.playwright.enabled=false`。MCP_RE検知でCodexも自動ON。`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`。
- 会話の共有(2026-10-09): 左リスト右クリック or ヘッダー「共有」→「参照をコピー(軽量)」「直近20件」「全文」。参照は `⟦会話:先頭8桁|名前⟧`。別の会話に貼って送信すると、サーバーが `data/shares/<名前>-<id8>.md`(全記録)のパス+直近4件の要点へ展開(全文は入れない。AIが必要時だけRead)。`GET /api/sessions/:id/export?last=N`。スマホ(http)用にclipboard APIが無い場合はexecCommandへフォールバック。
- スマホ: 右スワイプで会話画面が指に追従して一覧が見える(35%/素早い弾きで戻る、左端24pxはiOS標準に任せる)。
- GitHub連携(2026-10-09): ヘッダー「Git」ボタン。`git-ops.js`(git/gh CLIを呼ぶだけ・追加費用なし)。会話の作業フォルダ=リポジトリ。
  - 作成は `gh repo create --private` 固定。作成直後と**プッシュのたびに**`gh repo view`で公開状態を再確認し、PRIVATE以外/確認不能なら中止(fail closed)。
  - ホームフォルダ・ドライブ直下はリポジトリ化禁止。コミット時に秘密情報らしいファイル(.env/auth.json/*.pem/*.key/id_rsa等)と50MB超は中止。`.gitignore`に既定を自動追記(chat-cmd自身は data/ 丸ごと除外)。
  - コミットの作者は gh のログイン名+noreplyメール(個人メールを使わない)。プッシュ/作成は確認ダイアログ。API: GET/POST /api/sessions/:id/git。
- ピン留め(2026-10-09): ①会話: 右クリック「ピン留め」→ `pinned`、一覧の最上部に固定+📌表示。②メッセージ: 吹き出しの時刻横の📌で留める(`pin`、全メッセージに短いid付与)。チャット上部の「📌 ピン留めN件」を開くと一覧→クリックでその位置へスクロール+点滅。API: POST /api/sessions/:id/pin {pinned} または {mid, pinned}。
- フォルダ選択(2026-10-09): 新規/設定ダイアログの作業フォルダ横「選ぶ…」→ドライブ一覧→フォルダをたどる/新しいフォルダ作成/ここを選ぶ。API: GET /api/fs?p= (空=ドライブ一覧)、POST /api/fs/mkdir。読み取り専用で一覧のみ。

## 追記: 画像アイコン / グループ / ドラッグ並べ替え (2026-10-09)
- アイコン: 11会話にGPT image生成のPNG(128px, data/icons/small/)を設定済み。原寸は data/icons/。
- グループ: セッションの `group`(文字列)。右クリック「グループに入れる」か、一覧でドラッグして見出しへドロップ。見出しタップで開閉(localStorage `collapsedGroups`)。
- ドラッグ並べ替え: 一覧の会話をマウスで掴む/タッチは長押し(380ms)で移動。`POST /api/order {ids,id,group}` で `order` を保存。order未設定は上(更新順)、設定済みは order 昇順。
- ※サーバー側(server.js)を変えた時は再起動しないと 新しいAPIが404になる。
- 空グループ: data/groups.json + /api/groups(add/remove/rename)、「＋ グループ」ボタン、見出し右クリックで名前変更/削除
- グループもドラッグで並べ替え可。見出し右クリック(またはスマホは右端の⋯)でアイコン(絵文字/画像)・色・名前変更・削除。data/groups.json={list,meta}
- 一覧の最上位=グループなし会話+グループ見出しを同じ並び(buildTop: ピン→order→更新順)で混在可。グループもピン留め可(meta.pinned)。/api/order は seq:[{s:id}|{g:name}] で全体の順序を保存
- 背景色: セッション s.bg / グループ meta.bg。fgFor()でWCAG相対輝度から文字色を自動(黒/白)。右クリックの『背景色を変更』
- AIアイコン: POST /api/icon-gen(codex画像生成→dataURL、最大2並列/5分)。会話/グループの右クリック『AIでアイコンを生成』+設定ダイアログ『AIで生成』。クライアントで128pxに縮小
- AIアイコン: POST /api/icon-gen(codex画像生成→dataURL、最大2並列/5分)。会話/グループの右クリック『AIでアイコンを生成』+設定ダイアログ『AIで生成』。クライアントで128pxに縮小
- ドラッグ固まり対策(2026-10-09): 押下/ドラッグ中は renderList を保留(dragLock)。再描画で掴んだ要素がDOMから消えると pointerup が届かずゴースト残り+固まる。mouse buttons=0/blur/30秒で強制解除
- メモリモード: data/prefs.json memMode(normal30分/low2分/min15秒)。設定ダイアログ『メモリ』、/api/prefs, /api/free-idle。常駐claude≒250MB/本・server.js自体は約60MB

## アーカイブして新しいチャットへ (2026-10-10)
- 会話の右クリック「📦 アーカイブして新しいチャットへ」→ `POST /api/sessions/:id/archive-continue`。AIに HANDOFF_PROMPT で引き継ぎ資料を作らせ(`_handoff`+`_archive`)、`finishArchive` が全履歴を `data/archive/*.json.gz` に保存 → 同じ設定(名前/アイコン/色/グループ等)の新セッションを作り、資料を最初のメッセージとして自動送信。元の会話は一覧から削除。
- 資料が空なら中止して元の会話を残す。実行中は409。
- 復元: 設定 → アーカイブ → 復元(`/api/archives`, `/api/archives/restore`)。復元時は AI の記憶(nativeId)は空。
- SSE は `handoff`(from→sid) を `deleted` より先に送る(クライアントが新チャットを開くため)。

## 2026-10-11 追加機能メモ
- 作業フォルダを開くボタン(ヘッダー `#fo`): `effCwd(s)`(cwdがホーム/ドライブ直下なら会話中のツールパスから推定した `inferProj`)を explorer で開く
- 完了音: 端末ごと(localStorage `snd`)。種類/タイミング/音量/バイブ。設定→通知
- 履歴は直近80件のみ描画、上スクロールで古い分を遅延読み込み
- GitHubの猫マーク: ヘッダーのチャット名のみ(`.git/config` で判定)。リポジトリ名はAIが提案(`/api/sessions/:id/repo-name`)
- コンテキスト使用率: `result` の `modelUsage.contextWindow` を `s.ctxMax` に保存し「n / max (x%)」表示
- 返信機能: 各メッセージの ↩ で引用ブロックを次の送信に付ける。ピンは視認性UP
- `JP_RULE`: `--append-system-prompt` で常に日本語を指定(作業が長くなると英語になる対策)
- 設定ダイアログはタブ化(使用量/アプリ/通知/アーカイブ)。メモリ・ツールは「アプリ」タブ。最後のタブは localStorage `stab` に記憶

## 2026-10-13 追加メモ
- 名称を V-Cmdango に変更(三色団子アイコン: ヘッダー/favicon/ログイン画面/`icon.ico`。`node make-icon.js` で再生成)。
- ポップアップ切り離し: ヘッダー ⧉ → `?pop=<id>` の別ウィンドウ(PCのみ、スマホ非表示)。ウィンドウを閉じると元に戻る。グローバル関数 `open` は `window.open` を潰すため `openChat` に改名。
- ツール起動: 設定→アプリ→ツールの PowerShell/CMD ボタン → `POST /api/terminal`(ローカルのみ)。
- 使うAI・機能: 設定→アプリ「使うAI・機能」で Claude Code/Codex/Git を 自動(`where` で検出)/表示する/表示しない。`prefs.tools`、`/api/prefs` が `tools` を返す。
- 権限の既定を「safe」に変更(作成/更新/取り込み)。pw-vault ボタンとAPIは削除。
- GitHub: 猫マーク/メニューからリポジトリURLへ(`summary.gh`)。公開用に README.md / LICENSE(MIT) / .gitignore を追加。
- 配布: GitHub(非公開)への招待、または data/ を除いた ZIP。
- MCP確認(2026-10-14): 会話のMCPが「自動」で、送った文に MCP_RE の語が入っていたら、送信前にダイアログ(使う/使わない/送信をやめる + 「今後は確認しない」)。選択は会話の `mcp` に on/off で保存。設定→アプリ「MCPの確認」(`prefs.mcpAsk`, 既定true)で全体のON/OFF。OFFにすると従来どおり検知で自動ON。`/api/prefs` が `mcpAsk` と `mcpRe` を返す。
- 「/」候補(2026-10-14): 入力欄の先頭が `/` のとき、`~/.claude/commands`・`~/.claude/skills`・作業フォルダの `.claude/` 配下のコマンド/スキルを候補表示(↑↓/Tab/Enter/クリックで挿入、Esc で閉じる)。`GET /api/sessions/:id/commands`(Claudeのみ)。組み込みコマンド(/compact 等)は候補に出さない(`claude -p` での動作が不確実なため)。
- 起動失敗の案内/READMEの非公式・自己責任の追記/start.bat の Node 確認(2026-10-14)。
- 認証部分の切り出しとテスト(2026-10-14): `lib/security.js`(isLocalAddr/safeEq/cookieOf/authToken/hostAllowed/originAllowed/tailscaleIp/LoginLimiter/safeId/staticPath)。`node --test test/security.test.js` で12件(依存なし)。server.js はこれを使う。追加の安全対策: ①resume のID(nativeId)は英数字と _ - だけ通す(shell経由起動のため) ②静的ファイルは公開フォルダ内のみ(%2e・バックスラッシュも拒否) ③ログイン失敗の記録が増え続けないよう掃除 ④外部接続の Host は Tailscale の 100.64-127.x と *.ts.net だけ。複製サーバーで ../・%2e%2e・不正Host・他サイトOriginのPOST が 403/404 になるのを実機確認済み。

## 2026-10-16〜17 追加メモ(AI接続管理 / 自動振り分け / 安全化)
- **AI接続管理**: `lib/connections.js`(ストア・DPAPIでキー暗号化・OpenAI互換API・opencode/gemini CLIアダプタ・classify・redact)。設定→「AI接続」タブ、新規チャットで接続+モデル選択。`data/connections.json` / `data/secrets.json`(DPAPI)。セッションは `tool:'ext', conn, native:{}`。API: `/api/connections*`(書込はlocalのみ)。テスト: `node --test test/connections.test.js test/security.test.js`(27件OK、ディレクトリ指定は不可)。
- **未検証**: OpenCode/Gemini CLIは未インストールでモックのみ(stdinでの入力、`-p .`、イベントのフィールド名は仮定)。DeepSeek/Z.aiは実キー未確認。承認UIとツール実行状況表示は未実装。無料モデル名はユーザー提示(DeepSeek V4.1 Flash Free等)を公式で確認できず、OpenCode Zenの `deepseek-v4-flash-free` 等が実在。Z.aiのflash系は無料と未確認(unknown)。
- **🔀 自動振り分け**: モデル選択の `auto`。Claude=親Fable固定+`--append-system-prompt`でAgent model引数(haiku/sonnet/opus)の振り分け指示(shell経由のため空白・記号なし)。Codex=`-m`を付けず既定モデル、指示文を各ターン先頭に付与し、子は `codex exec -m <一覧最後尾>`(安いモデルとみなす推測)。`~/.claude/agents/implementer.md`(sonnet)/`explorer.md`(haiku)も作成。サーバー再起動前は古いコードが `-m auto` を渡してCodexが落ちる。
- **安全化**: 確認は `askOk()`(既定フォーカス=やめる、1.2秒ロック、Enter/Space無効、クリックのみ)。アーカイブ/引き継ぎ/会話削除/再起動のAPIは `Sec-Fetch-Site: same-origin`(画面経由)だけ許可(`uiOnly`)。経緯: 10/17 03:30、チャット内のAIが内部APIを直接叩き確認なしでアーカイブした。偽装は防げない(偶発対策)。
- **不具合修正**: `summary()` に `lineage` を追加(アーカイブ回数が0回表示だった)。
- **相談結果(未実装)**: コンテキスト肥大化→自動実行はせず警告のみ。Claude=ctx≥150k、Codex=ctxMax×0.8。Codexの計測はrollout jsonlの最後の `token_count.last_token_usage.input_tokens`(turn.completedのusageは累計なので不可)。`compact_boundary`(pre/post_tokens, trigger)を表示。引き継ぎ指示文に「実行中のバックグラウンド作業/未保存の編集/直近の失敗」を追加、資料に `## 9.` が無ければ中止。
- **再起動が必要**: 上記のserver.js変更はサーバー再起動後に反映(返答中の会話があると途切れる)。

## 2026-10-17 追加メモ(見た目テーマ / 設定ダイアログ / アーカイブのフォルダ)
- **見た目テーマ**: 設定 → 「見た目」タブ。色4つ(チャット背景/サイドバー・入力欄/自分の吹き出し/相手の吹き出し)+プリセット6種(既定は「いまのまま」=何も上書きしない)、フォント(選択+直接入力)、チャットの文字サイズ、背景の画像/動画(暗さ・ぼかし)。文字色は面の明るさから自動(`fgFor`)。
  - 設定はこの端末の localStorage `theme`(スマホは動画オフ等の使い分けのため端末別)。適用は `<style id="themecss">` が `:root:root{...}` で変数を上書きし、`--metxt/--bottxt/--bgtxt` を追加。背景は `#main` 内の `#bgm`(`z-index:-1` + `#main{isolation:isolate}`)。
  - 背景ファイルだけサーバー: `data/theme/`。`GET/POST /api/theme-bg`、`DELETE /api/theme-bg/<名前>`、`GET /theme-bg/<名前>`(Range対応)。追加・削除は PC本体の画面からだけ(`uiOnly` + `isLocal`)。形式は png/jpg/webp/gif/mp4/webm、500MBまで、先頭バイトで中身を検証(`lib/theme.js`、`test/theme.test.js`)。動画は音なし・ループ、画面が見えないときは一時停止。
  - 検証: テスト31件通過。別ポートのサーバー+Braveの CDP で、アップロード/Range/416/偽装拒否/トラバーサル/削除、テーマ反映(フォント・サイズ・色・背景画像・文字色の自動)、未設定時に従来表示のままなことを確認。**未確認**: 実際の動画の再生、500MB超過時の挙動、スマホ表示。
- **設定ダイアログ**: タブごとに高さが変わり、中央配置のためタブが上下に動いていた。`#sdlg[open]` を上端固定(`margin:4vh auto auto`)+高さ固定(`min(88vh,760px)`)に変更。
- **アーカイブして引き継ぐ**: ホーム直下のチャットは、ツールログのパスから「推定プロジェクト」を表示している(`inferProj`)。新チャットは履歴が空で推定できず、フォルダが解除されたように見えた。`finishArchive` で `cwd: effCwd(s)` を引き継ぐようにした。
- **落とし穴**: オブジェクトリテラルの行末に `//` コメントを書くと、同じ行の後続フィールドまでコメントアウトされる(`node --check` は通る)。コメントは行を分けること。
- **履歴を読んでいる最中に最下部へ飛ぶ不具合(スマホ)**: 新着メッセージ(`msg`)と「入力中…」の作り直し(`setTyping`)が無条件で `bottom()` していた。返答中はイベントが頻繁に来るため、過去を読んでいても戻された。`isNear()`(下端から120px以内)のときだけ追従し、自分の送信(`role:'user'`)は必ず最下部へ。判定は要素を足す前に行う(足した後だと高さが増えて外れる)。検証: 幅390pxのBraveで、上端/途中/下端/強制の4通りを確認。

## 2026-10-17 追加メモ(軽量化 / セキュリティ / モデル選択 / フォントファイル / 左下の制限表示)
- **軽量化**: `/api/sessions` の94%がアイコンのdataURLだった。`lib/iconstore.js` が内容のSHA-256先頭16桁を名前にした `GET /ico/<hash>`(private・1年・immutable)で配る(最大500件、古い順に捨てる)。受け取りは `resolve()` で元データに戻してから保存(`/ico/` の未知URLは無視)。応答は動的=gzip(1KB以上)、静的=br/gzipをキャッシュ+ETag/304(`lib/http.js`)。keep-alive 65秒、`::1` でも待ち受け、Codex残量の読み取りは10秒キャッシュ。
- **セキュリティ(自己点検で直した分)**: 全応答に `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy: no-referrer` / CSP(`default-src 'self'` 基準、script/styleは `'unsafe-inline'`、`img-src` は `data: blob:` まで、`frame-ancestors/base-uri/object-src 'none'`)。本文サイズ上限(JSON 2MB、ログイン4KB、アップロード32MB)は 413。外部URLの `![](http…)` は画像として読み込まず、クリックで開くリンクにする(IP漏えい・追跡の防止)。GitHubリンクのhrefが `true` になっていた不具合も修正。
- **モデル選択の統合**: 新規作成は「AIとモデル」1つの選択に統合(Claude Code / Codex / つないだAI接続を `optgroup` で並べる)。選ぶと内部の `f-tool` と接続が同期、最後の選択は localStorage `aim`。接続は 設定 → AI接続。OpenCode(`opencode run --format json`)は実機で DeepSeek / GLM の無料枠を確認。無料枠は期間限定・IP制限・学習利用の可能性あり、モデル名(V4.1/5.3 等)は公式ドキュメントで未確認。`big-pickle` だけ公式に無料と記載があり `OFFICIAL_FREE` で「無料」表示(接続のモデル一覧は再取得後に反映)。
- **スマホ**: 設定ダイアログのタブが縦に折れていたので横スクロール(`nowrap`)に。
- **フォントをファイルで指定**: 設定 → 見た目 →「フォントファイルを追加…」。ttf/otf/woff/woff2、40MBまで、先頭バイトで検証。`data/theme/<英数字名>-<乱数8桁>.<拡張子>`(日本語のファイル名は `font`)。`GET/POST /api/theme-font`、`DELETE /api/theme-font/<名前>`、`GET /theme-font/<名前>`。追加・削除はPC本体の画面からだけ。使うと `@font-face{font-family:"VCFont"}` を `themecss` に入れ、プルダウン/直接入力より優先(それらを選ぶとファイル指定は外れる)。設定は `theme.fontFile`(端末ごと)。アップロード処理は背景と共通の `receiveFile()`。
- **左下の制限表示**: 設定ボタンの下に CC / CX を1行ずつ、5時間枠と週枠のバー+%で表示(Codexは取れた枠だけ、枠の長さから `5h` / `週` / `n日` と命名。いまのCodex(prolite)は週枠のみ)。70%で橙、90%で赤。取得できないときは「未取得(送信すると表示)」。サイドバー下部が約116px(従来約50px)に伸びる。
- **検証**: テスト41件(connections/security/theme/http)。別ポート+Braveで、フォントのアップロード/配信(バイト一致)/トラバーサル拒否/直接curl拒否、モバイル・デスクトップ表示、コンソールエラーなしを確認。**未確認**: 実スマホ、WOFF2/OTFの実描画、新規作成→送信の通し操作、編集ダイアログ。
- **落とし穴**: bashのヒアドキュメント等で正規表現を書くとバックスラッシュが落ちる(`node --check` は通ることがある)。正規表現を含むコードは Edit/Write で書く。
- チャット上部のボタン整理: 「記憶を整理」ボタン削除(アーカイブで代替)、フォルダはアイコンのみ、並びは ⧉ → 📂 → Git → 共有 → 設定 → 削除(停止は返答中だけ先頭に出る)。スマホは1段目=戻る+題名、2段目=ボタン均等割り。

## 2026-10-17 コード色付け・Markdown指示・yomiyasu同梱

- `public/hl.js`: 外部ライブラリなしのコード色付け(`VCHL.highlight(code, lang)`)。js/ts・C系・py・sh・ps・bat・sql・css・yaml・toml・json・lua・rb・php・html/xml・diff に対応。未知の言語や6万文字超は色なし(エスケープのみ)。使うタグは `<span class="tk-…">` だけ。
- 全体のオンオフ: 設定の「見た目」→「コード色付け」(localStorage `theme.hl`、既定オン)。
- チャットごとの「Markdown指示」(`fmt`、Claudeのみ): `FMT_RULE` を `--append-system-prompt` に足す。Claudeは常駐プロセスなので、切り替えるとプロセスを作り直す(`claudeKey` に含む)。Codex/OpenCodeには渡さない。シェル経由で起動するため、指示文に空白・引用符・`<>|&^%`・半角括弧は入れない。
- 「yomiyasu」(チャットごと、既定オフ、Claude/Codex): `vendor/yomiyasu`(nanaism/yomiyasu v2.0.1、MIT)をプロジェクトの `.claude/skills/yomiyasu`(Claude)または `.agents/skills/yomiyasu`(Codex)へコピー。既にあれば上書きしない。使うには python3 が必要。チャット設定のチェックを外すと、入れたコピー(VENDORED.txt があるもの)だけ消す。自分で置いた同名スキルは消さない。作業フォルダがホーム・ドライブ直下のチャットは、そのフォルダ(F:\.claude/skills 等)に入れる=同じフォルダを使う全チャットで効く(AIの起動フォルダに入れないと読まれないため)。配布時は `vendor/yomiyasu` の LICENSE と UNICODE-LICENSE.txt を残すこと。
- localStorage: `fmt`(新規作成の既定、既定オン)、`yy`(同、既定オフ)。
- 静的配信に `STATIC_MIME` を追加(`.js` を text/javascript で返す。nosniff のため必須)。
- 文字の色(2026-10-17): 吹き出しは {赤:文字} {青:文字} {緑:文字} {黄:文字} でも色が付く(従来の {red|文字} もそのまま)。書式指示(FMT_RULE)でAIに「大事な語は色を付けてよい」と伝える。指示文は shell 経由なので | を使わず : の書き方にした。コードブロック・インラインコードの中は対象外。
- 設定のタブ切り替え(2026-10-17): 切り替え方向(右のタブへ=右から、左へ=左から)に .22秒でスライド+フェードイン。切り替え時に先頭へスクロールし、選んだタブを見える位置へ。prefers-reduced-motion では無効。
- 配布前の整理(2026-10-17): package.json 追加(engines node>=18, os win32, npm test/start)。README に Windows専用・Node18以上・Python3(任意)・Codex(AI生成)を明記。Codexが無い環境では「AIで生成」ボタンを隠す(applyTools)。yomiyasuをオンにしたとき python/py/python3 が無ければ注意を返す(pythonFound)。作業フォルダ欄の例を一般的なパスに変更。
- Claudeのモデル一覧(2026-10-18): 固定IDをやめ、別名 fable/opus/sonnet/haiku(各「最新」)にした。Claude Code が別名を常に最新モデルへ解決するので、新モデルが出ても更新不要(実機で haiku→claude-haiku-5-5 を確認)。保存済みの完全なIDも、一覧に無ければそのまま選択肢に残る。自動振り分けの司令塔は先頭の fable。Codexの一覧は従来どおり models_cache.json から自動。

## UI刷新・通知・会話ごとの背景
- 左上のロゴ/名前を廃止し、`＋新規`/`取り込み`・検索・`すべて|Claude|Codex`(セグメント)に再編。会話ヘッダーと入力欄の選択はセグメント(`.seg`)でまとめた。
- アイコン(`make-icon.js` / favicon)をグラデーションと光沢のある三色団子に刷新。
- 通知タブ: デスクトップ通知(Notification API、安全なコンテキストのみ=127.0.0.1)、返答冒頭の表示、会話ごとの通知オフ(右クリック、localStorage `snd.mute`)。音と通知の両方に効く。
- 背景: 「全体 / この会話だけ」を切替。会話ごとの設定はサーバーの `s.bgm = {media,dim,blur}`(`/rename` で更新、null で全体に戻す)。
- ガラス調(iPhone風): 設定タブと左のフィルターは `.glass`+`.gp`(スライドする半透明つまみ、`movePill`)。ダイアログ・ヘッダー・入力欄・右クリックメニュー・グループ見出し・ツール実行の折りたたみに半透明+`backdrop-filter`。
- 背景の範囲: 「全体」は `#bgg`(画面全体、サイドバーはガラスで透ける)、「この会話だけ」は `#bgm`(チャット部分)。右クリックの「この会話の背景…」から直接開ける。
- 名称を ChatDango に変更(アイコンは吹き出しの中に三色団子。ファビコン/`icon.ico`。`node make-icon.js` で再生成)

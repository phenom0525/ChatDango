# プラグインの書き方

`plugins/名前/` フォルダを作り、中に次の2つを置きます。

**plugin.json**
```json
{
  "name": "ハローサンプル",
  "version": "1.0",
  "description": "プラグインの説明(一覧に出ます)",
  "script": "main.js",
  "style": "style.css"
}
```
`script` と `style` はどちらも省略できます(.js / .css のみ)。

**main.js**(画面の中で動きます)
```js
VC.addButton('hello-btn', '👋', 'ハローサンプル', () => {
  const s = VC.session();
  VC.toast(s ? '今の会話: ' + s.name : '会話が開かれていません');
});
```

## 使えるもの(`VC`)
| 名前 | 内容 |
|---|---|
| `VC.addButton(id, 文字, ヒント, 押したとき)` | ヘッダーにボタンを足す |
| `VC.toast(文字)` | 画面にひとこと表示 |
| `VC.session()` | 今開いている会話(`id` `name` `cwd` など) |
| `VC.api(method, path, body)` | このアプリのAPIを呼ぶ |
| `VC.openWork('git' / 'files' / 'plug')` | 変更・ファイル・プラグイン画面を開く |

## 有効にするには
📂 → 「プラグイン」タブ → 「有効にする」→ 画面を再読み込み。
プラグインは画面内で任意のコードを動かせるので、信頼できるものだけ有効にしてください。見本は `hello/` です。

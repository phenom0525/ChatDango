# サードパーティのソフトウェア

ChatDango は次のソフトウェアを同梱しています。いずれも MIT ライセンスです。各ライセンス全文は、記載の場所にあります。

| 名前 | 場所 | 著作権者 | ライセンス全文 |
|---|---|---|---|
| xterm.js(ブラウザ内ターミナルの描画) | `public/term/xterm.js` `xterm.css` `addon-fit.js` | The xterm.js authors / Christopher Jeffrey | `public/term/xterm.css` 冒頭に MIT 全文 |
| node-pty 1.1.0(ターミナルの疑似端末) | `vendor/node-pty/` | Microsoft Corporation / Christopher Jeffrey | `vendor/node-pty/LICENSE` |
| yomiyasu v2.0.1(日本語の推敲スキル) | `vendor/yomiyasu/` | nanaism | `vendor/yomiyasu/LICENSE` と `UNICODE-LICENSE.txt` |

ターミナル機能は任意です。`vendor/node-pty` と `public/term/` を削除しても、ほかの機能は動きます。

## node-pty に含まれるバイナリ

`vendor/node-pty/prebuilds/win32-x64/` は、npm の `node-pty@1.1.0` に含まれる Windows x64 用のビルド済みファイルです(自分ではビルドしていません)。

| ファイル | 由来 | ライセンス |
|---|---|---|
| `winpty.dll` `winpty-agent.exe` | winpty(Ryan Prichard) | MIT。全文は `vendor/node-pty/LICENSE-winpty` |
| `conpty/` `conpty.node` `pty.node` | node-pty / Microsoft(Windows Terminal の ConPTY 由来) | MIT。全文は `vendor/node-pty/LICENSE` |

'use strict';
// チャット内プレビュー: AIが会話の中で挙げたファイル(画像・PDF・HTML)だけを、画面に表示するために配る。
// 読めるのは「その会話のメッセージに、そのパスが書いてあるもの」だけ。拡張子も限る。AIには何も送らないので、トークンは減らない。
const fs = require('fs');
const path = require('path');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8' };
const MAX_BYTES = 50 * 1024 * 1024;
const extOf = p => { const m = /\.([A-Za-z0-9]{2,4})$/.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; };
const kindOf = p => { const e = extOf(p); return e === 'pdf' ? 'pdf' : e === 'html' || e === 'htm' ? 'html' : MIME[e] ? 'image' : ''; };
const norm = s => String(s).replace(/\\/g, '/').toLowerCase();

// 画面から受け取ったパス(raw)を、会話の文章(texts)に書かれているものに限って、実ファイルのパスにする。{ file, mime, kind, size } か { error, code }
function resolve(raw, cwd, texts) {
  raw = String(raw || '');
  if (!raw || raw.length > 500 || raw.includes('\0')) return { error: 'パスが不正です', code: 400 };
  if (!MIME[extOf(raw)]) return { error: '対応していない形式です(画像・PDF・HTMLのみ)', code: 400 };
  const n = norm(raw);
  if (!texts.some(t => norm(t).includes(n))) return { error: 'この会話に書かれていないファイルは表示できません', code: 403 };
  const abs = path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : '');
  if (!abs) return { error: '作業フォルダが分からないため開けません', code: 404 };
  let real, st;
  try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return { error: 'ファイルが見つかりません', code: 404 }; }
  if (!st.isFile()) return { error: 'ファイルが見つかりません', code: 404 };
  if (!MIME[extOf(real)]) return { error: '対応していない形式です', code: 400 }; // リンク先の拡張子も見る
  if (st.size > MAX_BYTES) return { error: 'ファイルが大きすぎます(50MBまで)', code: 413 };
  return { file: real, mime: MIME[extOf(real)], kind: kindOf(real), size: st.size };
}

// 種類ごとのセキュリティ設定。HTML/SVGは外部通信なし・別オリジン扱いの枠の中でだけ動かす
function headers(r) {
  const h = { 'content-type': r.mime, 'content-length': r.size, 'cache-control': 'no-cache', 'x-frame-options': 'SAMEORIGIN', 'content-disposition': 'inline' };
  if (r.kind === 'html' && r.pv) h['content-security-policy'] = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; sandbox allow-scripts"; // 同じフォルダの中身は読めるが、外への通信はできない
  else if (r.kind === 'html') h['content-security-policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; sandbox allow-scripts";
  else if (r.mime === MIME.svg) h['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox";
  else if (r.kind === 'image') h['content-security-policy'] = "default-src 'none'; frame-ancestors 'self'";
  else h['content-security-policy'] = "frame-ancestors 'self'"; // PDF: ブラウザ内蔵ビューアが動くよう、これだけにする
  return h;
}

// ---- 複数ファイルのHTML(同じフォルダの画像・CSS・JS・別のHTMLを読み込むページ)用 ----
// 会話に書かれたHTMLのフォルダを、署名つきのURL(/pv/<署名>/…)として渡す。その下のファイルだけ、決まった種類に限って読める。
// 枠の中のページはクッキーを送れないので、署名そのものを通行証にする(サーバーの秘密鍵で署名)。
const crypto = require('crypto');
const RES_MIME = { ...MIME, css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
const sign = (secret, dir) => crypto.createHmac('sha256', secret).update('pv:' + dir).digest('base64url').slice(0, 32);
const makeToken = (secret, dir) => Buffer.from(dir, 'utf8').toString('base64url') + '.' + sign(secret, dir);
function parseToken(secret, tok) { // 署名が合えばフォルダのパス、違えば null
  tok = String(tok || ''); const i = tok.lastIndexOf('.'); if (i < 1) return null;
  let dir; try { dir = Buffer.from(tok.slice(0, i), 'base64url').toString('utf8'); } catch { return null; }
  const a = Buffer.from(sign(secret, dir)), b = Buffer.from(tok.slice(i + 1));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && dir ? dir : null;
}
// dir の下の segs(URLを分けて復号した部品)を実ファイルにする。.. ・隠しファイル・リンクでの外への抜け道は断る
function resolveIn(dir, segs) {
  if (!segs.length || segs.length > 12 || segs.some(s => !s || s.startsWith('.') || /[\\/:\0]/.test(s))) return { error: 'パスが不正です', code: 400 };
  const ext = extOf(segs[segs.length - 1]);
  if (!RES_MIME[ext]) return { error: '対応していない形式です', code: 400 };
  let real, root, st;
  try { root = fs.realpathSync(dir); real = fs.realpathSync(path.join(root, ...segs)); st = fs.statSync(real); } catch { return { error: 'ファイルが見つかりません', code: 404 }; }
  if (!st.isFile() || !norm(real).startsWith(norm(root).replace(/\/$/, '') + '/')) return { error: 'ファイルが見つかりません', code: 404 };
  const e2 = extOf(real); if (!RES_MIME[e2]) return { error: '対応していない形式です', code: 400 };
  if (st.size > MAX_BYTES) return { error: 'ファイルが大きすぎます(50MBまで)', code: 413 };
  return { file: real, mime: RES_MIME[e2], kind: kindOf(real), size: st.size, pv: true };
}
const dirOf = file => path.dirname(file);

module.exports = { MIME, RES_MIME, MAX_BYTES, extOf, kindOf, resolve, headers, makeToken, parseToken, resolveIn, dirOf };

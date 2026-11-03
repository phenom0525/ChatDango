'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const pv = require('../lib/preview');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
const png = path.join(dir, 'a.png'), html = path.join(dir, 'r.html'), txt = path.join(dir, 'x.txt');
fs.writeFileSync(png, 'x'); fs.writeFileSync(html, '<p>hi</p>'); fs.writeFileSync(txt, 'secret');

test('会話に書かれたパスだけ読める', () => {
  assert.strictEqual(pv.resolve(png, '', ['できました: ' + png]).kind, 'image');
  assert.strictEqual(pv.resolve(png, '', ['関係ない文章']).code, 403);
});
test('スラッシュ/バックスラッシュと大文字小文字の違いは同じパスとして扱う', () => {
  assert.strictEqual(pv.resolve(png.split(path.sep).join('/'), '', [png.toUpperCase()]).kind, 'image');
});
test('相対パスは作業フォルダ基準', () => {
  assert.strictEqual(pv.resolve('r.html', dir, ['`r.html` を作りました']).kind, 'html');
  assert.strictEqual(pv.resolve('r.html', '', ['r.html']).code, 404);
});
test('対応外の拡張子・存在しないファイル・不正な値は断る', () => {
  assert.strictEqual(pv.resolve(txt, '', [txt]).code, 400);
  assert.strictEqual(pv.resolve(path.join(dir, 'none.png'), '', [path.join(dir, 'none.png')]).code, 404);
  assert.strictEqual(pv.resolve('', '', ['']).code, 400);
  assert.strictEqual(pv.resolve('a\0.png', '', ['a\0.png']).code, 400);
});
test('HTMLは外部通信なしの枠で動かし、PDFは内蔵ビューアを妨げない', () => {
  const h = pv.headers(pv.resolve(html, '', [html]));
  assert.match(h['content-security-policy'], /default-src 'none'/);
  assert.match(h['content-security-policy'], /sandbox allow-scripts/);
  assert.strictEqual(h['x-frame-options'], 'SAMEORIGIN');
  const pdf = path.join(dir, 'd.pdf'); fs.writeFileSync(pdf, '%PDF');
  assert.strictEqual(pv.headers(pv.resolve(pdf, '', [pdf]))['content-security-policy'], "frame-ancestors 'self'");
});

test('署名つきURL: 正しい署名だけ通り、改ざんは断る', () => {
  const tok = pv.makeToken('k1', dir);
  assert.strictEqual(pv.parseToken('k1', tok), dir);
  assert.strictEqual(pv.parseToken('k2', tok), null);
  assert.strictEqual(pv.parseToken('k1', tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A')), null);
  assert.strictEqual(pv.parseToken('k1', 'abc'), null);
});
test('フォルダ内の読み込み: 同じフォルダの画像・CSS・HTMLは読め、外へ出る指定や隠しファイルは断る', () => {
  fs.writeFileSync(path.join(dir, 's.css'), 'p{}'); fs.writeFileSync(path.join(dir, '.env.png'), 'x');
  fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'p2.html'), '<p>2</p>');
  assert.strictEqual(pv.resolveIn(dir, ['s.css']).mime, 'text/css; charset=utf-8');
  assert.strictEqual(pv.resolveIn(dir, ['sub', 'p2.html']).kind, 'html');
  assert.strictEqual(pv.resolveIn(dir, ['..', 'x.png']).code, 400);
  assert.strictEqual(pv.resolveIn(dir, ['.env.png']).code, 400);
  assert.strictEqual(pv.resolveIn(dir, ['x.txt']).code, 400);
  assert.strictEqual(pv.resolveIn(dir, ['a' + String.fromCharCode(92) + 'x.png']).code, 400);
  assert.strictEqual(pv.resolveIn(dir, ['none.png']).code, 404);
  assert.match(pv.headers(pv.resolveIn(dir, ['r.html']))['content-security-policy'], /script-src 'self'/);
});
test('リンクで外のフォルダへ抜けられない', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pvo-')); fs.writeFileSync(path.join(out, 'o.png'), 'x');
  try { fs.symlinkSync(out, path.join(dir, 'lnk'), 'junction'); } catch { return t.skip('リンクを作れない環境'); }
  assert.strictEqual(pv.resolveIn(dir, ['lnk', 'o.png']).code, 404);
});

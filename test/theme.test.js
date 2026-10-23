'use strict';
const test = require('node:test');
const assert = require('node:assert');
const th = require('../lib/theme');

const pad = b => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);

test('extOf: 対応する種類だけ拡張子になる', () => {
  assert.strictEqual(th.extOf('video/mp4'), 'mp4');
  assert.strictEqual(th.extOf('image/jpeg; charset=x'), 'jpg');
  assert.strictEqual(th.extOf('image/svg+xml'), '');
  assert.strictEqual(th.extOf('text/html'), '');
  assert.strictEqual(th.extOf(undefined), '');
});

test('magicOk: 中身が宣言と合うものだけ通す', () => {
  assert.ok(th.magicOk('png', pad([0x89, 0x50, 0x4e, 0x47])));
  assert.ok(th.magicOk('jpg', pad([0xff, 0xd8, 0xff])));
  assert.ok(th.magicOk('gif', pad(Buffer.from('GIF89a'))));
  assert.ok(th.magicOk('webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])));
  assert.ok(th.magicOk('mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)])));
  assert.ok(th.magicOk('webm', pad([0x1a, 0x45, 0xdf, 0xa3])));
  assert.ok(!th.magicOk('png', pad(Buffer.from('<html>'))));
  assert.ok(!th.magicOk('mp4', pad(Buffer.from('MZ'))));
  assert.ok(!th.magicOk('png', Buffer.from([0x89])), '短すぎるものは通さない');
  assert.ok(!th.magicOk('exe', pad([0x4d, 0x5a])));
});

test('NAME_RE: パス区切りや想定外の拡張子は通さない', () => {
  assert.ok(th.NAME_RE.test('3f2a-1b.mp4'));
  assert.ok(!th.NAME_RE.test('../x.mp4'));
  assert.ok(!th.NAME_RE.test('a/b.png'));
  assert.ok(!th.NAME_RE.test('a.svg'));
  assert.ok(!th.NAME_RE.test('a.mp4.part'));
});

test('parseRange', () => {
  assert.strictEqual(th.parseRange('', 100), null);
  assert.strictEqual(th.parseRange('bytes=-', 100), null);
  assert.deepStrictEqual(th.parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepStrictEqual(th.parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepStrictEqual(th.parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(th.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.strictEqual(th.parseRange('bytes=100-', 100), 'bad');
  assert.strictEqual(th.parseRange('bytes=20-10', 100), 'bad');
  assert.strictEqual(th.parseRange('bytes=-0', 100), 'bad');
});

test('フォント: 形式と名前の検証', () => {
  assert.strictEqual(th.fontExtOf('font/woff2'), 'woff2');
  assert.strictEqual(th.fontExtOf('image/png'), '');
  assert.ok(th.fontMagicOk('woff2', Buffer.from('wOF2....')));
  assert.ok(th.fontMagicOk('ttf', Buffer.from([0, 1, 0, 0, 9])));
  assert.ok(!th.fontMagicOk('woff', Buffer.from('wOF2....')));
  assert.ok(!th.fontMagicOk('ttf', Buffer.from('<html>')));
  assert.ok(th.FONT_NAME_RE.test('My-Font-1a2b3c4d.ttf'));
  assert.ok(!th.FONT_NAME_RE.test('a.ttf.part'));
  assert.ok(!th.FONT_NAME_RE.test('../a.ttf'));
  assert.ok(!th.NAME_RE.test('a.ttf'));
});

test('フォント: 保存名の元になる英数字だけを取り出す', () => {
  assert.strictEqual(th.fontSlug('Noto Sans JP.ttf'), 'NotoSansJP');
  assert.strictEqual(th.fontSlug('日本語.otf'), 'font');
  assert.strictEqual(th.fontSlug(''), 'font');
  assert.ok(th.fontSlug('a'.repeat(100) + '.ttf').length <= 24);
});

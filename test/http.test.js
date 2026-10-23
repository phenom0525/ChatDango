'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { Readable } = require('stream');
const H = require('../lib/http');
const { createIconStore } = require('../lib/iconstore');

test('pickEncoding: brotli > gzip、無ければ空', () => {
  assert.strictEqual(H.pickEncoding('gzip, deflate, br'), 'br');
  assert.strictEqual(H.pickEncoding('gzip, deflate'), 'gzip');
  assert.strictEqual(H.pickEncoding('gzip;q=1.0'), 'gzip');
  assert.strictEqual(H.pickEncoding('identity'), '');
  assert.strictEqual(H.pickEncoding(undefined), '');
  assert.strictEqual(H.pickEncoding('brotli-x'), '');
});

test('compressDynamic: 小さいものと非対応は素通し、大きいものはgzipで元に戻る', () => {
  const small = Buffer.from('abc');
  assert.deepStrictEqual(H.compressDynamic(small, 'gzip'), { buf: small, enc: '' });
  const big = Buffer.from('あ'.repeat(5000));
  assert.strictEqual(H.compressDynamic(big, 'identity').enc, '');
  const r = H.compressDynamic(big, 'gzip, br');
  assert.strictEqual(r.enc, 'gzip');
  assert.ok(r.buf.length < big.length);
  assert.ok(zlib.gunzipSync(r.buf).equals(big));
});

test('createStaticCache: 同じファイルは読み直さず、mtimeが変われば作り直す', () => {
  const load = H.createStaticCache();
  let reads = 0, body = Buffer.from('x'.repeat(3000));
  const rd = () => { reads++; return body; };
  const a = load('f', { mtimeMs: 1, size: 3000 }, rd);
  const b = load('f', { mtimeMs: 1, size: 3000 }, rd);
  assert.strictEqual(reads, 1);
  assert.strictEqual(a, b);
  assert.ok(zlib.brotliDecompressSync(a.br).equals(body));
  assert.ok(zlib.gunzipSync(a.gz).equals(body));
  body = Buffer.from('y'.repeat(3000));
  const c = load('f', { mtimeMs: 2, size: 3000 }, rd);
  assert.strictEqual(reads, 2);
  assert.notStrictEqual(c.etag, a.etag);
});

test('notModified', () => {
  assert.ok(H.notModified('"abc"', '"abc"'));
  assert.ok(H.notModified('"zzz", W/"abc"', '"abc"'));
  assert.ok(!H.notModified('"abd"', '"abc"'));
  assert.ok(!H.notModified('', '"abc"'));
});

test('readBody: 上限以内は読める、超えたら413', async () => {
  assert.strictEqual(await H.readBody(Readable.from([Buffer.from('{"a":1}')]), 100), '{"a":1}');
  await assert.rejects(H.readBody(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), 100), e => e.status === 413);
});

const png = 'data:image/png;base64,' + Buffer.from('PNGDATA-1234567890').toString('base64');

test('iconstore: dataURLはURLになり、絵文字はそのまま', () => {
  const s = createIconStore();
  const u = s.urlOf(png);
  assert.match(u, /^\/ico\/[0-9a-f]{16}$/);
  assert.strictEqual(s.urlOf(png), u);
  assert.strictEqual(s.urlOf('🐉'), '🐉');
  assert.strictEqual(s.urlOf(''), '');
  assert.strictEqual(s.urlOf(undefined), '');
  const e = s.get(u.slice(5));
  assert.strictEqual(e.mime, 'image/png');
  assert.strictEqual(e.buf.toString(), 'PNGDATA-1234567890');
});

test('iconstore: resolveで元に戻り、未知のURLはnull、通常の値は素通し', () => {
  const s = createIconStore();
  const u = s.urlOf(png);
  assert.strictEqual(s.resolve(u), png);
  assert.strictEqual(s.resolve('/ico/0123456789abcdef'), null);
  assert.strictEqual(s.resolve('🐉'), '🐉');
  assert.strictEqual(s.resolve(png), png);
  assert.strictEqual(s.resolve('/ico/../../etc'), '/ico/../../etc');
});

test('iconstore: 古いものから捨てて上限を守る', () => {
  const s = createIconStore();
  const first = s.urlOf('data:image/png;base64,' + Buffer.from('n0').toString('base64'));
  for (let i = 1; i <= 500; i++) s.urlOf('data:image/png;base64,' + Buffer.from('n' + i).toString('base64'));
  assert.strictEqual(s.get(first.slice(5)), null);
});

test('compressDynamic: brだけ受け付ける相手にgzipを返さない', () => {
  const big = Buffer.alloc(5000, 'a');
  assert.strictEqual(H.compressDynamic(big, 'br').enc, '');
  assert.strictEqual(H.compressDynamic(big, 'gzip, br').enc, 'gzip');
});

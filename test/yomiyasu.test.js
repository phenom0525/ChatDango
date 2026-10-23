'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const yy = require('../lib/yomiyasu');

// テスト用の最小zip(deflate)を作る
function makeZip(files) {
  const parts = [], cds = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = Buffer.from(name), raw = Buffer.from(text), c = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, c);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(c.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, nb); off += 30 + nb.length + c.length;
  }
  const cdb = Buffer.concat(cds), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cds.length / 2, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yy-'));

test('版の読み取りと比較', () => {
  assert.deepEqual(yy.parseVer('v2.0.1'), [2, 0, 1]);
  assert.equal(yy.parseVer('latest'), null);
  assert.equal(yy.cmpVer('v2.1.0', '2.0.9'), 1);
  assert.equal(yy.cmpVer('2.0.1', 'v2.0.1'), 0);
  assert.equal(yy.cmpVer('1.9.9', '2.0.0'), -1);
});
test('unzipTo: 先頭1階層を外して展開する', () => {
  const d = tmp();
  yy.unzipTo(makeZip({ 'yomiyasu-2.0.1/SKILL.md': 'a', 'yomiyasu-2.0.1/scripts/x.py': 'b' }), d);
  assert.equal(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(d, 'scripts', 'x.py'), 'utf8'), 'b');
});
test('unzipTo: 外へ出るパスや壊れたzipは拒否', () => {
  assert.throws(() => yy.unzipTo(makeZip({ 'r/../../evil.txt': 'x', 'r/a': 'y' }), tmp()));
  assert.throws(() => yy.unzipTo(makeZip({ 'r/a:b': 'x' }), tmp()));
  assert.throws(() => yy.unzipTo(Buffer.from('not a zip'), tmp()));
});
test('versionOf: SKILL.md の version を読む', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: yomiyasu\nmetadata:\n  version: "2.0.1"\n---\n# x');
  assert.equal(yy.versionOf(d), '2.0.1');
  assert.equal(yy.versionOf(tmp()), '');
});

test('cmpVer: 版を読めないときは一致扱いにしない', () => {
  assert.ok(Number.isNaN(yy.cmpVer('', 'v2.0.1')));
});

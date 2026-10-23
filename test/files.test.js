'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const files = require('../lib/files');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdfiles-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'x');

test('safe: 通常のパスは通る', () => {
  assert.ok(files.safe(root, 'a.txt'));
  assert.ok(files.safe(root, 'new/dir.txt'));
});
test('safe: 外へ出る・.git・特殊名は拒否', () => {
  for (const r of ['../x', '..\\x', '.git/config', 'a.txt:stream', 'a.txt.', 'a.txt ', 'C:/Windows'])
    assert.equal(files.safe(root, r), null, r);
});
test('safe: リンクで外へ出るものは拒否', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cdout-'));
  try { fs.symlinkSync(out, path.join(root, 'lnk'), 'junction'); } catch { return t.skip('リンク作成不可'); }
  assert.equal(files.safe(root, 'lnk/y.txt'), null);
});

test('write: 一時ファイルの名前は固定ではなく、保存後に残らない', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-w-'));
  assert.ok(files.write(root, 'a.txt', 'x').ok);
  assert.deepEqual(fs.readdirSync(root), ['a.txt']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('read: UTF-8以外(Shift_JISなど)は、保存で文字化けするため開かない', () => {
  fs.writeFileSync(path.join(root, 'sjis.txt'), Buffer.from([0x82, 0xa0, 0x82, 0xa2]));
  assert.ok(files.read(root, 'sjis.txt').error);
  fs.writeFileSync(path.join(root, 'u8.txt'), 'あいう');
  assert.strictEqual(files.read(root, 'u8.txt').content, 'あいう');
});

test('safe: Windowsの予約名(CON, AUX.txt, NUL など)と8.3短縮名経由の.gitは拒否', () => {
  for (const n of ['CON', 'aux.txt', 'sub/NUL', 'com1.log', 'LPT9']) assert.strictEqual(files.safe(root, n), null, n);
  assert.ok(files.safe(root, 'console.txt'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (process.platform === 'win32') assert.strictEqual(files.safe(root, 'GIT~1/config'), null);
});

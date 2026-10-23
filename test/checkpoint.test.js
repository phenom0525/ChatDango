'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ck = require('../lib/checkpoint');

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const r = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cdck-'));
  g(d, 'init', '-q'); w(d, 'a.txt', 'A1'); w(d, 'sub/b.txt', 'B1'); w(d, '.gitignore', 'ignored.txt\nnode_modules/\n');
  g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'init');
  return d;
}

test('git管理外のフォルダは記録をスキップする', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cdck-no-'));
  const t = await ck.take(d, 'k', 'x');
  assert.ok(t.skip && !t.commit);
});

test('記録 → 変更・追加・削除 → 戻すで、元の状態に戻る', async () => {
  const d = repo();
  const t = await ck.take(d, 's1-m1', '最初');
  assert.ok(t.commit);
  w(d, 'a.txt', 'A2'); fs.rmSync(path.join(d, 'sub/b.txt')); w(d, 'new/c.txt', 'C'); // AIが変更・削除・新規作成
  const p = await ck.preview(d, t.commit);
  assert.deepEqual(p.restore.sort(), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(p.remove, ['new/c.txt']);
  const rs = await ck.restore(d, t.commit, 's1-m1');
  assert.equal(rs.restored, 2); assert.equal(rs.removed, 1);
  assert.equal(r(d, 'a.txt'), 'A1'); assert.equal(r(d, 'sub/b.txt'), 'B1');
  assert.ok(!fs.existsSync(path.join(d, 'new/c.txt')));
});

test('未コミットの変更(未追跡を含む)も記録され、戻せる', async () => {
  const d = repo();
  w(d, 'a.txt', 'WIP'); w(d, 'draft.txt', 'D');
  const t = await ck.take(d, 's2-m1', 'wip');
  w(d, 'a.txt', 'BROKEN'); fs.rmSync(path.join(d, 'draft.txt'));
  await ck.restore(d, t.commit, 's2-m1');
  assert.equal(r(d, 'a.txt'), 'WIP'); assert.equal(r(d, 'draft.txt'), 'D');
});

test('ブランチ・履歴・ステージ状態・作業フォルダの余計な変更を起こさない', async () => {
  const d = repo();
  w(d, 'staged.txt', 'S'); g(d, 'add', 'staged.txt'); w(d, 'untracked.txt', 'U');
  const before = { head: g(d, 'rev-parse', 'HEAD'), br: g(d, 'branch', '--list'), st: g(d, 'status', '--porcelain'), cnt: g(d, 'rev-list', '--all', '--count') };
  const t = await ck.take(d, 's3-m1', 'x');
  assert.ok(t.commit);
  const after = { head: g(d, 'rev-parse', 'HEAD'), br: g(d, 'branch', '--list'), st: g(d, 'status', '--porcelain'), cnt: g(d, 'rev-list', '--all', '--count') };
  assert.deepEqual(after.head, before.head); assert.equal(after.br, before.br); assert.equal(after.st, before.st);
  assert.equal(g(d, 'rev-list', '--branches', '--count'), '1'); // ブランチ上のコミットは増えていない
});

test('.gitignore の対象と、秘密のファイルは記録も復元もしない', async () => {
  const d = repo();
  w(d, 'ignored.txt', 'I'); w(d, 'node_modules/x.js', 'N'); w(d, '.env', 'SECRET=1'); w(d, 'cfg/server.pem', 'PEM');
  const t = await ck.take(d, 's4-m1', 'x');
  const files = g(d, 'ls-tree', '-r', '--name-only', t.commit).split(/\r?\n/);
  assert.ok(!files.some(f => /ignored|node_modules|\.env|\.pem/.test(f)), files.join(','));
  w(d, '.env', 'CHANGED'); w(d, 'ignored.txt', 'CHANGED');
  await ck.restore(d, t.commit, 's4-m1');
  assert.equal(r(d, '.env'), 'CHANGED'); assert.equal(r(d, 'ignored.txt'), 'CHANGED'); // 触れない
});

test('戻す前の状態も記録され、戻しすぎてもやり直せる', async () => {
  const d = repo();
  const t = await ck.take(d, 's5-m1', 'x');
  w(d, 'a.txt', 'A-NEW');
  const rs = await ck.restore(d, t.commit, 's5-m1');
  assert.equal(r(d, 'a.txt'), 'A1');
  await ck.restore(d, rs.undo, 's5-m1b');
  assert.equal(r(d, 'a.txt'), 'A-NEW');
});

test('存在しない記録や不正な値では何も壊さない', async () => {
  const d = repo();
  w(d, 'a.txt', 'KEEP');
  assert.ok((await ck.restore(d, 'deadbeef'.repeat(5), 'k')).error);
  assert.ok((await ck.restore(d, '--force', 'k')).error);
  assert.equal(r(d, 'a.txt'), 'KEEP');
});

test('drop: その会話の記録だけを消す(他の会話は残る)', async () => {
  const d = repo();
  await ck.take(d, 'sid9-m1', 'x'); await ck.take(d, 'sid9-m2', 'y'); await ck.take(d, 'other-m1', 'z');
  assert.equal(await ck.drop(d, 'sid9-'), 2);
  assert.equal(g(d, 'for-each-ref', 'refs/chatdango/'), g(d, 'for-each-ref', 'refs/chatdango/other-*'));
});

test('prune: 古い記録から減らす', async () => {
  const d = repo();
  for (let i = 0; i < 4; i++) { w(d, 'a.txt', 'v' + i); await ck.take(d, 'sp-m' + i, 'x'); }
  const n = await ck.prune(d, 'sp-m', 2);
  assert.equal(n, 2);
  assert.equal(g(d, 'for-each-ref', 'refs/chatdango/').split(/\r?\n/).length, 2);
});

test('ファイル名が git のパス指定記号([a] 等)でも、そのファイルだけを戻す', async () => {
  const d = repo();
  w(d, '[a].txt', 'STAR'); w(d, 'keep.txt', 'K1');
  const t = await ck.take(d, 's9-m1', 'x');
  w(d, '[a].txt', 'STAR2'); w(d, 'keep.txt', 'K2');
  const res = await ck.restore(d, t.commit, 's9-m1');
  assert.ok(!res.error);
  assert.strictEqual(r(d, '[a].txt'), 'STAR');
});

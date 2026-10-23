'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const wtl = require('../lib/worktree');

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdwt-')), d = path.join(root, 'proj'); fs.mkdirSync(d);
  g(d, 'init', '-q', '-b', 'main'); w(d, 'a.txt', 'A1'); w(d, 'b.txt', 'B1'); g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'init');
  return d;
}

test('git管理外・コミットなしでは作れず、理由を返す', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cdwt-no-'));
  assert.match((await wtl.create(d, 'x', 'abcdef123')).error, /gitのフォルダではない/);
  const e = path.join(d, 'empty'); fs.mkdirSync(e); g(e, 'init', '-q', '-b', 'main');
  assert.match((await wtl.create(e, 'x', 'abcdef123')).error, /コミットが1つもありません/);
});

test('作成: 本体の隣に専用フォルダとブランチができ、本体は変わらない', async () => {
  const d = repo(), r = await wtl.create(d, 'ログイン修正 fix', 'abc123456');
  assert.ok(r.wt, r.error);
  assert.ok(r.wt.branch.startsWith('chatdango/'));
  assert.equal(path.dirname(path.dirname(r.wt.path)), path.dirname(d));
  assert.ok(fs.existsSync(path.join(r.wt.path, 'a.txt')));
  assert.equal(g(d, 'branch', '--show-current'), 'main');
  assert.equal(g(d, 'status', '--porcelain'), '');
});

test('worktreeでの作業は本体に影響せず、取り込むと本体に入る', async () => {
  const d = repo(), { wt } = await wtl.create(d, 'feat', 'aaa111222');
  w(wt.path, 'a.txt', 'A-FROM-WT'); w(wt.path, 'new.txt', 'N');
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'A1'); // 分離されている
  const st = await wtl.status(wt); assert.equal(st.ok, true); assert.ok(st.changed >= 2);
  const m = await wtl.merge(wt, 'feat');
  assert.ok(m.ok, m.error);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'A-FROM-WT');
  assert.ok(fs.existsSync(path.join(d, 'new.txt')));
  assert.equal(g(d, 'branch', '--show-current'), 'main');
});

test('2つの会話が同じファイルを触っても、混ざらない', async () => {
  const d = repo(), A = (await wtl.create(d, 'a', 'aaaaaa111')).wt, B = (await wtl.create(d, 'b', 'bbbbbb222')).wt;
  w(A.path, 'a.txt', 'FROM-A'); w(B.path, 'a.txt', 'FROM-B');
  assert.equal(fs.readFileSync(path.join(A.path, 'a.txt'), 'utf8'), 'FROM-A');
  assert.equal(fs.readFileSync(path.join(B.path, 'a.txt'), 'utf8'), 'FROM-B');
});

test('衝突したら中止して、本体を元の状態に戻す', async () => {
  const d = repo(), A = (await wtl.create(d, 'a', 'aaaaaa111')).wt, B = (await wtl.create(d, 'b', 'bbbbbb222')).wt;
  w(A.path, 'a.txt', 'FROM-A'); w(B.path, 'a.txt', 'FROM-B');
  assert.ok((await wtl.merge(A, 'a')).ok);
  const m = await wtl.merge(B, 'b');
  assert.match(m.error, /衝突/); assert.deepEqual(m.conflicts, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'FROM-A');
  assert.equal(g(d, 'status', '--porcelain'), ''); // マージの途中状態が残らない
});

test('本体に未コミットの変更があるときは取り込まない', async () => {
  const d = repo(), { wt } = await wtl.create(d, 'x', 'ccc333444');
  w(wt.path, 'z.txt', 'Z'); w(d, 'a.txt', 'DIRTY');
  assert.match((await wtl.merge(wt, 'x')).error, /未コミット/);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'DIRTY');
});

test('片付け: 未取り込みの作業があれば消さない。force か取り込み後なら消える', async () => {
  const d = repo(), { wt } = await wtl.create(d, 'x', 'ddd444555');
  w(wt.path, 'z.txt', 'Z');
  assert.match((await wtl.remove(wt, false)).error, /取り込んでいない/);
  assert.ok(fs.existsSync(wt.path));
  assert.ok((await wtl.remove(wt, true)).ok);
  assert.ok(!fs.existsSync(wt.path));
  assert.equal(g(d, 'branch', '--list', 'chatdango/*'), '');
});

test('自分で作ったもの以外は消さない(branch名・パスの偽装)', async () => {
  const d = repo();
  assert.equal(await wtl.owned({ base: d, path: d, branch: 'main' }), false);
  assert.equal(await wtl.owned({ base: d, path: d, branch: 'chatdango/x' }), false); // 本体自身は worktree 一覧の「別枠」ではないが、登録名が違えば不可
  const r = await wtl.remove({ base: d, path: d, branch: 'main' }, true);
  assert.ok(fs.existsSync(path.join(d, 'a.txt')));
  assert.ok(r.ok); // 何も消さずに終わる
});

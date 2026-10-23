'use strict';
// worktree 分離: 会話ごとに専用のフォルダとブランチを作り、同じプロジェクトで複数の会話が同時に作業しても混ざらないようにする。
// 会話の作業フォルダ(cwd)を worktree に向けるだけなので、差分・ファイル・ターミナルなどは今のまま動く。
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFIX = 'chatdango/';
const ID = ['-c', 'user.name=ChatDango', '-c', 'user.email=chatdango@localhost', '-c', 'commit.gpgsign=false'];
const run = (cwd, args) => new Promise(resolve => execFile('git', args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 16e6 },
  (e, so, se) => resolve({ ok: !e, out: String(so || '').trim(), err: String(se || (e && e.message) || '').trim() })));

const slug = n => String(n || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'chat';
const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

async function top(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  const r = await run(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.normalize(r.out) : '';
}

// 作る。 { wt:{ path, branch, base, from } } か { error }
async function create(cwd, name, sid) {
  const t = await top(cwd);
  if (!t) return { error: 'gitのフォルダではないため、分離して作業できません(git init したフォルダで使えます)' };
  const head = await run(t, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return { error: 'まだコミットが1つもありません。最初のコミットを作ってから、分離を選んでください' };
  const from = (await run(t, ['branch', '--show-current'])).out;
  if (!from) return { error: 'ブランチが選ばれていない状態(detached HEAD)のため、分離できません' };
  const tag = slug(name) + '-' + String(sid).slice(0, 6), branch = PREFIX + tag;
  const dir = path.join(path.dirname(t), path.basename(t) + '.worktrees', tag);
  if (fs.existsSync(dir)) return { error: '同じ名前の作業フォルダがすでにあります: ' + dir };
  const r = await run(t, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  return r.ok ? { wt: { path: dir, branch, base: t, from } } : { error: r.err };
}

// worktree が本当に自分で作ったものか確かめる(消してよいもの以外は触らない)
async function owned(wt) {
  if (!wt || !wt.base || !wt.path || !wt.branch || !wt.branch.startsWith(PREFIX) || norm(wt.path) === norm(wt.base)) return false; // 本体フォルダ自身は対象外
  const r = await run(wt.base, ['worktree', 'list', '--porcelain']);
  return r.ok && r.out.split(/\r?\n/).some(l => l.startsWith('worktree ') && norm(l.slice(9)) === norm(wt.path));
}

// 状態: { ok, changed(未コミットの数), ahead(本体に未取り込みのコミット数), baseBranch, baseDirty, missing }
async function status(wt) {
  if (!(await owned(wt)) || !fs.existsSync(wt.path)) return { ok: false, missing: true };
  const [st, ah, bb, bd] = await Promise.all([
    run(wt.path, ['status', '--porcelain']), run(wt.base, ['rev-list', '--count', wt.from + '..' + wt.branch]),
    run(wt.base, ['branch', '--show-current']), run(wt.base, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  return { ok: true, changed: st.out ? st.out.split(/\r?\n/).length : 0, ahead: parseInt(ah.out, 10) || 0, baseBranch: bb.out, baseDirty: !!bd.out, from: wt.from, branch: wt.branch };
}

// 本体へ取り込む(衝突したら中止して元に戻す)。 { ok, message } か { error, conflicts }
async function merge(wt, title) {
  const s = await status(wt);
  if (!s.ok) return { error: '作業用フォルダが見つかりません' };
  if (s.baseBranch !== wt.from) return { error: '本体が別のブランチ(' + (s.baseBranch || '不明') + ')になっています。「' + wt.from + '」に戻してから取り込んでください' };
  if (s.baseDirty) return { error: '本体フォルダに未コミットの変更があります。先にコミットするか退避してから、取り込んでください' };
  if (s.changed) { // 作業中の変更をまとめてコミットしてから取り込む
    await run(wt.path, ['add', '-A']);
    const c = await run(wt.path, [...ID, 'commit', '-q', '-m', 'ChatDango: ' + String(title || '会話').slice(0, 60) + ' の作業']);
    if (!c.ok) return { error: 'コミットできませんでした: ' + c.err };
  }
  const m = await run(wt.base, [...ID, 'merge', '--no-ff', '-m', 'Merge ' + wt.branch, wt.branch]);
  if (m.ok) return { ok: true, message: '「' + wt.from + '」に取り込みました' };
  const cf = (await run(wt.base, ['diff', '--name-only', '--diff-filter=U'])).out.split(/\r?\n/).filter(Boolean);
  await run(wt.base, ['merge', '--abort']);
  return { error: '内容が衝突したため、取り込みを中止して元に戻しました', conflicts: cf };
}

// 片付ける(フォルダとブランチを消す)。force なしなら、未取り込みの作業があるときは消さない
async function remove(wt, force) {
  if (!(await owned(wt))) return { ok: true, note: '作業用フォルダはすでにありません' };
  const s = await status(wt);
  if (!force && s.ok && (s.changed || s.ahead)) return { error: '取り込んでいない作業があります(' + (s.changed ? '未コミット' + s.changed + '件' : '') + (s.changed && s.ahead ? '・' : '') + (s.ahead ? '未取り込みコミット' + s.ahead + '件' : '') + ')' };
  const r = await run(wt.base, ['worktree', 'remove', '--force', wt.path]);
  if (!r.ok && fs.existsSync(wt.path)) return { error: r.err };
  await run(wt.base, ['worktree', 'prune']);
  await run(wt.base, ['branch', '-D', wt.branch]);
  return { ok: true };
}

module.exports = { create, status, merge, remove, owned, slug };

'use strict';
// スキルの取得元(GitHub)の記録と、最新版への更新。更新は「更新ボタンを押したとき」だけ。自動では通信しない。
//   取得元の見つけ方: ① スキルのフォルダの .chatdango-source.json(このアプリが書く)
//                     ② フォルダの .git の origin(git で入れたもの)
//                     ③ VENDORED.txt(yomiyasu の公式リリース)  ④ SKILL.md / package.json が申告している GitHub
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { unzipTo } = require('./yomiyasu');
const skills = require('./skills');

const SRC_FILE = '.chatdango-source.json';
const MAX_ZIP = 20 * 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

// GitHub の URL(https://github.com/所有者/リポジトリ、.git つき、/tree/... つき、git@github.com:所有者/リポジトリ.git)→ '所有者/リポジトリ'。GitHub 以外は null
function parseRepo(u) {
  const m = /^(?:(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?(?:[\/?#].*)?$/.exec(String(u || '').trim());
  if (!m || /^\.+$/.test(m[2])) return null;
  const r = m[1] + '/' + m[2];
  return REPO_RE.test(r) ? r : null;
}

// { kind: 'github'|'git'|'release', repo, url, sha?, tag? } か null
function readSource(dir) {
  const mk = (kind, repo, extra) => ({ kind, repo, url: 'https://github.com/' + repo, ...extra });
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, SRC_FILE), 'utf8'));
    if (j && typeof j.repo === 'string' && REPO_RE.test(j.repo)) return mk('github', j.repo, { sha: /^[0-9a-f]{40}$/.test(j.sha) ? j.sha : '', at: String(j.at || '').slice(0, 30), updatedAt: String(j.updatedAt || '').slice(0, 30) });
  } catch {}
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)/.exec(cfg), repo = m && parseRepo(m[1]);
    if (repo) return mk('git', repo, {});
  } catch {}
  try {
    const t = fs.readFileSync(path.join(dir, 'VENDORED.txt'), 'utf8');
    const m = /\(https:\/\/github\.com\/([^\/\s]+\/[^\/\s]+)\/releases\/tag\/(v?[\d.]+)\)/.exec(t);
    if (m && REPO_RE.test(m[1])) return mk('release', m[1], { tag: m[2] });
  } catch {}
  // ④ スキル自身が申告している取得元(SKILL.md の先頭の source / repository / homepage、package.json の repository)。本文中のリンクは参考リンクのことがあるので見ない
  try {
    const head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').split(/^---\s*$/m)[1] || '';
    for (const k of ['source', 'repository', 'repo', 'homepage', 'url']) {
      const m = new RegExp('^\\s*' + k + ':\\s*["\']?([^"\'\\s]+)', 'mi').exec(head), repo = m && parseRepo(m[1]);
      if (repo) return mk('github', repo, { sha: '' });
    }
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), r = j.repository, repo = parseRepo(typeof r === 'string' ? r : r && r.url);
    if (repo) return mk('github', repo, { sha: '' });
  } catch {}
  return null;
}

function writeSource(dir, repo, sha, updatedAt) {
  if (!REPO_RE.test(repo)) throw new Error('取得元が不正です');
  fs.writeFileSync(path.join(dir, SRC_FILE), JSON.stringify({ repo, sha: /^[0-9a-f]{40}$/.test(sha) ? sha : '', at: new Date().toISOString(), ...(updatedAt ? { updatedAt } : {}) }, null, 2));
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ChatDango', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) throw new Error('取得元が見つかりません(非公開か、URLが違います)');
  if (!r.ok) throw new Error('GitHubに接続できませんでした(' + r.status + ')');
  return r.json();
}
// ref(省略で既定ブランチの先頭。短いコミット番号も可)を40桁のコミット番号にする
async function resolveSha(repo, ref) {
  const j = await getJson('https://api.github.com/repos/' + repo + '/commits/' + encodeURIComponent(ref || 'HEAD'));
  if (!/^[0-9a-f]{40}$/.test(j.sha)) throw new Error('最新の版を読めませんでした');
  return j.sha;
}
async function download(repo, sha) {
  const r = await fetch('https://codeload.github.com/' + repo + '/zip/' + sha, { headers: { 'User-Agent': 'ChatDango' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('ダウンロードに失敗しました(' + r.status + ')');
  if (+r.headers.get('content-length') > MAX_ZIP) throw new Error('ファイルが大きすぎます');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_ZIP) throw new Error('ファイルが大きすぎます');
  return buf;
}

// 展開したリポジトリの中から、名前が合うスキルのフォルダを探す(ルート自身・深さ4まで)
function findSkillDir(root, name) {
  const want = String(name).toLowerCase();
  const ok = d => { try { const m = skills.parseMeta(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8')); return String(m.name || path.basename(d)).trim().toLowerCase() === want || path.basename(d).toLowerCase() === want; } catch { return false; } };
  const q = [[root, 0]];
  while (q.length) {
    const [d, n] = q.shift();
    if (ok(d)) return d;
    if (n >= 4) continue;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') q.push([path.join(d, e.name), n + 1]);
  }
  return null;
}

const moveDir = (a, b) => { try { fs.renameSync(a, b); } catch { fs.cpSync(a, b, { recursive: true }); fs.rmSync(a, { recursive: true, force: true }); } };
let busy = false;

// dir のスキルを、GitHub の最新版に入れ替える。元のフォルダは backupRoot に退避する。戻り値 { same } か { updated, sha, backup }
async function updateFromGithub(dir, name, repo, curSha, backupRoot) {
  if (busy) throw new Error('別の更新中です。しばらく待ってからやり直してください');
  busy = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-skillupd-'));
  try {
    const sha = await resolveSha(repo);
    if (curSha && curSha === sha) return { same: true, sha };
    unzipTo(await download(repo, sha), tmp);
    const found = findSkillDir(tmp, name);
    if (!found) throw new Error('取得元に「' + name + '」のスキルが見つかりませんでした');
    if (!skills.measure(found)) throw new Error('大きすぎるため入れ替えできません');
    const parent = path.dirname(dir), stage = path.join(parent, '.chatdango-new-' + path.basename(dir));
    fs.rmSync(stage, { recursive: true, force: true });
    fs.cpSync(found, stage, { recursive: true });
    fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true });
    writeSource(stage, repo, sha, new Date().toISOString());
    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, path.basename(dir) + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
    moveDir(dir, backup);
    try { fs.renameSync(stage, dir); } catch (e) { try { moveDir(backup, dir); } catch {} throw e; }
    return { updated: true, sha, backup };
  } finally { busy = false; fs.rmSync(tmp, { recursive: true, force: true }); }
}

// git で入れたスキル: 早送りできるときだけ取り込む(フックは動かさない)
function pullGit(dir) {
  return new Promise((res, rej) => {
    const noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-nohooks-'));
    execFile('git', ['-c', 'core.hooksPath=' + noHooks, '-C', dir, 'pull', '--ff-only'], { windowsHide: true, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => {
      fs.rmSync(noHooks, { recursive: true, force: true });
      if (e) return rej(new Error('git pull に失敗しました: ' + String(err || e.message).trim().split('\n')[0].slice(0, 200)));
      res({ same: /Already up to date|すでに最新/i.test(out), out: String(out).trim().slice(0, 200) });
    });
  });
}

module.exports = { SRC_FILE, parseRepo, readSource, writeSource, resolveSha, findSkillDir, updateFromGithub, pullGit };

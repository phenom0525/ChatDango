'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const K = require('../lib/skills');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-skills-'));
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test('parseMeta: 1行・引用符・| や > の複数行・続きの行・キー無しを読む', () => {
  assert.deepStrictEqual(K.parseMeta('---\nname: a\ndescription: "あ い"\n---\n本文'), { name: 'a', description: 'あ い' });
  assert.strictEqual(K.parseMeta('---\nname: x\ndescription: |\n  1行目\n  2行目\n\n  3行目\nlicense: MIT\n---').description, '1行目 2行目 3行目');
  assert.strictEqual(K.parseMeta('---\ndescription: >-\n  ab\n  cd\n---').description, 'ab cd');
  assert.strictEqual(K.parseMeta('---\ndescription: 長い説明が\n  次の行に続く\nname: n\n---').description, '長い説明が 次の行に続く');
  assert.strictEqual(K.parseMeta('---\nmetadata:\n  version: "2.0"\nname: n\n---').name, 'n'); // 入れ子のキーは最上位として拾わない
  assert.strictEqual(K.parseMeta('---\r\nname: crlf\r\n---').name, 'crlf');
  for (const bad of ['', 'frontmatterなし', '---\nname: 閉じていない']) assert.deepStrictEqual(K.parseMeta(bad), {}, bad);
});

test('scan / group: 両方のツールの置き場から集め、同じ名前は1行にまとめてタグ(tools)を付ける', () => {
  const home = tmp(), cwd = tmp();
  put(home, '.claude/skills/both/SKILL.md', '---\nname: both\ndescription: 両方\n---');
  put(home, '.agents/skills/both/SKILL.md', '---\nname: both\ndescription: 両方\n---');
  put(home, '.claude/skills/only-claude/SKILL.md', '---\nname: only-claude\ndescription: |\n  クロードだけ\n---');
  put(home, '.codex/skills/only-codex/SKILL.md', '---\nname: only-codex\n---');
  put(home, '.codex/skills/.system/hidden/SKILL.md', '---\nname: hidden\n---');
  put(home, '.claude/skills/no-skill-md/readme.txt', 'x');
  put(cwd, '.claude/skills/proj/SKILL.md', '---\nname: proj\n---');
  const g = K.group(K.scan(home, cwd));
  assert.deepStrictEqual(g.map(x => x.name), ['both', 'only-claude', 'only-codex', 'proj']);
  assert.deepStrictEqual(g.find(x => x.name === 'both').tools, ['claude', 'codex']);
  assert.deepStrictEqual(g.find(x => x.name === 'only-claude').tools, ['claude']);
  assert.strictEqual(g.find(x => x.name === 'only-claude').desc, 'クロードだけ');
  assert.strictEqual(g.find(x => x.name === 'proj').places[0].scope, 'project');
  assert.strictEqual(K.scan(home, null).some(x => x.name === 'proj'), false);
});

test('scan: フォルダへのリンクも拾い、リンク先が消えたものは落ちずに除く', () => {
  const home = tmp(), real = tmp();
  put(real, 'SKILL.md', '---\nname: linked\ndescription: リンク\n---');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  try { fs.symlinkSync(real, path.join(home, '.claude', 'skills', 'linked'), 'junction'); } catch { return; } // 作れない環境では飛ばす
  fs.symlinkSync(path.join(home, 'nowhere'), path.join(home, '.claude', 'skills', 'broken'), 'junction');
  const s = K.scan(home, null);
  assert.deepStrictEqual(s.map(x => x.name), ['linked']);
  assert.ok(s[0].link);
});

test('copySkill: もう一方のツールの置き場へコピーする(個人→個人・作業フォルダ→作業フォルダ)。上書き・同じツール・特殊な名前・大きすぎるものは拒否', () => {
  const home = tmp(), cwd = tmp();
  put(home, '.claude/skills/a/SKILL.md', '---\nname: a\n---');
  put(home, '.claude/skills/a/scripts/run.py', 'print(1)');
  put(home, '.claude/skills/a/.git/config', 'x');
  put(cwd, '.codex/skills/p/SKILL.md', '---\nname: p\n---');
  const ents = K.scan(home, cwd);
  const a = ents.find(x => x.name === 'a'), p = ents.find(x => x.name === 'p');
  const r = K.copySkill(a, home, cwd, 'codex');
  assert.ok(r.ok); assert.strictEqual(r.to, path.join(home, '.agents', 'skills', 'a'));
  assert.ok(fs.existsSync(path.join(r.to, 'scripts', 'run.py')));
  assert.ok(!fs.existsSync(path.join(r.to, '.git')), '.git はコピーしない');
  assert.ok(K.copySkill(a, home, cwd, 'codex').error, '上書きしない');
  assert.ok(K.copySkill(a, home, cwd, 'claude').error, '同じツール');
  const r2 = K.copySkill(p, home, cwd, 'claude');
  assert.strictEqual(r2.to, path.join(cwd, '.claude', 'skills', 'p'));
  assert.ok(K.copySkill({ ...a, dirName: '..' }, home, cwd, 'codex').error);
  assert.ok(K.copySkill({ ...a, dirName: 'a/b' }, home, cwd, 'codex').error);
  assert.ok(K.copySkill(null, home, cwd, 'codex').error);
  const big = tmp(); put(big, '.claude/skills/big/SKILL.md', '---\nname: big\n---');
  for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(big, '.claude/skills/big', 'f' + i + '.txt'), 'x');
  const be = K.scan(big, null)[0];
  assert.match(K.copySkill(be, big, null, 'codex').error, /大きすぎ/);
  assert.ok(!fs.existsSync(path.join(big, '.agents', 'skills', 'big')));
});

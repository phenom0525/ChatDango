'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/skillsrc');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ssrc-'));

test('parseRepo: GitHub の URL だけ通す', () => {
  assert.strictEqual(S.parseRepo('https://github.com/MaryCache/imozuru'), 'MaryCache/imozuru');
  assert.strictEqual(S.parseRepo('https://github.com/a/b.git'), 'a/b');
  assert.strictEqual(S.parseRepo('https://github.com/a/b/tree/main/x'), 'a/b');
  assert.strictEqual(S.parseRepo('git@github.com:a/b.git'), 'a/b');
  for (const bad of ['', null, 'http://github.com/a/b', 'https://evil.com/a/b', 'https://github.com/a', 'https://github.com/a/..', 'https://github.com.evil.com/a/b', 'file:///etc/passwd']) assert.strictEqual(S.parseRepo(bad), null, String(bad));
});

test('writeSource / readSource: 取得元の記録', () => {
  const d = tmp();
  try {
    assert.strictEqual(S.readSource(d), null);
    S.writeSource(d, 'a/b', 'f'.repeat(40));
    const r = S.readSource(d);
    assert.strictEqual(r.kind, 'github'); assert.strictEqual(r.url, 'https://github.com/a/b'); assert.strictEqual(r.sha, 'f'.repeat(40));
    assert.throws(() => S.writeSource(d, '../x', ''));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('readSource: .git の origin と VENDORED.txt', () => {
  const g = tmp(), v = tmp();
  try {
    fs.mkdirSync(path.join(g, '.git'));
    fs.writeFileSync(path.join(g, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/x/y.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    assert.deepStrictEqual([S.readSource(g).kind, S.readSource(g).repo], ['git', 'x/y']);
    fs.writeFileSync(path.join(v, 'VENDORED.txt'), 'yomiyasu v2.0.2 (https://github.com/nanaism/yomiyasu/releases/tag/v2.0.2)\n');
    const r = S.readSource(v);
    assert.deepStrictEqual([r.kind, r.repo, r.tag], ['release', 'nanaism/yomiyasu', 'v2.0.2']);
  } finally { fs.rmSync(g, { recursive: true, force: true }); fs.rmSync(v, { recursive: true, force: true }); }
});

test('readSource: 壊れた記録や不正な repo は無視', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, S.SRC_FILE), '{"repo":"../../etc"}');
    assert.strictEqual(S.readSource(d), null);
    fs.writeFileSync(path.join(d, S.SRC_FILE), 'not json');
    assert.strictEqual(S.readSource(d), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('findSkillDir: 名前の合うスキルを探す', () => {
  const d = tmp();
  try {
    const sk = path.join(d, 'skills', 'foo');
    fs.mkdirSync(sk, { recursive: true });
    fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\nname: foo\ndescription: テスト\n---\n本文');
    assert.strictEqual(S.findSkillDir(d, 'FOO'), sk);
    assert.strictEqual(S.findSkillDir(d, 'bar'), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('readSource: SKILL.md や package.json の申告は読むが、本文のリンクは読まない', () => {
  const a = tmp(), b = tmp(), c = tmp();
  try {
    fs.writeFileSync(path.join(a, 'SKILL.md'), '---\nname: x\nsource: https://github.com/o/r\n---\n本文');
    assert.strictEqual(S.readSource(a).repo, 'o/r');
    fs.writeFileSync(path.join(b, 'package.json'), '{"repository":{"url":"git+https://github.com/p/q.git"}}');
    fs.writeFileSync(path.join(c, 'SKILL.md'), '---\nname: y\n---\n参考: https://github.com/z/z');
    assert.strictEqual(S.readSource(c), null);
    assert.strictEqual(S.readSource(b).repo, 'p/q');
  } finally { for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true }); }
});

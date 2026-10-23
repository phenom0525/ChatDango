'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/tasks');

const P = (p, pp, n, mb, t, c) => ({ p, pp, n, w: mb * 1048576, t, c: String(c) });
// 1(サーバー) → 10(cmd: チャットA の本体) → 11(claude) → 12(node) / 20(cmd: チャットB) / 99(無関係)
const list = [P(1, 0, 'node', 50, 0, 100), P(10, 1, 'cmd', 5, 0, 200), P(11, 10, 'claude', 400, 1e7, 210), P(12, 11, 'node', 100, 2e7, 220), P(20, 1, 'cmd', 5, 0, 300), P(99, 4, 'chrome', 900, 0, 5)];

test('parseProcs: JSONを読む(1件だけのオブジェクト・壊れた入力・不正な行は捨てる)', () => {
  const j = '[{"p":5,"pp":1,"n":"node.exe","w":1048576,"t":10,"c":"123"},{"p":"x"},null,{"p":-1,"pp":0}]';
  assert.deepStrictEqual(T.parseProcs(j), [{ p: 5, pp: 1, n: 'node', w: 1048576, t: 10, c: '123', i: 0 }]);
  assert.strictEqual(T.parseProcs('{"p":5,"pp":1,"n":"a","w":0,"t":0,"c":"1"}').length, 1);
  for (const bad of ['', 'null', 'not json', '5']) assert.deepStrictEqual(T.parseProcs(bad), [], bad);
});

test('descendants: 子孫だけ。自分自身(exclude)と無関係なプロセスは入らない。循環しても止まる', () => {
  assert.deepStrictEqual(T.descendants(list, 10).map(x => x.p), [11, 12]);
  assert.deepStrictEqual(T.descendants(list, 10, 12).map(x => x.p), [11]);
  assert.deepStrictEqual(T.descendants(list, 1).map(x => x.p).sort((a, b) => a - b), [10, 11, 12, 20]);
  assert.strictEqual(T.descendants([P(1, 2, 'a', 1, 0, 1), P(2, 1, 'b', 1, 0, 1)], 1).length, 1);
});

test('summarize: チャットごとにメモリを合計し、CPUは前回との差分から出す', () => {
  const first = T.summarize(list, [{ sid: 'A', pid: 10 }, { sid: 'B', pid: 20 }], null, 0, 4, 1);
  assert.strictEqual(first.chats[0].mb, 505);
  assert.strictEqual(first.chats[0].cpu, null);
  assert.deepStrictEqual(first.chats[0].procs.map(x => x.name), ['claude', 'node', 'cmd']);
  const later = list.map(x => x.p === 12 ? { ...x, t: x.t + 2e7 } : x); // 2秒で2秒分のCPU = 1コア相当 = 4コア中 25%
  const r = T.summarize(later, [{ sid: 'A', pid: 10 }], first.next, 2, 4, 1);
  assert.strictEqual(r.chats[0].cpu, 25);
  assert.strictEqual(r.chats[0].procs.find(x => x.pid === 12).cpu, 25);
  assert.strictEqual(T.summarize(list, [{ sid: 'Z', pid: 777 }], null, 0, 4, 1).chats[0].procs.length, 0); // 本体が消えていても落ちない
});

test('canStop: 子孫で起動時刻が一致するものだけ止められる(本体・サーバー自身・無関係・PID使い回しは拒否)', () => {
  assert.ok(T.canStop(list, 10, 12, '220', 1));
  assert.ok(T.canStop(list, 10, 11, 210, 1));
  assert.ok(!T.canStop(list, 10, 12, '999', 1), '起動時刻が違う(PIDが使い回された)');
  assert.ok(!T.canStop(list, 10, 12, '', 1), '起動時刻なし');
  assert.ok(!T.canStop(list, 10, 10, '200', 1), '本体は対象外');
  assert.ok(!T.canStop(list, 10, 1, '100', 1), 'サーバー自身');
  assert.ok(!T.canStop(list, 10, 20, '300', 1), '別チャット');
  assert.ok(!T.canStop(list, 10, 99, '5', 1), '無関係');
  assert.ok(!T.canStop(list, 10, 'x', '1', 1) && !T.canStop(list, 10, -3, '1', 1) && !T.canStop(list, 10, 1.5, '1', 1));
});

test('実機: プロセス一覧が取れて、自分自身が含まれる(Windowsのみ)', { skip: process.platform !== 'win32' }, async () => {
  const l = await T.listProcs();
  assert.ok(l.length > 10);
  const me = l.find(x => x.p === process.pid);
  assert.ok(me && me.c && me.w > 0, '自分自身の起動時刻・メモリが取れていない');
});

test('実機: 親の下の孫プロセスを、canStop で確かめてから taskkill で止められる(Windowsのみ)', { skip: process.platform !== 'win32' }, async () => {
  const { spawn, execFileSync } = require('child_process');
  // 親(root) → 子 → 孫(60秒眠るだけ)
  const fs = require('fs'), path = require('path'), os = require('os');
  const chain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-chain-')), 'chain.js'); // 引数の数だけ自分自身を孫へ起動して、60秒眠る
  fs.writeFileSync(chain, "const { spawn } = require('child_process'); const n = +process.argv[2]; if (n > 0) spawn(process.execPath, [__filename, String(n - 1)], { stdio: 'ignore' }); setTimeout(() => {}, 60000);");
  const root = spawn(process.execPath, [chain, '2'], { stdio: 'ignore', windowsHide: true });
  try {
    let list, kids = [];
    const find = () => { const child = kids.find(k => k.pp === root.pid && k.n === 'node'); return child && kids.find(k => k.pp === child.p && k.n === 'node'); }; // conhost などの補助プロセスは数えない
    for (let i = 0; i < 20 && !find(); i++) { await new Promise(r => setTimeout(r, 400)); list = await T.listProcs(); kids = T.descendants(list, root.pid, process.pid); }
    const grand = find();
    assert.ok(grand, '孫が見つからない');
    assert.ok(T.canStop(list, root.pid, grand.p, grand.c, process.pid));
    assert.ok(!T.canStop(list, root.pid, grand.p, grand.c + '1', process.pid));
    execFileSync('taskkill', ['/pid', String(grand.p), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const after = await T.listProcs(true);
    assert.ok(!after.some(x => x.p === grand.p), '孫が止まっていない');
    assert.ok(after.some(x => x.p === root.pid), '親まで止まってしまった');
  } finally { try { execFileSync('taskkill', ['/pid', String(root.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
});

test('groupAll: 名前ごとにまとめ、CPU%・メモリ・I/Oを出す。Windows本体と自分・親は終了不可', () => {
  const Q = (p, pp, n, mb, t, c, i) => ({ p, pp, n, w: mb * 1048576, t, c: String(c), i });
  const l = [Q(4, 0, 'System', 1, 0, 1, 0), Q(100, 4, 'cmd', 5, 0, 2, 0), Q(200, 100, 'node', 50, 0, 3, 0), Q(300, 4, 'chrome', 400, 0, 4, 0), Q(301, 300, 'chrome', 600, 0, 5, 0), Q(302, 4, 'svchost', 30, 0, 6, 0)];
  const prev = new Map(l.map(x => [x.p + ':' + x.c, { t: x.t, i: x.i }]));
  const l2 = l.map(x => x.p === 300 ? { ...x, t: 1e7 * 2, i: 2097152 } : x.p === 301 ? { ...x, t: 1e7 } : x); // 2秒間に、300が2秒分・301が1秒分のCPU時間(4コア)
  const r = T.groupAll(l2, prev, 2, 4, 200, 8 * 1073741824);
  const ch = r.groups.find(g => g.name === 'chrome');
  assert.strictEqual(r.groups[0].name, 'chrome'); // CPU順
  assert.strictEqual(ch.n, 2); assert.strictEqual(ch.mb, 1000);
  assert.strictEqual(ch.cpu, 37.5); // (2+1)/2秒/4コア
  assert.strictEqual(ch.io, 1048576);
  assert.strictEqual(r.total.cpu, 37.5); assert.strictEqual(r.total.mb, 1086);
  assert.strictEqual(r.groups.find(g => g.name === 'svchost').prot, true);
  assert.strictEqual(r.groups.find(g => g.name === 'System').prot, true);
  assert.strictEqual(r.groups.find(g => g.name === 'node').prot, true, '自分自身');
  assert.strictEqual(r.groups.find(g => g.name === 'cmd').prot, true, '自分を起動した親');
  assert.strictEqual(ch.prot, false);
  assert.ok(T.canStopAny(l2, 300, '4', 200));
  assert.ok(!T.canStopAny(l2, 300, '41', 200), '起動時刻が違う(PID使い回し)');
  assert.ok(!T.canStopAny(l2, 4, '1', 200) && !T.canStopAny(l2, 302, '6', 200) && !T.canStopAny(l2, 200, '3', 200) && !T.canStopAny(l2, 100, '2', 200));
  assert.ok(!T.canStopAny(l2, 999, '1', 200) && !T.canStopAny(l2, -1, '1', 200) && !T.canStopAny(l2, 300, '', 200));
  assert.strictEqual(T.groupAll(l, null, 0, 4, 200, 0).total.cpu, 0, '初回は0');
});

test('groupAll: 性能カウンタ(タスクマネージャーと同じ元データ)があれば、CPU・プライベートメモリ・I/Oをそのまま使う', () => {
  const Q = (p, pp, n, c, extra) => ({ p, pp, n, w: 900 * 1048576, t: 0, c: String(c), i: 0, ...extra });
  const l = [Q(1, 0, 'a', 1, { pc: 200, pw: 100 * 1048576, pi: 2048 }), Q(2, 0, 'a', 2, { pc: 40, pw: 50 * 1048576, pi: 1024 }), Q(3, 0, 'b', 3, {})];
  const r = T.groupAll(l, null, 0, 8, 999, 1 << 33);
  const a = r.groups.find(g => g.name === 'a');
  assert.strictEqual(a.cpu, 30); // (200+40)/8コア
  assert.strictEqual(a.mb, 150); // 作業セット900MBではなくプライベート
  assert.strictEqual(a.io, 3072);
  assert.strictEqual(r.groups.find(g => g.name === 'b').mb, 900, 'カウンタが無いものは従来の値');
  assert.deepStrictEqual(T.parseProcs('[{"p":5,"pp":1,"n":"x","w":1,"t":1,"c":"1","pc":12.5,"pw":2048,"pi":null}]')[0].pw, 2048);
  assert.strictEqual('pw' in T.parseProcs('[{"p":5,"pp":1,"n":"x","w":1,"t":1,"c":"1","pc":null,"pw":null}]')[0], false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const S = require('../lib/sysstat');

const cpus = (...p) => p.map(([idle, busy]) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }));

test('cpuPct: 差分から使用率を出す(前回が無い・コア数が違うときは null)', () => {
  assert.strictEqual(S.cpuPct(null, cpus([0, 0])), null);
  assert.strictEqual(S.cpuPct(cpus([0, 0]), cpus([50, 50])), 50);
  assert.strictEqual(S.cpuPct(cpus([0, 0], [0, 0]), cpus([100, 0], [0, 100])), 50);
  assert.strictEqual(S.cpuPct(cpus([0, 0]), cpus([0, 0])), null);
  assert.strictEqual(S.cpuPct(cpus([0, 0]), cpus([0, 0], [0, 0])), null);
  assert.strictEqual(S.cpuPct(cpus([0, 0]), cpus([100, 0])), 0);
});

test('appCpuPct: CPU時間の増え分 ÷ 経過秒 ÷ コア数。足りない値や減った値で壊れない', () => {
  assert.strictEqual(S.appCpuPct(10, 12, 2, 4), 25);   // 2秒で2秒分 = 1コア相当 = 4コア中25%
  assert.strictEqual(S.appCpuPct(10, 10, 2, 4), 0);
  assert.strictEqual(S.appCpuPct(10, 5, 2, 4), 0);     // 子プロセスが終了して合計が減った
  assert.strictEqual(S.appCpuPct(10, 99, 2, 4), 100);  // 上限
  assert.strictEqual(S.appCpuPct(null, 1, 2, 4), null);
  assert.strictEqual(S.appCpuPct(1, 2, 0, 4), null);
});

test('parseLine: 「全体GPU;アプリGPU;CPU秒;メモリMB;名前=MB,…」を読む。NAや不正な値は null', () => {
  const r = S.parseLine('12.4;3.0;45.60;812;node=300,claude=480,powershell=32\r');
  assert.deepStrictEqual(r, { gpu: 12, appGpu: 3, appCpuSec: 45.6, appMemMB: 812, procs: [{ name: 'claude', mb: 480 }, { name: 'node', mb: 300 }, { name: 'powershell', mb: 32 }] });
  assert.strictEqual(S.parseLine('250.0;0.0;1.00;5;').gpu, 100);
  assert.deepStrictEqual(S.parseLine('0;0;0;5;').procs, []);
  assert.deepStrictEqual(S.parseLine('0;0;0;5;a=1,bad,=3,x=y').procs, [{ name: 'a', mb: 1 }]);
  for (const bad of ['NA', '', '1;2;3', '1;2;3;4', '1;2;x;4;', '-5;0;0;1;', '1e3;0;0;1;']) assert.strictEqual(S.parseLine(bad), null, bad);
});

test('parseDisks: ドライブ一覧のJSONを読む(1台だけのオブジェクト・壊れた入力・不正な文字でも落ちない)', () => {
  const d = S.parseDisks('[{"d":"d","label":"データ","type":"SSD","total":100,"free":40},{"d":"C","label":"","type":"HDD","total":10,"free":1},{"d":"..","type":"SSD"},{"d":"E","type":"Unspecified"}]');
  assert.deepStrictEqual(d.map(x => x.d + ':' + x.type), ['C:HDD', 'D:SSD', 'E:']);
  assert.strictEqual(d[1].label, 'データ');
  assert.strictEqual(S.parseDisks('{"d":"F","type":"ssd","total":1,"free":1}')[0].type, 'SSD');
  for (const bad of ['', 'null', 'not json', '5', '[null]']) assert.deepStrictEqual(S.parseDisks(bad), [], bad);
});

test('実機: スクリプトが全体・アプリ分の値とメモリを返す(Windowsのみ)', { skip: process.platform !== 'win32' }, async () => {
  const s = S.create(); s.sample();
  let r;
  await new Promise(res => { let n = 0; const t = setInterval(() => { r = s.sample(); if ((r.gpu !== null && r.appCpu !== null && r.mem.app !== null) || ++n > 30) { clearInterval(t); res(); } }, 500); });
  s.stop();
  console.log('# 実測', JSON.stringify({ cpu: r.cpu, gpu: r.gpu, appCpu: r.appCpu, appGpu: r.appGpu, mem: r.mem }));
  assert.ok(r.mem.total > 0 && r.mem.used > 0 && r.mem.used <= r.mem.total);
  for (const k of ['gpu', 'appCpu', 'appGpu']) assert.ok(r[k] === null || (r[k] >= 0 && r[k] <= 100), k);
  assert.ok(r.appCpu !== null, 'アプリ分のCPUが取れていない');
  assert.ok(r.mem.app > 0 && r.mem.procs.length > 0 && r.mem.procs.some(p => p.name === 'node'), 'アプリ分のメモリの内訳が取れていない');
});

test('実機: 子プロセス(CPUを使い続けるもの)の分が、アプリのCPUに入る(Windowsのみ)', { skip: process.platform !== 'win32' }, async () => {
  const kid = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true });
  const s = S.create(); s.sample();
  let best = 0;
  await new Promise(res => { let n = 0; const t = setInterval(() => { const x = s.sample(); if (x.appCpu !== null) best = Math.max(best, x.appCpu); if (best > 0 || ++n > 40) { clearInterval(t); res(); } }, 500); });
  s.stop(); kid.kill();
  console.log('# 子プロセス込みのアプリCPU(%):', best);
  assert.ok(best > 0, '子プロセスのCPU消費が数えられていない');
});

test('実機: ストレージの一覧が取れて、容量の整合が取れている(Windowsのみ)', { skip: process.platform !== 'win32' }, async () => {
  const s = S.create(); s.sample();
  let r;
  await new Promise(res => { let n = 0; const t = setInterval(() => { r = s.sample(); if (r.disks.length || ++n > 40) { clearInterval(t); res(); } }, 500); });
  s.stop();
  console.log('# ストレージ:', r.disks.map(x => x.d + ':' + (x.type || '?') + ' ' + Math.round(x.free / 1e9) + '/' + Math.round(x.total / 1e9) + 'GB').join(' '));
  assert.ok(r.disks.length > 0, 'ドライブが1台も取れていない');
  for (const x of r.disks) assert.ok(x.total > 0 && x.free >= 0 && x.free <= x.total, x.d);
});

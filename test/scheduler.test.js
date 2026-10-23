'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { make } = require('../lib/scheduler');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sch-')), 'schedules.json');

test('時刻指定: 同じ分に二重実行しない・曜日指定を守る', async () => {
  const calls = []; const s = make(tmp(), async x => { calls.push(x.prompt); return 'ok'; });
  const r = s.add({ sid: 'a', prompt: 'こんにちは', mode: 'time', time: '09:30', days: [1] }); // 月曜のみ
  assert.ok(r.ok);
  const mon = new Date(2026, 9, 19, 9, 30, 5).getTime(), tue = new Date(2026, 9, 20, 9, 30, 5).getTime();
  await s.tick(tue); assert.equal(calls.length, 0);
  await s.tick(mon); await s.tick(mon + 10000); assert.equal(calls.length, 1);
  assert.equal(s.list()[0].lastResult, 'ok');
});
test('間隔指定: 作った直後は実行せず、間隔が過ぎたら実行', async () => {
  const calls = []; const s = make(tmp(), async () => { calls.push(1); });
  s.add({ sid: 'a', prompt: 'x', mode: 'every', every: 10 });
  const t = Date.now();
  await s.tick(t + 60000); assert.equal(calls.length, 0);
  await s.tick(t + 11 * 60000); assert.equal(calls.length, 1);
});
test('入力チェックと無効化・削除・保存', async () => {
  const f = tmp(); const calls = []; const s = make(f, async () => { calls.push(1); });
  assert.ok(s.add({ sid: 'a', prompt: '', mode: 'time', time: '09:00' }).error);
  assert.ok(s.add({ sid: 'a', prompt: 'x', mode: 'time', time: '25:00' }).error);
  assert.ok(s.add({ sid: 'a', prompt: 'x', mode: 'every', every: 1 }).error);
  const id = s.add({ sid: 'a', prompt: 'x', mode: 'time', time: '08:00' }).item.id;
  s.toggle(id, false); await s.tick(new Date(2026, 9, 19, 8, 0, 1).getTime()); assert.equal(calls.length, 0);
  assert.equal(make(f, async () => {}).list().length, 1); // 再読み込みしても残る
  assert.ok(s.remove(id)); assert.equal(s.list().length, 0);
});

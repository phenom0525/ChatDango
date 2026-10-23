'use strict';
// プロンプトの予約実行。決めた時刻(毎日/曜日指定)か、一定間隔で、指定した会話へ自動でメッセージを送る。
// サーバーが止まっている間の分は実行しない(動いている間だけ)。
const fs = require('fs');
const path = require('path');

const MAX_PROMPT = 4000, MAX_ITEMS = 50;
const pad = n => String(n).padStart(2, '0');
const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function make(file, fire) {
  let items = [];
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j)) items = j.filter(x => x && x.id && x.sid && x.prompt); } catch {}
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(items, null, 1)); } catch {} };
  const list = () => items.map(x => ({ ...x }));

  function add(b) {
    if (items.length >= MAX_ITEMS) return { error: '予約が多すぎます(' + MAX_ITEMS + '件まで)' };
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return { error: 'プロンプトが空です' };
    if (prompt.length > MAX_PROMPT) return { error: 'プロンプトが長すぎます(' + MAX_PROMPT + '字まで)' };
    if (!b.sid) return { error: '会話を選んでください' };
    const it = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sid: String(b.sid), prompt, enabled: true, created: Date.now(), last: 0, lastKey: '', lastResult: '' };
    if (b.mode === 'every') {
      const m = Math.round(Number(b.every));
      if (!(m >= 5 && m <= 1440)) return { error: '間隔は5〜1440分で指定してください' };
      it.every = m; it.last = Date.now(); // 作った時点から数える(すぐには実行しない)
    } else {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return { error: '時刻は HH:MM で指定してください' };
      it.time = b.time;
      it.days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(d => d >= 0 && d <= 6))] : [];
    }
    items.push(it); save(); return { ok: true, item: { ...it } };
  }
  const remove = id => { const n = items.length; items = items.filter(x => x.id !== id); if (items.length !== n) save(); return items.length !== n; };
  const toggle = (id, on) => { const x = items.find(i => i.id === id); if (!x) return false; x.enabled = !!on; save(); return true; };
  const forget = sid => { const n = items.length; items = items.filter(x => x.sid !== sid); if (items.length !== n) save(); }; // 会話を消したら予約も消す

  async function run(x, now, key) {
    x.last = now; if (key) x.lastKey = key;
    try { x.lastResult = (await fire(x)) || ''; } catch (e) { x.lastResult = '失敗: ' + (e.message || e); }
    save();
  }
  // 1分に数回呼ぶだけでよい。時刻指定は同じ分に二重実行しない
  async function tick(nowMs) {
    const now = new Date(nowMs || Date.now()), hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
    for (const x of items) {
      if (!x.enabled) continue;
      if (x.every) { if (now.getTime() - x.last >= x.every * 60000) await run(x, now.getTime()); continue; }
      const key = dayKey(now) + ' ' + hm;
      if (x.time === hm && x.lastKey !== key && (!x.days || !x.days.length || x.days.includes(now.getDay()))) await run(x, now.getTime(), key);
    }
  }
  return { list, add, remove, toggle, forget, tick, run: async id => { const x = items.find(i => i.id === id); if (!x) return false; await run(x, Date.now()); return true; } };
}
module.exports = { make, MAX_PROMPT };

'use strict';
// プラグイン: plugins/<名前>/plugin.json と、そこから指す script / style を画面へ読み込む仕組み。
// 既定ではすべて「無効」。PC本体の画面で明示的に有効にしたものだけ読み込む。
// プラグインは画面内で任意のコードを実行できる(会話・ファイル操作APIも呼べる)ので、信頼できるものだけ入れること。
const fs = require('fs');
const path = require('path');

const ID = /^[A-Za-z0-9._-]{1,60}$/;
const FILE = /^[\w.\-\/]{1,120}\.(js|css)$/;

function make(dir, stateFile) {
  const readState = () => { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return Array.isArray(j.enabled) ? j.enabled.filter(x => ID.test(x)) : []; } catch { return []; } };
  const writeState = en => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ enabled: en }, null, 1)); };
  const okFile = (id, f) => typeof f === 'string' && FILE.test(f) && !f.includes('..') && fs.existsSync(path.join(dir, id, f));

  function list() {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const en = new Set(readState()), out = [];
    for (const e of ents) {
      if (!e.isDirectory() || !ID.test(e.name)) continue;
      let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'plugin.json'), 'utf8')); } catch { continue; }
      out.push({
        id: e.name, name: String(m.name || e.name).slice(0, 60), description: String(m.description || '').slice(0, 300), version: String(m.version || '').slice(0, 20),
        script: okFile(e.name, m.script) ? m.script : '', style: okFile(e.name, m.style) ? m.style : '', enabled: en.has(e.name),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }
  function setEnabled(id, on) {
    if (!ID.test(id || '') || !list().some(p => p.id === id)) return false;
    const en = new Set(readState()); on ? en.add(id) : en.delete(id); writeState([...en]); return true;
  }
  const isEnabled = id => ID.test(id || '') && readState().includes(id);
  return { list, setEnabled, isEnabled };
}
module.exports = { make, ID };

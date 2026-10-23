// ブラウザ内ターミナル(任意機能)。public/term と vendor/node-pty を消せば完全に元へ戻る。
(async () => {
  let st;
  try { st = await (await fetch('/api/term/status')).json(); } catch { return; }
  if (!st || !st.available || !st.local) return; // 部品なし or PC本体以外では出さない
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'term/term.css'; document.head.appendChild(css);
  const xcss = document.createElement('link'); xcss.rel = 'stylesheet'; xcss.href = 'term/xterm.css'; document.head.appendChild(xcss);

  const pane = document.createElement('div'); pane.id = 'tpane'; pane.hidden = true;
  pane.innerHTML = '<div id="thead"><b>ターミナル</b><span id="ttabs"></span><span id="tcwd"></span><span style="flex:1"></span><button id="tnew" title="新しいターミナル(この会話のフォルダで)">＋</button><button id="tbig" title="大きさを切り替え">⤢</button><button id="tx" title="このターミナルを終了">×</button></div><div id="tterm"></div>';
  $('warn').after(pane);
  const btn = document.createElement('button'); btn.id = 'tbtn'; btn.title = 'ターミナル(PowerShell)'; btn.textContent = '＞_';
  $('gt').after(btn);

  const loadJs = src => new Promise((ok, ng) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ng(new Error(src)); document.head.appendChild(s); });
  let libs = null;
  const ensureLibs = () => libs || (libs = loadJs('term/xterm.js').then(() => loadJs('term/addon-fit.js')));

  const terms = new Map(); // 会話id -> [{ id, el, term, fit, es, q }]
  const active = new Map(); // 会話id -> 表示中のターミナルidx
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => {});

  async function create(sid) {
    await ensureLibs();
    const el = document.createElement('div'); el.className = 'tt'; $('tterm').appendChild(el);
    const term = new Terminal({ fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: 'transparent' }, allowTransparency: true });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
    pane.hidden = false; term.open(el); try { fit.fit(); } catch {}
    const r = await (await fetch('/api/term/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, cols: term.cols, rows: term.rows }) })).json();
    if (!r.id) { el.remove(); term.dispose(); toast(r.error || 'ターミナルを開けませんでした'); return null; }
    const t = { id: r.id, cwd: r.cwd, el, term, fit, sid, chain: Promise.resolve(), buf: '' };
    t.es = new EventSource('/api/term/' + r.id + '/stream');
    t.es.onmessage = e => { const b = atob(e.data), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); term.write(u); };
    t.es.addEventListener('exit', () => { t.es.close(); term.write('\r\n\x1b[90m[ターミナルは終了しました]\x1b[0m\r\n'); t.dead = true; });
    term.onData(d => { if (t.dead) return; t.buf += d; if (t.buf.length === d.length) t.chain = t.chain.then(async () => { await Promise.resolve(); const x = t.buf; t.buf = ''; if (x) await post('/api/term/' + t.id + '/input', { d: x }); }); });
    term.attachCustomKeyEventHandler(e => { if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) return false; return true; }); // 選択中のCtrl+Cはコピー
    const list = terms.get(sid) || []; list.push(t); terms.set(sid, list); active.set(sid, list.length - 1);
    const ro = new ResizeObserver(() => fitNow(t)); ro.observe(el); t.ro = ro;
    return t;
  }
  function fitNow(t) { if (!t.el.offsetWidth) return; try { t.fit.fit(); post('/api/term/' + t.id + '/resize', { cols: t.term.cols, rows: t.term.rows }); } catch {} }

  function show() {
    const list = terms.get(cur) || [];
    pane.hidden = !list.length;
    btn.classList.toggle('on', !!list.length);
    for (const [sid, l] of terms) l.forEach((t, i) => { t.el.style.display = (sid === cur && i === (active.get(sid) ?? 0)) ? '' : 'none'; });
    const t = list[active.get(cur) ?? 0];
    $('tcwd').textContent = t ? t.cwd : '';
    // タブ(この会話のターミナル一覧)
    const tb = $('ttabs'); tb.innerHTML = '';
    list.forEach((x, i) => { const b = document.createElement('button'); b.className = 'ttab' + (i === (active.get(cur) ?? 0) ? ' on' : ''); b.textContent = (i + 1) + ': PS'; b.title = x.cwd; b.onclick = () => { active.set(cur, i); show(); x.term.focus(); }; tb.appendChild(b); });
    if (t) requestAnimationFrame(() => { fitNow(t); });
  }
  btn.onclick = async () => {
    if (!cur) return toast('先に会話を開いてください');
    const list = terms.get(cur) || [];
    if (list.length && !pane.hidden) { pane.hidden = true; btn.classList.remove('on'); return; } // 隠すだけ(終了しない)
    if (list.length) { show(); const t = list[active.get(cur) ?? 0]; t && t.term.focus(); return; }
    const t = await create(cur); if (t) { show(); t.term.focus(); }
  };
  $('tnew').onclick = async () => { if (!cur) return; const t = await create(cur); if (t) { show(); t.term.focus(); } };
  $('tbig').onclick = () => { pane.classList.toggle('big'); show(); };
  $('tx').onclick = async () => {
    const list = terms.get(cur) || [], i = active.get(cur) ?? 0, t = list[i]; if (!t) return;
    post('/api/term/' + t.id + '/close'); try { t.es.close(); t.ro.disconnect(); t.term.dispose(); } catch {} t.el.remove();
    list.splice(i, 1); active.set(cur, Math.max(0, list.length - 1)); if (!list.length) terms.delete(cur); show();
  };
  let last = null;
  setInterval(() => { if (cur !== last) { last = cur; show(); } }, 300);
  window.addEventListener('beforeunload', () => {}); // サーバー側は残る(再読込しても履歴は保持されるが、画面側は新しく開き直し)
})();

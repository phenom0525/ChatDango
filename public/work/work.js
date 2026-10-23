// 作業パネル(変更の確認・コミット / ファイルの閲覧・編集)。public/work を消し index.html の script 行を外せば元へ戻る。
(() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'work/work.css'; document.head.appendChild(css);

  const dlg = document.createElement('dialog'); dlg.id = 'wk';
  dlg.innerHTML = '<div id="wk-top"><div class="seg" id="wk-tabs"><button data-t="git">変更</button><button data-t="files">ファイル</button><button data-t="stats">統計</button><button data-t="issues">Issues</button><button data-t="sched">予約</button><button data-t="plug">プラグイン</button></div><span id="wk-root"></span><button id="wk-ex" title="作業フォルダをエクスプローラーで開く(サーバーのPC上)">エクスプローラーで開く</button><span style="flex:1"></span><button id="wk-x" title="閉じる">×</button></div>' +
    '<div id="wk-body"><div id="wk-side"></div><div id="wk-main"></div></div><div id="wk-foot"></div>';
  document.body.appendChild(dlg);
  const $w = id => dlg.querySelector(id);
  let gen = 0; // 古い読み込み結果が新しい画面を上書きしないための番号
  let sid = null, tab = 'git', fcur = { path: '', file: null, mtime: 0, edit: false, dirty: false };

  const gapi = (action, extra) => api('POST', '/api/sessions/' + sid + '/git', Object.assign({ action }, extra));
  const fapi = q => api('GET', '/api/sessions/' + sid + '/files?' + q);

  function setTab(t) {
    if (fcur.dirty && !confirm('保存していない変更があります。破棄しますか？')) return;
    fcur.dirty = false; tab = t; gen++;
    dlg.querySelectorAll('#wk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    $w('#wk-main').innerHTML = '<div class="wk-empty">左の一覧から選んでください</div>';
    $w('#wk-foot').innerHTML = ''; $w('#wk-root').textContent = '';
    if (t === 'git') loadGit(); else if (t === 'files') loadDir(fcur.path || ''); else if (t === 'stats') loadStats(); else if (t === 'issues') loadIssues(); else if (t === 'sched') loadSched(); else loadPlug();
  }

  // ---- 変更 ----
  async function loadGit() {
    const g = gen, side = $w('#wk-side'), foot = $w('#wk-foot'); side.innerHTML = '<div class="wk-empty">読み込み中…</div>'; foot.innerHTML = '';
    let r; try { r = await gapi('files'); } catch (e) { side.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (!r.ok) { side.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    $w('#wk-root').textContent = r.top;
    if (!r.files.length) side.innerHTML = '<div class="wk-empty">変更はありません</div>';
    else {
      side.innerHTML = r.files.map((f, i) => '<div class="wk-it" data-i="' + i + '"><b class="st st' + esc(f.st[0]) + '">' + esc(f.st) + '</b><span>' + esc(f.path) + '</span>' + (f.secret ? '<em title="秘密情報らしい">🔑</em>' : '') + '</div>').join('') + (r.more ? '<div class="wk-empty">多いので先頭500件のみ</div>' : '');
      side.querySelectorAll('.wk-it').forEach(el => el.onclick = () => { side.querySelectorAll('.wk-it').forEach(x => x.classList.remove('on')); el.classList.add('on'); showDiff(r.files[+el.dataset.i].path); });
    }
    foot.innerHTML = '<input id="wk-msg" placeholder="コミットメッセージ(空なら自動)" ' + (r.files.length ? '' : 'disabled') + '><button id="wk-c" ' + (r.files.length ? '' : 'disabled') + '>コミット</button><button id="wk-cp" ' + (r.files.length ? '' : 'disabled') + '>コミットしてプッシュ</button>';
    const after = async res => { if (res && res.ok) loadGit(); };
    $w('#wk-c').onclick = async () => after(await gitCall(cur_(), { action: 'commit', message: $w('#wk-msg').value }));
    $w('#wk-cp').onclick = async () => { if (confirm('全ての変更をコミットして、GitHub(非公開)へプッシュします。よろしいですか？')) after(await gitCall(cur_(), { action: 'commit-push', message: $w('#wk-msg').value })); };
  }
  const cur_ = () => sessions.find(x => x.id === sid);
  async function showDiff(p) {
    const m = $w('#wk-main'), g = ++gen; m.innerHTML = '<div class="wk-empty">読み込み中…</div>';
    let r; try { r = await gapi('diff', { path: p }); } catch (e) { if (g === gen) m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (!r.ok) { m.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    const lines = (r.diff || '(差分なし)').split('\n').map(l => {
      const c = l.startsWith('+') && !l.startsWith('+++') ? 'ad' : l.startsWith('-') && !l.startsWith('---') ? 'de' : l.startsWith('@@') ? 'hk' : /^(diff |index |---|\+\+\+|新規)/.test(l) ? 'mt' : '';
      return '<div class="dl ' + c + '">' + (esc(l) || ' ') + '</div>';
    }).join('');
    m.innerHTML = '<div class="wk-fn">' + esc(p) + '</div><div class="wk-diff">' + lines + '</div>';
  }

  // ---- ファイル ----
  async function loadDir(p) {
    const g = gen, side = $w('#wk-side'); $w('#wk-foot').innerHTML = ''; side.innerHTML = '<div class="wk-empty">読み込み中…</div>';
    let r; try { r = await fapi('path=' + encodeURIComponent(p)); } catch (e) { side.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (r.error) { side.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    fcur.path = r.path; $w('#wk-root').textContent = r.root;
    const up = r.path ? '<div class="wk-it" data-up="1"><b>↑</b><span>' + esc(r.path.split('/').slice(0, -1).join('/') || '(最上位)') + '</span></div>' : '';
    side.innerHTML = '<div class="wk-fn">' + esc('/' + r.path) + '</div>' + up + r.entries.map((e, i) => '<div class="wk-it" data-i="' + i + '"><b>' + (e.dir ? '📁' : '📄') + '</b><span>' + esc(e.name) + '</span></div>').join('');
    const u = side.querySelector('[data-up]'); if (u) u.onclick = () => loadDir(r.path.split('/').slice(0, -1).join('/'));
    side.querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
      const e = r.entries[+el.dataset.i], full = (r.path ? r.path + '/' : '') + e.name;
      if (e.dir) { if (!fcur.dirty || confirm('保存していない変更があります。破棄しますか？')) { fcur.dirty = false; loadDir(full); } return; }
      if (fcur.dirty && !confirm('保存していない変更があります。破棄しますか？')) return;
      side.querySelectorAll('.wk-it').forEach(x => x.classList.remove('on')); el.classList.add('on'); openFile(full);
    });
  }
  async function openFile(f) {
    const m = $w('#wk-main'), g = ++gen; m.innerHTML = '<div class="wk-empty">読み込み中…</div>'; fcur.dirty = false;
    let r; try { r = await fapi('read=1&path=' + encodeURIComponent(f)); } catch (e) { m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (r.error) { m.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    fcur.file = f; fcur.mtime = r.mtime; fcur.text = r.content;
    const lang = (f.match(/\.(\w+)$/) || [])[1] || '';
    m.innerHTML = '<div class="wk-fn">' + esc(f) + '<span style="flex:1"></span><button id="wk-ed">編集</button><button id="wk-sv" hidden>保存</button></div><pre class="wk-code"><code></code></pre><textarea id="wk-ta" spellcheck="false" hidden></textarea>';
    const code = m.querySelector('code'), ta = $w('#wk-ta');
    try { code.innerHTML = window.VCHL ? VCHL.highlight(r.content, lang) : esc(r.content); } catch { code.textContent = r.content; }
    $w('#wk-ed').onclick = () => {
      fcur.edit = !fcur.edit; ta.hidden = !fcur.edit; m.querySelector('.wk-code').hidden = fcur.edit; $w('#wk-sv').hidden = !fcur.edit; $w('#wk-ed').textContent = fcur.edit ? '閲覧に戻る' : '編集';
      if (fcur.edit) { ta.value = fcur.text; ta.focus(); } else if (fcur.dirty) { fcur.text = ta.value; code.innerHTML = window.VCHL ? VCHL.highlight(fcur.text, lang) : esc(fcur.text); }
    };
    ta.oninput = () => { fcur.dirty = true; $w('#wk-sv').textContent = '保存 *'; };
    const save = async () => {
      if (!fcur.edit) return;
      const res = await api('POST', '/api/sessions/' + sid + '/files', { path: f, content: ta.value, base: fcur.mtime });
      if (res.ok) { fcur.mtime = res.mtime; fcur.text = ta.value; fcur.dirty = false; $w('#wk-sv').textContent = '保存'; toast('保存しました'); } else alert(res.error || '保存に失敗しました');
    };
    $w('#wk-sv').onclick = save; ta.onkeydown = e => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
    fcur.edit = false;
  }

  // ---- 統計 ----
  const fmtB = n => n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB';
  async function loadStats() {
    const m = $w('#wk-main'), g = gen; $w('#wk-side').innerHTML = ''; m.innerHTML = '<div class="wk-empty">数えています…</div>';
    let r; try { r = await fapi('stats=1'); } catch (e) { m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (r.error) { m.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    $w('#wk-root').textContent = r.root;
    const max = Math.max(1, ...r.types.map(t => t.lines || t.files));
    m.innerHTML = '<div class="wk-stats"><div class="wk-cards"><div><b>' + r.files.toLocaleString() + '</b>ファイル</div><div><b>' + r.lines.toLocaleString() + '</b>行</div><div><b>' + fmtB(r.bytes) + '</b>合計サイズ</div></div>' +
      (r.cut ? '<div class="wk-warn">ファイルが多いため途中までの集計です</div>' : '') +
      '<div class="wk-gh">種類ごと(行数順)</div>' + r.types.map(t => '<div class="wk-bar"><span class="n">.' + esc(t.ext) + '</span><i style="width:' + Math.max(2, Math.round((t.lines || t.files) / max * 100)) + '%"></i><span class="v">' + t.files + 'ファイル / ' + t.lines.toLocaleString() + '行</span></div>').join('') +
      '<div class="wk-gh">大きいファイル</div>' + r.largest.map(f => '<div class="wk-row"><span>' + esc(f.path) + '</span><em>' + fmtB(f.size) + '</em></div>').join('') +
      '<div class="wk-gh">最近変更したファイル</div>' + r.recent.map(f => '<div class="wk-row"><span>' + esc(f.path) + '</span><em>' + new Date(f.mtime).toLocaleString('ja-JP') + '</em></div>').join('') +
      '<div class="wk-gh">(.git・node_modules・vendor・dist などは数えていません)</div></div>';
  }

  // ---- Issues ボード ----
  const COLS = [['todo', '未着手'], ['doing', '進行中'], ['done', '完了']];
  async function loadIssues() {
    const m = $w('#wk-main'), g = gen; $w('#wk-side').innerHTML = ''; m.innerHTML = '<div class="wk-empty">読み込み中…</div>';
    let r; try { r = await gapi('issues'); } catch (e) { m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    if (!r.ok) { m.innerHTML = '<div class="wk-empty">' + esc(r.error) + '</div>'; return; }
    m.innerHTML = '<div class="wk-fn">GitHub Issues<span style="flex:1"></span><button id="wk-in">＋ 新しいIssue</button><button id="wk-ir">更新</button></div><div class="wk-board">' +
      COLS.map(([k, n]) => '<div class="wk-col" data-col="' + k + '"><div class="wk-ch">' + n + ' <small>' + r.cards.filter(c => c.col === k).length + '</small></div>' +
        r.cards.filter(c => c.col === k).map(c => '<div class="wk-card" draggable="true" data-n="' + c.number + '"><a href="' + esc(c.url) + '" target="_blank" rel="noopener">#' + c.number + '</a> ' + esc(c.title) + (c.labels.length ? '<div class="wk-lb">' + c.labels.map(l => '<span>' + esc(l) + '</span>').join('') + '</div>' : '') + '<div class="wk-mv">' + COLS.filter(([x]) => x !== k).map(([x, nn]) => '<button data-n="' + c.number + '" data-to="' + x + '">→' + nn + '</button>').join('') + '</div></div>').join('') + '</div>').join('') + '</div>';
    const mv = async (n, to) => { const x = await gapi('issue-move', { number: n, col: to }); if (!x.ok) alert(x.error || '失敗しました'); loadIssues(); };
    m.querySelectorAll('button[data-to]').forEach(b => b.onclick = () => mv(b.dataset.n, b.dataset.to));
    m.querySelectorAll('.wk-card').forEach(c => c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.n));
    m.querySelectorAll('.wk-col').forEach(c => { c.ondragover = e => e.preventDefault(); c.ondrop = e => { e.preventDefault(); const n = e.dataTransfer.getData('text/plain'); if (n && !c.querySelector('.wk-card[data-n="' + n + '"]')) mv(n, c.dataset.col); }; });
    $w('#wk-ir').onclick = loadIssues;
    $w('#wk-in').onclick = async () => { const t = prompt('Issueのタイトル'); if (!t) return; const x = await gapi('issue-create', { title: t }); if (!x.ok) alert(x.error || '失敗しました'); else toast(x.message); loadIssues(); };
  }

  // ---- 予約(プロンプトのスケジューラー) ----
  const DAYN = ['日', '月', '火', '水', '木', '金', '土'];
  async function loadSched() {
    const m = $w('#wk-main'), g = gen; $w('#wk-side').innerHTML = ''; m.innerHTML = '<div class="wk-empty">読み込み中…</div>';
    let r; try { r = await api('GET', '/api/schedules'); } catch (e) { m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    if (g !== gen) return;
    const when = x => x.every ? x.every + '分ごと' : (x.days && x.days.length ? x.days.map(d => DAYN[d]).join('') + ' ' : '毎日 ') + x.time;
    const rows = r.items.map(x => '<div class="wk-pl"><div><b>' + esc(x.name) + '</b> <small>' + esc(when(x)) + (x.enabled ? '' : ' (停止中)') + '</small><div class="wk-pd">' + esc(x.prompt.slice(0, 160)) + '</div><div class="wk-pd">' + (x.last ? '前回: ' + new Date(x.last).toLocaleString('ja-JP') + ' ' + esc(x.lastResult || '') : 'まだ実行していません') + '</div></div><div class="wk-act"><button data-a="run" data-id="' + x.id + '">今すぐ</button><button data-a="toggle" data-id="' + x.id + '" data-on="' + (x.enabled ? 0 : 1) + '">' + (x.enabled ? '停止' : '再開') + '</button><button data-a="delete" data-id="' + x.id + '">削除</button></div></div>').join('');
    m.innerHTML = '<div class="wk-fn">プロンプトの予約実行</div><div class="wk-warn">⚠ 予約したプロンプトは、その会話の権限設定のまま自動で送られます。サーバーが動いている間だけ実行されます。</div>' +
      '<div class="wk-form"><div class="wk-gh">この会話に予約を追加</div><textarea id="sc-p" rows="3" placeholder="送るプロンプト(例: 今日の変更をまとめてコミットして)"></textarea>' +
      '<div class="wk-line"><select id="sc-m"><option value="time">時刻</option><option value="every">間隔</option></select><input id="sc-t" type="time" value="09:00"><input id="sc-e" type="number" min="5" max="1440" value="60" hidden><span id="sc-eu" hidden>分ごと</span>' +
      '<span id="sc-d">' + DAYN.map((n, i) => '<label><input type="checkbox" value="' + i + '">' + n + '</label>').join('') + '</span><span style="flex:1"></span><button id="sc-add">追加</button></div><div class="wk-pd">曜日を選ばなければ毎日です。</div></div>' +
      (rows || '<div class="wk-empty">予約はありません</div>');
    const sync = () => { const ev = $w('#sc-m').value === 'every'; $w('#sc-t').hidden = ev; $w('#sc-d').hidden = ev; $w('#sc-e').hidden = !ev; $w('#sc-eu').hidden = !ev; };
    $w('#sc-m').onchange = sync; sync();
    $w('#sc-add').onclick = async () => {
      const pr = $w('#sc-p').value.trim(); if (!pr) return alert('プロンプトを入力してください');
      if (!confirm('「' + (cur_() ? cur_().name : '') + '」に、このプロンプトを自動で送ります。よろしいですか？')) return;
      const x = await api('POST', '/api/schedules', { sid, prompt: pr, mode: $w('#sc-m').value, time: $w('#sc-t').value, every: $w('#sc-e').value, days: [...m.querySelectorAll('#sc-d input:checked')].map(i => i.value) });
      if (x.error) alert(x.error); else { toast('予約しました'); loadSched(); }
    };
    m.querySelectorAll('button[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a; if (a === 'delete' && !confirm('この予約を削除しますか？')) return;
      if (a === 'run' && !confirm('いま会話にこのプロンプトを送ります。よろしいですか？')) return;
      const x = await api('POST', '/api/schedules/' + b.dataset.id + '/' + a, { on: b.dataset.on === '1' }); if (!x.ok) alert('失敗しました'); loadSched();
    });
  }

  // ---- プラグイン ----
  const GUIDE = `<details class="wk-guide" open><summary>プラグインの書き方(見本)</summary>
<p>plugins/<b>名前</b>/ フォルダに、次の2つを置きます。見本は plugins/hello/ にあります。</p>
<div class="wk-gh">plugin.json</div><pre>{
  "name": "ハローサンプル",
  "version": "1.0",
  "description": "一覧に出る説明",
  "script": "main.js"
}</pre>
<div class="wk-gh">main.js(画面の中で動きます)</div><pre>VC.addButton('hello-btn', '👋', 'ハロー', () => {
  const s = VC.session();
  VC.toast(s ? '今の会話: ' + s.name : '会話が開かれていません');
});</pre>
<div class="wk-gh">使えるもの(VC)</div><ul><li><code>VC.addButton(id, 文字, ヒント, 押したとき)</code> ヘッダーにボタンを足す</li><li><code>VC.toast(文字)</code> ひとこと表示</li><li><code>VC.session()</code> 今開いている会話</li><li><code>VC.api(method, path, body)</code> このアプリのAPIを呼ぶ</li><li><code>VC.openWork('git' / 'files' / 'plug')</code> この画面を開く</li></ul>
<p>style に .css を指定すると見た目も変えられます。有効にしたら、画面を再読み込みすると反映されます。</p></details>`;
  async function loadPlug() {
    const side = $w('#wk-side'), m = $w('#wk-main'); side.innerHTML = ''; m.innerHTML = '<div class="wk-empty">読み込み中…</div>';
    let r; try { r = await api('GET', '/api/plugins'); } catch (e) { m.innerHTML = '<div class="wk-empty">' + esc(e.message) + '</div>'; return; }
    const rows = r.plugins.map(p => '<div class="wk-pl"><div><b>' + esc(p.name) + '</b> <small>' + esc(p.version) + '</small><div class="wk-pd">' + esc(p.description) + '</div></div><button data-id="' + esc(p.id) + '" data-on="' + (p.enabled ? 0 : 1) + '">' + (p.enabled ? '無効にする' : '有効にする') + '</button></div>').join('');
    m.innerHTML = '<div class="wk-fn">プラグイン(plugins フォルダに入れたもの)</div><div class="wk-warn">⚠ プラグインはこの画面の中で自由にプログラムを動かせます。作者を信頼できるものだけ有効にしてください。</div>' + (rows || '<div class="wk-empty">plugins フォルダにプラグインはありません。</div>') + GUIDE;
    m.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
      if (b.dataset.on === '1' && !confirm('このプラグインを有効にします。プラグインは画面内で任意のコードを実行できます。信頼できる場合のみ続けてください。')) return;
      const x = await api('POST', '/api/plugins/toggle', { id: b.dataset.id, on: b.dataset.on === '1' });
      if (x.ok) { toast('反映するには画面を再読み込みしてください'); loadPlug(); } else alert(x.error || '失敗しました');
    });
  }
  // 有効なプラグインを読み込む(プラグインから使える最小のAPIも渡す)
  window.VC = { api, toast, session: () => sessions.find(x => x.id === cur), openWork: t => openWork(t), addButton(id, label, title, fn) { const b = document.createElement('button'); b.id = id; b.textContent = label; b.title = title || ''; b.onclick = fn; $('gt').after(b); return b; } };
  (async () => {
    let r; try { r = await api('GET', '/api/plugins'); } catch { return; }
    for (const p of r.plugins) {
      if (!p.enabled) continue;
      try {
        if (p.style) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/plugins/' + p.id + '/' + p.style; document.head.appendChild(l); }
        if (p.script) { const sc = document.createElement('script'); sc.src = '/plugins/' + p.id + '/' + p.script; sc.onerror = () => console.warn('plugin load failed', p.id); document.body.appendChild(sc); }
      } catch (e) { console.warn('plugin', p.id, e); }
    }
  })();

  window.openWork = t => {
    if (!cur) return toast('先に会話を開いてください');
    sid = cur; fcur = { path: '', file: null, mtime: 0, edit: false, dirty: false };
    if (!dlg.open) dlg.showModal();
    setTab(t || 'git');
  };
  dlg.querySelectorAll('#wk-tabs button').forEach(b => b.onclick = () => setTab(b.dataset.t));
  const close = () => { if (fcur.dirty && !confirm('保存していない変更があります。破棄しますか？')) return; fcur.dirty = false; dlg.close(); };
  $w('#wk-ex').onclick = async () => { try { await api('POST', '/api/sessions/' + sid + '/open-folder', {}); } catch (e) { alert(e.message); } };
  $w('#wk-x').onclick = close; dlg.addEventListener('cancel', e => { if (fcur.dirty) { e.preventDefault(); close(); } });

  // 既存の📂ボタン(フォルダ)をこの画面に一本化する
  const fo = $('fo'); fo.title = 'フォルダ: 変更の確認 / ファイルの閲覧・編集'; fo.onclick = () => openWork(tab === 'files' ? 'files' : 'git');
})();

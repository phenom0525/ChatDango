'use strict';
// チャットごとのプロセス一覧(このアプリが起動した Claude / Codex とその子孫だけ)と、安全な停止の判定。
// プロセス一覧は PowerShell(CIM)で1回だけ取る。コマンドライン(引数)は取らない。
const { execFile } = require('child_process');

const LIST_SCRIPT = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $pf=@{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime,WorkingSetPrivate,IODataBytesPersec | ForEach-Object { $pf[[int]$_.IDProcess]=$_ }; $r=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate,ReadTransferCount,WriteTransferCount | ForEach-Object { [pscustomobject]@{p=[int]$_.ProcessId;pp=[int]$_.ParentProcessId;n=[string]$_.Name;w=[double]$_.WorkingSetSize;t=[double]([double]$_.KernelModeTime+[double]$_.UserModeTime);c=[string]$_.CreationDate.Ticks;i=[double]([double]$_.ReadTransferCount+[double]$_.WriteTransferCount);pw=$(if($pf.ContainsKey([int]$_.ProcessId)){[double]$pf[[int]$_.ProcessId].WorkingSetPrivate}else{$null});pc=$(if($pf.ContainsKey([int]$_.ProcessId)){[double]$pf[[int]$_.ProcessId].PercentProcessorTime}else{$null});pi=$(if($pf.ContainsKey([int]$_.ProcessId)){[double]$pf[[int]$_.ProcessId].IODataBytesPersec}else{$null})} }); ConvertTo-Json -InputObject $r -Compress";

// PowerShell のJSONを読む。壊れた行は捨てる
function parseProcs(text) {
  let a; try { a = JSON.parse(String(text || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(a)) a = a ? [a] : [];
  const out = [];
  for (const x of a) {
    if (!x || !Number.isInteger(x.p) || x.p <= 0 || !Number.isInteger(x.pp)) continue;
    const o = { p: x.p, pp: x.pp, n: String(x.n || '').replace(/\.exe$/i, '').slice(0, 60), w: Number(x.w) || 0, t: Number(x.t) || 0, c: /^\d+$/.test(String(x.c)) ? String(x.c) : '', i: Number(x.i) || 0 };
    if (x.pc != null && x.pw != null && Number.isFinite(+x.pc) && Number.isFinite(+x.pw)) { o.pc = +x.pc; o.pw = +x.pw; o.pi = Number(x.pi) || 0; }
    out.push(o);
  }
  return out;
}

// root の子孫(root自身は含まない)。exclude(自分自身)とその下は除く。循環しても止まる
function descendants(list, root, exclude) {
  const kids = new Map();
  for (const x of list) { if (!kids.has(x.pp)) kids.set(x.pp, []); kids.get(x.pp).push(x); }
  const out = [], seen = new Set([root]);
  const q = [root];
  while (q.length) {
    const cur = q.shift();
    for (const k of kids.get(cur) || []) {
      if (seen.has(k.p) || k.p === exclude) continue;
      seen.add(k.p); out.push(k); q.push(k.p); // キューに積むのはPID(以前はオブジェクトを積んでいて、孫以降を辿れなかった)
    }
  }
  return out;
}

const key = x => x.p + ':' + x.c;

// roots: [{sid, pid}]。prev: 前回の CPU時間 Map(key -> 100ns単位の累計)。dtSec: 前回からの秒数。
// 戻り値の next は次回の prev に渡す
function summarize(list, roots, prev, dtSec, cores, selfPid) {
  const next = new Map(), chats = [];
  for (const r of roots) {
    const tree = descendants(list, r.pid, selfPid);
    const root = list.find(x => x.p === r.pid);
    if (root) tree.unshift(root);
    const procs = tree.map(x => {
      next.set(key(x), x.t);
      const before = prev && prev.get(key(x));
      const cpu = before == null || !(dtSec > 0) || !(cores > 0) ? null : Math.max(0, Math.min(100, Math.round((x.t - before) / 1e7 / dtSec / cores * 100)));
      return { pid: x.p, start: x.c, name: x.n, mb: Math.round(x.w / 1048576), cpu, root: x.p === r.pid };
    });
    procs.sort((a, b) => (b.mb - a.mb));
    const known = procs.filter(x => x.cpu != null);
    chats.push({ sid: r.sid, cpu: known.length ? Math.min(100, known.reduce((s, x) => s + x.cpu, 0)) : null, mb: procs.reduce((s, x) => s + x.mb, 0), procs });
  }
  return { chats, next };
}

// 止めてよいか: root(チャットの本体プロセス)の子孫で、起動時刻が一致し、本体・サーバー自身ではないこと(PIDの使い回し対策)
function canStop(list, root, pid, start, selfPid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || pid === root || !start) return false;
  const t = descendants(list, root, selfPid).find(x => x.p === pid);
  return !!t && t.c === String(start);
}

// 止めてはいけないプロセス名(Windows本体。止めると画面が固まる・再起動になる)
const PROTECTED = new Set(['system', 'idle', 'system idle process', 'registry', 'memory compression', 'secure system', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'fontdrvhost', 'dwm', 'svchost', 'sihost']);
const isProtected = name => PROTECTED.has(String(name).toLowerCase());

// このサーバー自身と、その親をたどった先(起動したバッチ・ターミナルなど)のPID。止めるとサーバーごと落ちる
function lockedPids(list, selfPid) {
  const by = new Map(list.map(x => [x.p, x])), out = new Set([selfPid]);
  for (let p = by.get(selfPid), n = 0; p && p.pp > 0 && !out.has(p.pp) && n < 30; n++) { out.add(p.pp); p = by.get(p.pp); }
  return out;
}

// PC全体のプロセスを名前ごとにまとめる(タスクマネージャー風)。CPU%は全コア合計に対する割合、ioは読み書きの合計バイト/秒
// prev: Map(key -> {t, i})。戻り値の next を次回の prev に渡す
function groupAll(list, prev, dtSec, cores, selfPid, totalMem) {
  const next = new Map(), groups = new Map(), lock = lockedPids(list, selfPid);
  let cpuSum = 0, mbSum = 0, ioSum = 0;
  for (const x of list) {
    next.set(key(x), { t: x.t, i: x.i });
    const b = prev && prev.get(key(x)), ok = b && dtSec > 0 && cores > 0;
    const pf = x.pc != null && cores > 0; // タスクマネージャーと同じ元データ(性能カウンタ)があればそれを使う
    const cpu = pf ? Math.max(0, Math.min(100, x.pc / cores)) : ok ? Math.max(0, (x.t - b.t) / 1e7 / dtSec / cores * 100) : 0;
    const io = pf ? Math.max(0, x.pi) : ok ? Math.max(0, (x.i - b.i) / dtSec) : 0;
    const mbv = (pf ? x.pw : x.w) / 1048576;
    const prot = isProtected(x.n) || lock.has(x.p);
    const k = x.n.toLowerCase();
    let g = groups.get(k); if (!g) groups.set(k, g = { name: x.n, cpu: 0, mb: 0, io: 0, procs: [] });
    g.cpu += cpu; g.mb += mbv; g.io += io;
    g.procs.push({ pid: x.p, start: x.c, mb: Math.round(mbv), cpu: Math.round(cpu * 10) / 10, io: Math.round(io), prot });
    cpuSum += cpu; mbSum += mbv; ioSum += io;
  }
  const out = [...groups.values()].map(g => {
    g.procs.sort((a, b) => b.cpu - a.cpu || b.mb - a.mb);
    return { name: g.name, n: g.procs.length, cpu: Math.round(g.cpu * 10) / 10, mb: Math.round(g.mb), io: Math.round(g.io), prot: g.procs.every(p => p.prot), procs: g.procs };
  });
  out.sort((a, b) => b.cpu - a.cpu || b.mb - a.mb);
  return { groups: out, total: { cpu: Math.min(100, Math.round(cpuSum * 10) / 10), mb: Math.round(mbSum), memPct: totalMem > 0 ? Math.min(100, Math.round(mbSum * 1048576 / totalMem * 100)) : null, io: Math.round(ioSum) }, next };
}

// 任意のプロセスを止めてよいか: 起動時刻が一致し(PIDの使い回し対策)、Windows本体・サーバー自身とその親ではないこと
function canStopAny(list, pid, start, selfPid) {
  if (!Number.isInteger(pid) || pid <= 0 || !start) return false;
  const t = list.find(x => x.p === pid);
  return !!t && t.c === String(start) && !isProtected(t.n) && !lockedPids(list, selfPid).has(pid);
}

let cache = null, inflight = null;
// 一覧は1.2秒だけ使い回す(設定を開いている間は複数の画面が同時に聞いてくるため)。取得した時刻を list.at に付ける
function listProcs(fresh) {
  if (!fresh && cache && Date.now() - cache.at < 1200) return Promise.resolve(cache.list);
  if (!fresh && inflight) return inflight;
  return inflight = listProcsRaw().then(list => { list.at = Date.now(); cache = { list, at: list.at }; return list; }).finally(() => { inflight = null; });
}
function listProcsRaw() {
  return new Promise(res => {
    if (process.platform !== 'win32') return res([]);
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (e, out) => res(e ? [] : parseProcs(out)));
    } catch { res([]); }
  });
}

module.exports = { parseProcs, descendants, summarize, canStop, groupAll, canStopAny, isProtected, lockedPids, listProcs, LIST_SCRIPT };

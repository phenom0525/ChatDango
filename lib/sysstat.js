'use strict';
// CPU / GPU / メモリ / ストレージ の使用状況(全体と、このアプリ分)。
//  CPU: 全体は os.cpus() の差分、このアプリ分はサーバー本体+子孫プロセスのCPU時間の増え分
//  GPU: Windows の性能カウンタ(タスクマネージャーと同じ元データ)。全体はGPUごと・処理の種類ごとの合計の最大値、
//       このアプリ分は同じ集計をこのアプリのプロセスだけで行う
//  メモリ: 全体は os.totalmem/freemem、このアプリ分は子孫プロセスの使用中メモリ(ワーキングセット)の合計と、プロセス名ごとの内訳
//  ストレージ: 固定ドライブの種別(SSD/HDD)は最初に1回だけ問い合わせ、使用量は fs.statfs で30秒ごとに更新
// 画面を開いている間だけ動かす(sample/stop)。取れないものは null。
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const clamp = v => Math.max(0, Math.min(100, Math.round(v)));

// 2回分の os.cpus() から全体のCPU使用率(0〜100)。前回が無ければ null
function cpuPct(prev, cur) {
  if (!prev || !cur || prev.length !== cur.length) return null;
  let idle = 0, total = 0;
  for (let i = 0; i < cur.length; i++) {
    const a = prev[i].times, b = cur[i].times;
    idle += b.idle - a.idle;
    for (const k of Object.keys(b)) total += b[k] - (a[k] || 0);
  }
  return total > 0 ? clamp((1 - idle / total) * 100) : null;
}

// 前回と今回の「このアプリのCPU時間(秒)」と経過秒、コア数から、全体に対する%(0〜100)。足りなければ null
function appCpuPct(prevSec, curSec, dtSec, cores) {
  if (prevSec == null || curSec == null || !(dtSec > 0) || !(cores > 0)) return null;
  return clamp(Math.max(0, curSec - prevSec) / dtSec / cores * 100);
}

// PowerShell が1行ごとに出す「全体GPU;アプリGPU;アプリCPU秒;アプリのメモリMB;名前=MB,名前=MB…」を読む。不正な行は null
function parseLine(line) {
  const m = /^(\d+(?:\.\d+)?);(\d+(?:\.\d+)?);(\d+(?:\.\d+)?);(\d+);([^;]*)$/.exec(String(line || '').trim());
  if (!m) return null;
  const procs = [];
  for (const part of m[5].split(',')) {
    const q = /^([^=,;]{1,60})=(\d+)$/.exec(part);
    if (q) procs.push({ name: q[1], mb: parseInt(q[2], 10) });
  }
  procs.sort((a, b) => b.mb - a.mb);
  return { gpu: clamp(parseFloat(m[1])), appGpu: clamp(parseFloat(m[2])), appCpuSec: parseFloat(m[3]), appMemMB: parseInt(m[4], 10), procs: procs.slice(0, 8) };
}

// 固定ドライブ一覧(PowerShellのJSON)を読む。壊れていても空配列。種別は SSD / HDD / 不明('')
function parseDisks(text) {
  let a; try { a = JSON.parse(String(text || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(a)) a = a ? [a] : [];
  const out = [];
  for (const x of a) {
    if (!x || !/^[A-Za-z]$/.test(String(x.d || ''))) continue;
    const type = /^(SSD|HDD)$/i.test(String(x.type)) ? String(x.type).toUpperCase() : '';
    out.push({ d: String(x.d).toUpperCase(), label: String(x.label || '').slice(0, 40), type, total: Number(x.total) || 0, free: Number(x.free) || 0 });
  }
  return out.sort((p, q) => p.d.localeCompare(q.d));
}

const GPU_SCRIPT = [
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $root=[int]$env:VC_ROOT; $me=$PID; $ci=[Globalization.CultureInfo]::InvariantCulture",
  "while($true){",
  " try{",
  "  $pp=@{}; foreach($p in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)){ $pp[[int]$p.ProcessId]=[int]$p.ParentProcessId }",
  "  $ids=@{}; $ids[$root]=1; $grow=$true",
  "  while($grow){ $grow=$false; foreach($k in @($pp.Keys)){ if($k -ne $me -and -not $ids.ContainsKey($k) -and $ids.ContainsKey($pp[$k])){ $ids[$k]=1; $grow=$true } } }",
  "  $cpu=0.0; $mem=@{}; $memAll=0.0",
  "  foreach($p in (Get-Process -Id ([int[]]@($ids.Keys)) -ErrorAction SilentlyContinue)){ try{ $cpu+=$p.TotalProcessorTime.TotalSeconds }catch{}; $w=[double]$p.WorkingSet64; $memAll+=$w; $mem[$p.ProcessName]+=$w }",
  "  $names=($mem.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object { ($_.Key -replace '[;,=]','_') + '=' + [int]($_.Value/1MB) }) -join ','",
  "  $h=@{}; $a=@{}",
  "  foreach($x in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage)){", // Get-Counter は毎回十数秒かかるのでCIMを使う(2回目以降は0.4秒ほど)
  "   if($x.Name -match 'pid_(\\d+)_(luid_\\w+_\\w+_phys_\\d+).*engtype_(\\w+)'){ $pid2=[int]$matches[1]; $k=$matches[2]+'/'+$matches[3]; $v=[double]$x.UtilizationPercentage; $h[$k]+=$v; if($ids.ContainsKey($pid2)){ $a[$k]+=$v } } }",
  "  $m=0.0; foreach($v in $h.Values){ if($v -gt $m){ $m=$v } }; $am=0.0; foreach($v in $a.Values){ if($v -gt $am){ $am=$v } }",
  "  [Console]::Out.WriteLine([string]::Format($ci,'{0:0.0};{1:0.0};{2:0.00};{3};{4}',$m,$am,$cpu,[int]($memAll/1MB),$names)) }",
  " catch{ [Console]::Out.WriteLine('NA') }",
  " Start-Sleep -Seconds 2 }",
].join('\n');

// 固定ドライブの一覧と種別(1回だけ実行)。Get-Partition → Get-Disk → Get-PhysicalDisk の MediaType を使う
const DISK_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $o=@()",
  "foreach($v in (Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' })){",
  " $ty=''; try{ $ty=[string](Get-Partition -DriveLetter $v.DriveLetter -ErrorAction Stop | Get-Disk -ErrorAction Stop | Get-PhysicalDisk -ErrorAction Stop).MediaType }catch{}",
  " $o+=[pscustomobject]@{d=[string]$v.DriveLetter;label=[string]$v.FileSystemLabel;type=$ty;total=[double]$v.Size;free=[double]$v.SizeRemaining} }",
  "ConvertTo-Json -InputObject @($o) -Compress",
].join('\n');

function create() {
  let prevCpu = null, proc = null, buf = '';
  let gpu = null, appGpu = null, appCpu = null, appMem = null, procs = [], last = null; // last = { sec, t }
  let disks = [], diskProc = null, diskAt = 0, diskTried = false, statBusy = false;
  const reset = () => { proc = null; gpu = appGpu = appCpu = appMem = last = null; procs = []; buf = ''; };
  function onLine(line) {
    const r = parseLine(line), now = Date.now();
    if (!r) { gpu = appGpu = appCpu = appMem = null; procs = []; return; }
    gpu = r.gpu; appGpu = r.appGpu; appMem = r.appMemMB; procs = r.procs;
    appCpu = last ? appCpuPct(last.sec, r.appCpuSec, (now - last.t) / 1000, os.cpus().length) : null;
    last = { sec: r.appCpuSec, t: now };
  }
  function startGpu() {
    if (proc || process.platform !== 'win32') return;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, VC_ROOT: String(process.pid) } });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      proc.on('error', reset);
      proc.on('exit', reset);
    } catch { reset(); }
  }
  function loadDisks() { // 種別つきの一覧を1回だけ取る。失敗したら statfs だけで英字ドライブを拾う
    if (diskProc || diskTried) return; diskTried = true;
    if (process.platform !== 'win32') return;
    let out = '';
    try {
      diskProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DISK_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      diskProc.stdout.setEncoding('utf8');
      diskProc.stdout.on('data', d => { out += d; });
      diskProc.on('error', () => { diskProc = null; });
      diskProc.on('exit', () => { diskProc = null; disks = parseDisks(out); diskAt = 0; });
    } catch { diskProc = null; }
  }
  function refreshDisks() { // 使用量だけを軽く更新(30秒ごと)
    const now = Date.now();
    if (statBusy || now - diskAt < 30000 || !disks.length) return;
    statBusy = true; diskAt = now;
    Promise.all(disks.map(x => new Promise(res => fs.statfs(x.d + ':\\', (e, s) => { if (!e && s) { x.total = s.blocks * s.bsize; x.free = s.bavail * s.bsize; } res(); }))))
      .then(() => { statBusy = false; }, () => { statBusy = false; });
  }
  return {
    // 呼ぶたびに最新の値を返す(使われている間は定期的に呼ぶ)
    sample() {
      startGpu(); loadDisks(); refreshDisks();
      const cur = os.cpus(), cpu = cpuPct(prevCpu, cur); prevCpu = cur;
      const total = os.totalmem(), free = os.freemem();
      return {
        cpu, gpu, appCpu, appGpu,
        mem: { total, used: total - free, app: appMem == null ? null : appMem * 1048576, procs },
        disks: disks.map(x => ({ ...x })),
      };
    },
    stop() { if (proc) { try { proc.kill(); } catch {} } if (diskProc) { try { diskProc.kill(); } catch {} diskProc = null; } reset(); prevCpu = null; diskTried = false; },
  };
}

module.exports = { cpuPct, appCpuPct, parseLine, parseDisks, create, GPU_SCRIPT, DISK_SCRIPT };

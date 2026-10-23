'use strict';
// 認証・接続元の判定だけを集めたファイル(server.js から使う。test/security.test.js で試験する)
const crypto = require('crypto');

const LOCAL_ADDRS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const isLocalAddr = addr => LOCAL_ADDRS.includes(addr || '');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cookieOf = (header, k) => {
  const m = (header || '').split(/;\s*/).find(c => c.startsWith(k + '='));
  return m ? m.slice(k.length + 1) : '';
};

const authToken = auth => crypto.createHmac('sha256', auth.secret).update(auth.password).digest('hex');

// Host が自分宛てか。ローカル接続は 127.0.0.1 / localhost のみ。
// ローカル以外(Tailscale)は 100.x.x.x か *.ts.net のみ(DNSリバインディング対策)。
function hostAllowed(host, local, port) {
  host = String(host || '');
  if (host === '127.0.0.1:' + port || host === 'localhost:' + port) return true;
  if (local) return false;
  const m = /^(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|[A-Za-z0-9.-]+\.ts\.net):(\d+)$/.exec(host);
  if (!m || Number(m[5]) !== port) return false;
  if (m[1] === undefined) return true;
  return isTailscaleAddr(host.slice(0, host.lastIndexOf(':')));
}

// 書き込み系(GET以外)は Origin が自分自身のときだけ通す(他サイトからのPOSTを拒否)
const originAllowed = (method, origin, host) => method === 'GET' || !origin || origin === 'http://' + host;

// Tailscale が配る 100.64.0.0/10
const isTailscaleAddr = addr => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(addr || '');
function tailscaleIp(ifaces) {
  for (const k in ifaces) for (const a of ifaces[k] || []) if (a.family === 'IPv4' && isTailscaleAddr(a.address)) return a.address;
  return null;
}

// ログインの総当たり対策: 5回失敗で60秒ロック。古い記録は掃除する。
class LoginLimiter {
  constructor(max = 5, lockMs = 60000) { this.max = max; this.lockMs = lockMs; this.m = new Map(); }
  locked(ip, now = Date.now()) { const f = this.m.get(ip); return !!f && now < f.until; }
  fail(ip, now = Date.now()) {
    if (this.m.size > 500) this.prune(now);
    const f = this.m.get(ip) || { n: 0, until: 0 };
    f.n++; f.last = now;
    if (f.n >= this.max) { f.until = now + this.lockMs; f.n = 0; }
    this.m.set(ip, f);
  }
  ok(ip) { this.m.delete(ip); }
  prune(now = Date.now()) { for (const [k, f] of this.m) if (now > f.until && now - (f.last || 0) > this.lockMs) this.m.delete(k); }
}

// 外部の値を claude/codex の引数に渡す前の検査(shell経由で起動するため、記号や空白は通さない)
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);

// 公開フォルダ(PUB)の中のファイルだけを返す。外に出るパスは null
function staticPath(pub, urlPath) {
  const path = require('path');
  let p = String(urlPath || '/'); if (p === '/') p = '/index.html';
  if (p.includes('\\') || p.includes('\0') || /%(2e|2f|5c)/i.test(p)) return null;
  const f = path.resolve(pub, '.' + p);
  const rel = path.relative(pub, f);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? f : null;
}

module.exports = { staticPath, isLocalAddr, safeEq, cookieOf, authToken, hostAllowed, originAllowed, isTailscaleAddr, tailscaleIp, LoginLimiter, safeId };

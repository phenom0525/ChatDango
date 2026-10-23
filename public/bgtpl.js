'use strict';
// 背景テンプレート: canvasで描く動く背景(画像・動画ファイルは使わない)。
// window.BGTPL.start(canvas, 名前) → 止める関数 / BGTPL.still(canvas, 名前) → 1コマだけ描く(サムネイル用)
(function () {
  const TAU = Math.PI * 2, clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647); // 毎回同じ並びになる乱数
  const mkRand = s => rnd(s);

  // 1×256の縦グラデーションを作っておき、帯を描くときに引き伸ばして使う(毎フレームのグラデーション生成を避ける)
  function vgrad(stops) {
    const c = document.createElement('canvas'); c.width = 1; c.height = 256;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
    for (const [p, col] of stops) g.addColorStop(p, col);
    x.fillStyle = g; x.fillRect(0, 0, 1, 256); return c;
  }
  function sky(ctx, w, h, stops) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    for (const [p, c] of stops) g.addColorStop(p, c);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  function glow(ctx, x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // ---------- オーロラ ----------
  function aurora(ctx, w, h, t, st) {
    if (!st.i) {
      st.i = 1; const r = mkRand(11);
      st.bands = [['52,211,153', .55, .30], ['96,165,250', .45, .38], ['167,139,250', .40, .26], ['45,212,191', .35, .44]].map(([rgb, a, y], k) => ({
        g: vgrad([[0, 'rgba(' + rgb + ',0)'], [.35, 'rgba(' + rgb + ',' + a + ')'], [.7, 'rgba(' + rgb + ',' + a * .35 + ')'], [1, 'rgba(' + rgb + ',0)']]),
        y, f1: 1.4 + r() * 1.2, f2: 3 + r() * 2, s1: .18 + r() * .14, s2: .3 + r() * .2, ph: r() * TAU, hh: .30 + r() * .12,
      }));
      st.stars = Array.from({ length: 70 }, () => [r(), r() * .6, r() * TAU, .5 + r() * 1.1]);
    }
    sky(ctx, w, h, [[0, '#030814'], [.6, '#071a2e'], [1, '#0d2a3a']]);
    ctx.fillStyle = '#fff';
    for (const [x, y, p, s] of st.stars) { ctx.globalAlpha = .25 + .45 * (.5 + .5 * Math.sin(t * .8 + p)); ctx.fillRect(x * w, y * h, s * w / 700 + .5, s * w / 700 + .5); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'lighter';
    const step = 2;
    for (const b of st.bands) {
      for (let x = 0; x < w; x += step) {
        const u = x / w;
        const top = h * (b.y + .10 * Math.sin(u * b.f1 * TAU * .5 + t * b.s1 + b.ph) + .05 * Math.sin(u * b.f2 * TAU * .5 - t * b.s2));
        const hh = h * b.hh * (.65 + .35 * Math.sin(u * 5 + t * .35 + b.ph));
        ctx.globalAlpha = .55 + .45 * Math.sin(u * 3 - t * .25 + b.ph * 2);
        ctx.drawImage(b.g, 0, 0, 1, 256, x, top, step + 2, hh);
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    glow(ctx, w * .5, h * 1.05, w * .7, '30,90,110', .35);
  }

  // ---------- 夕焼け ----------
  function sunset(ctx, w, h, t, st) {
    if (!st.i) {
      st.i = 1; const r = mkRand(5);
      st.clouds = Array.from({ length: 9 }, (_, k) => ({ x: r(), y: .12 + r() * .5, s: .6 + r() * .9, v: .004 + r() * .01, a: .10 + r() * .16, blobs: Array.from({ length: 6 }, () => [(r() - .5) * .22, (r() - .5) * .03, .05 + r() * .06]) }));
    }
    const k = .5 + .5 * Math.sin(t * .05); // 空の色がゆっくり変わる
    sky(ctx, w, h, [[0, k > .5 ? '#2a1b5e' : '#1e1b4b'], [.38, '#7c3aed'], [.7, '#f472b6'], [.88, '#fb923c'], [1, '#fde68a']]);
    glow(ctx, w * .5, h * (.86 + .01 * Math.sin(t * .3)), w * .45, '255,237,170', .75);
    glow(ctx, w * .5, h * .88, w * .16, '255,250,225', .9);
    for (const c of st.clouds) {
      const cx = ((c.x + t * c.v) % 1.4 - .2) * w, cy = c.y * h;
      for (const [dx, dy, rr] of c.blobs) {
        const R = rr * w * c.s * 1.4;
        const g = ctx.createRadialGradient(cx + dx * w * c.s, cy + dy * h, 0, cx + dx * w * c.s, cy + dy * h, R);
        g.addColorStop(0, 'rgba(255,225,235,' + c.a + ')'); g.addColorStop(1, 'rgba(255,225,235,0)');
        ctx.fillStyle = g; ctx.save(); ctx.translate(cx + dx * w * c.s, cy + dy * h); ctx.scale(1, .32); ctx.translate(-(cx + dx * w * c.s), -(cy + dy * h));
        ctx.fillRect(cx + dx * w * c.s - R, cy + dy * h - R, R * 2, R * 2); ctx.restore();
      }
    }
    const g2 = ctx.createLinearGradient(0, h * .86, 0, h); g2.addColorStop(0, 'rgba(60,20,70,0)'); g2.addColorStop(1, 'rgba(40,12,60,.55)');
    ctx.fillStyle = g2; ctx.fillRect(0, h * .86, w, h * .14);
  }

  // ---------- 星空 ----------
  function stars(ctx, w, h, t, st) {
    if (!st.i) {
      st.i = 1; const r = mkRand(23);
      const mk = (n, s0, s1, v) => Array.from({ length: n }, () => ({ x: r(), y: r(), s: s0 + r() * (s1 - s0), p: r() * TAU, f: .6 + r() * 1.6, v, c: r() < .2 ? '200,220,255' : r() < .35 ? '255,235,200' : '255,255,255' }));
      st.layers = [mk(120, .4, .9, .004), mk(60, .8, 1.5, .009), mk(22, 1.4, 2.2, .016)];
      st.shoot = null; st.next = 2.5;
    }
    sky(ctx, w, h, [[0, '#02040c'], [.55, '#0a1230'], [1, '#1a2550']]);
    ctx.save(); ctx.translate(w * .5, h * .5); ctx.rotate(-.5);
    const mw = ctx.createLinearGradient(0, -h * .18, 0, h * .18); mw.addColorStop(0, 'rgba(150,170,255,0)'); mw.addColorStop(.5, 'rgba(170,185,255,.13)'); mw.addColorStop(1, 'rgba(150,170,255,0)');
    ctx.fillStyle = mw; ctx.fillRect(-w, -h * .18, w * 2, h * .36); ctx.restore();
    const unit = Math.max(w, h) / 900;
    for (const L of st.layers) for (const s of L) {
      const x = ((s.x + t * s.v) % 1) * w, y = (s.y + Math.sin(t * .05 + s.p) * .004) * h;
      const a = .35 + .65 * (.5 + .5 * Math.sin(t * s.f + s.p));
      ctx.fillStyle = 'rgba(' + s.c + ',' + a + ')'; const z = s.s * unit * .55 + .3;
      ctx.beginPath(); ctx.arc(x, y, z, 0, TAU); ctx.fill();
      if (s.s > 1.5) glow(ctx, x, y, z * 5, s.c, a * .16);
    }
    if (!st.shoot && t > st.next) { st.shoot = { x: (.2 + Math.random() * .6) * w, y: Math.random() * h * .35, t0: t, a: .4 + Math.random() * .3 }; st.next = t + 6 + Math.random() * 6; }
    if (st.shoot) {
      const d = (t - st.shoot.t0) / .9;
      if (d > 1) st.shoot = null; else {
        const L = w * .16, x = st.shoot.x + d * w * .22, y = st.shoot.y + d * w * .11, fade = Math.sin(d * Math.PI);
        const g = ctx.createLinearGradient(x, y, x - L, y - L * .5); g.addColorStop(0, 'rgba(255,255,255,' + fade * .9 + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, unit * 1.6); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - L, y - L * .5); ctx.stroke();
      }
    }
  }

  // ---------- 海 ----------
  function ocean(ctx, w, h, t, st) {
    sky(ctx, w, h, [[0, '#0a3550'], [.45, '#0e5a74'], [1, '#08293f']]);
    glow(ctx, w * .72, h * .08, w * .5, '180,235,255', .22);
    const L = [[.28, .030, 1.6, .22, '#1f7f9a'], [.40, .035, 1.2, .30, '#176b87'], [.53, .040, .95, .40, '#105670'], [.67, .045, .75, .50, '#0b445c'], [.82, .050, .6, .6, '#073349']];
    L.forEach(([y0, amp, sp, k, col], i) => {
      ctx.beginPath(); ctx.moveTo(0, h);
      const n = 64; const pts = [];
      for (let j = 0; j <= n; j++) {
        const u = j / n, x = u * w;
        const y = h * (y0 + amp * (Math.sin(u * 5 + t * sp + i) * .6 + Math.sin(u * 11 - t * sp * 1.3 + i * 2) * .3 + Math.sin(u * 2.3 + t * sp * .5) * .5));
        pts.push([x, y]); ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, h * (y0 - amp), 0, h); g.addColorStop(0, col); g.addColorStop(1, 'rgba(4,22,36,.95)');
      ctx.globalAlpha = .95; ctx.fillStyle = g; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); pts.forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.strokeStyle = 'rgba(200,240,255,' + (.22 + .05 * i) + ')'; ctx.lineWidth = Math.max(1, w / 900 * (1 + i * .3)); ctx.stroke();
    });
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    if (!st.g) { const r = mkRand(31); st.g = Array.from({ length: 26 }, () => [r(), .3 + r() * .6, r() * TAU, .4 + r() * .8]); }
    for (const [x, y, p, f] of st.g) { const a = Math.max(0, Math.sin(t * f + p)); if (a > .75) { ctx.globalAlpha = (a - .75) * 2; ctx.fillRect(x * w, y * h, Math.max(1.5, w / 450), Math.max(1, w / 900)); } }
    ctx.globalAlpha = 1;
  }

  // ---------- 雨 ----------
  function rain(ctx, w, h, t, st) {
    if (!st.i) {
      st.i = 1; const r = mkRand(41);
      st.d = Array.from({ length: 170 }, () => ({ x: r(), y: r(), l: .02 + r() * .05, v: .7 + r() * 1.1, a: .10 + r() * .28, z: r() }));
      st.rip = []; st.last = 0;
    }
    sky(ctx, w, h, [[0, '#0b1220'], [.6, '#16202f'], [1, '#1c2938']]);
    glow(ctx, w * .3, h * .1, w * .6, '90,120,160', .13);
    const sl = .18;
    ctx.lineCap = 'round';
    for (const d of st.d) {
      const y = ((d.y + t * d.v * .55) % 1.2 - .1) * h, x = ((d.x - (y / h) * sl * .5) % 1 + 1) % 1 * w;
      const len = d.l * h; ctx.strokeStyle = 'rgba(190,220,245,' + d.a + ')'; ctx.lineWidth = .6 + d.z * 1.1 * (w / 900 + .4);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - len * sl, y - len); ctx.stroke();
    }
    if (t - st.last > .18) { st.last = t; st.rip.push({ x: Math.random() * w, y: h * (.78 + Math.random() * .2), t0: t }); if (st.rip.length > 24) st.rip.shift(); }
    ctx.lineWidth = Math.max(1, w / 1000);
    for (const p of st.rip) {
      const d = (t - p.t0) / 1.4; if (d > 1) continue;
      ctx.strokeStyle = 'rgba(190,220,245,' + (1 - d) * .25 + ')'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 4 + d * w * .035, (4 + d * w * .035) * .3, 0, 0, TAU); ctx.stroke();
    }
    const g = ctx.createLinearGradient(0, h * .7, 0, h); g.addColorStop(0, 'rgba(120,150,180,0)'); g.addColorStop(1, 'rgba(120,150,180,.18)');
    ctx.fillStyle = g; ctx.fillRect(0, h * .7, w, h * .3);
  }

  // ---------- ラバ(ラバランプ) ----------
  function lava(ctx, w, h, t, st) {
    if (!st.i) { st.i = 1; const r = mkRand(53); st.b = Array.from({ length: 8 }, (_, k) => ({ cx: .15 + r() * .7, cy: .5, ax: .12 + r() * .2, ay: .28 + r() * .15, fx: .08 + r() * .1, fy: .05 + r() * .08, p: r() * TAU, q: r() * TAU, r: .16 + r() * .12, c: ['251,113,133', '251,191,36', '168,85,247', '244,114,182', '129,140,248', '253,164,175', '216,180,254', '251,146,60'][k] })); }
    sky(ctx, w, h, [[0, '#1b0b30'], [1, '#2b0f3d']]);
    ctx.globalCompositeOperation = 'lighter';
    for (const b of st.b) {
      const x = (b.cx + b.ax * Math.sin(t * b.fx * TAU + b.p)) * w, y = (b.cy + b.ay * Math.sin(t * b.fy * TAU + b.q)) * h;
      const R = b.r * Math.max(w, h) * (1 + .12 * Math.sin(t * .4 + b.p));
      const g = ctx.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, 'rgba(' + b.c + ',.55)'); g.addColorStop(.55, 'rgba(' + b.c + ',.18)'); g.addColorStop(1, 'rgba(' + b.c + ',0)');
      ctx.fillStyle = g; ctx.fillRect(x - R, y - R, R * 2, R * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .3, w / 2, h / 2, Math.max(w, h) * .75); v.addColorStop(0, 'rgba(10,0,25,0)'); v.addColorStop(1, 'rgba(10,0,25,.45)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  }

  // ---------- さくら ----------
  function sakura(ctx, w, h, t, st) {
    if (!st.i) {
      st.i = 1; const r = mkRand(67);
      st.p = Array.from({ length: 46 }, () => ({ x: r(), y: r(), s: .007 + r() * .012, v: .018 + r() * .03, sw: .02 + r() * .04, f: .4 + r() * .8, ph: r() * TAU, rot: r() * TAU, rs: (r() - .5) * 1.2, a: .55 + r() * .4, z: r() }));
      st.bk = Array.from({ length: 10 }, () => ({ x: r(), y: r(), r: .03 + r() * .07, v: .006 + r() * .01, a: .05 + r() * .09 }));
    }
    sky(ctx, w, h, [[0, '#fbe3ec'], [.55, '#f7c9da'], [1, '#e9a9c4']]);
    for (const b of st.bk) glow(ctx, b.x * w + Math.sin(t * .1 + b.x * 9) * w * .02, (((b.y - t * b.v) % 1) + 1) % 1 * h, b.r * Math.max(w, h), '255,255,255', b.a);
    const u = Math.max(w, h);
    for (const p of st.p) {
      const y = ((p.y + t * p.v) % 1.1 - .05) * h, x = (p.x + Math.sin(t * p.f + p.ph) * p.sw + t * .004) % 1 * w;
      const s = p.s * u, rot = p.rot + t * p.rs, sq = .55 + .45 * Math.abs(Math.cos(t * p.f * .9 + p.ph)); // ひらひら(裏返る)
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sq, 1); ctx.globalAlpha = p.a;
      const g = ctx.createLinearGradient(0, -s, 0, s); g.addColorStop(0, '#ffe9f1'); g.addColorStop(1, '#f48fb1');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -s); ctx.bezierCurveTo(s * .95, -s * .75, s * .75, s * .6, 0, s); ctx.bezierCurveTo(-s * .75, s * .6, -s * .95, -s * .75, 0, -s);
      ctx.moveTo(0, -s); ctx.lineTo(s * .12, -s * .78); ctx.lineTo(-s * .12, -s * .78); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  const BLUR = { aurora: 5, lava: 7 };
  const R = { aurora: [aurora, .45], sunset: [sunset, .6], stars: [stars, 1], ocean: [ocean, .7], rain: [rain, 1], lava: [lava, .4], sakura: [sakura, 1] };

  function fit(canvas, scale) {
    const r = canvas.getBoundingClientRect(), bw = Math.max(1, r.width), bh = Math.max(1, r.height);
    const w = Math.max(60, Math.round(Math.min(bw * scale, 1400))), h = Math.max(40, Math.round(bh * w / bw));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  function start(canvas, name) {
    const def = R[name]; if (!def) return () => {};
    const st = {}; let raf = 0, last = 0, dead = false;
    if (BLUR[name]) { canvas.style.filter = 'blur(' + BLUR[name] + 'px)'; canvas.style.transform = 'scale(1.04)'; } // 縞を目立たなくする
    const ctx = canvas.getContext('2d');
    const draw = ts => {
      if (dead) return;
      raf = requestAnimationFrame(draw);
      if (document.hidden || ts - last < 33) return; // 30fps上限・見えていないときは描かない
      last = ts; fit(canvas, def[1]); def[0](ctx, canvas.width, canvas.height, ts / 1000, st);
    };
    if (reduced()) { fit(canvas, def[1]); def[0](ctx, canvas.width, canvas.height, 4, st); return () => {}; }
    raf = requestAnimationFrame(draw);
    return () => { dead = true; cancelAnimationFrame(raf); };
  }
  function still(canvas, name) {
    const def = R[name]; if (!def) return;
    canvas.width = canvas.clientWidth || 72; canvas.height = canvas.clientHeight || 44;
    const st = {}, ctx = canvas.getContext('2d'); def[0](ctx, canvas.width, canvas.height, 6, st);
  }
  window.BGTPL = { start, still, names: Object.keys(R) };
})();


/* ============================================================================
   Breath on Glass · 冬夜窗玻璃：呼气凝雾 + 手指擦拭
   ----------------------------------------------------------------------------
   Canvas 2D 维护水汽密度/擦拭 Mask，WebGL 片元着色器做玻璃光学。
   兼容目标 Chrome 61 / ES2017；无 CDN、无 WASM、无 Worker，照片随项目提供。

   开源研究与许可（本文件为独立实现，非逐行拷贝）：
   - fog-mirror      MIT © 2026 Maher Khan   https://github.com/maherkhan-builds/fog-mirror
       思路复用：麦克风高通滤波 → 幅度分析检测呼气。
   - DEWGLASS        MIT © 2026 Sourav Kamble https://github.com/Sourav142005/DEWGLASS
       思路复用：独立雾气遮罩（叠加/destination-out 擦除）、按住累积环境雾。
   - Raindrop        MIT © 2021 SardineFish   https://github.com/KingDuane/Raindrop
       思路复用：水珠折射透镜、雾层散射与背景分级模糊参数。
   - Animorio "Fogged Glass"（https://animorio.com/...）：仅阅读其公开文字描述；
       该站许可证明确禁止代码再分发，故未复用其任何代码。
   上述 MIT 项目许可全文见文件末尾注释。

   脚本与样式已拆为本地外链；小红书小工具容器仍需单独打包和真机验收。
   ========================================================================== */

(function () {
'use strict';

/* Capture runtime errors for optional diagnostics. */
try {
  window.__dbgErr = null;
  window.__dbgRethrow = false;
  window.addEventListener('error', function (ev) {
    if (window.__dbgRethrow) return true;
    window.__dbgErr = {
      message: String(ev && ev.message),
      file: String(ev && ev.filename),
      line: ev && ev.lineno,
      col: ev && ev.colno,
      type: ev && ev.error && ev.error.constructor ? ev.error.constructor.name : typeof ev.error,
      stack: ev && ev.error && ev.error.stack ? String(ev.error.stack) : '(no stack)'
    };
    return true;
  }, false);
  window.addEventListener('unhandledrejection', function (ev) {
    if (window.__dbgRethrow) return;
    var r = ev && ev.reason;
    window.__dbgErr = {
      message: 'UNHANDLED_REJECTION: ' + String(r && r.message ? r.message : r),
      file: '', line: 0, col: 0,
      type: r && r.constructor ? r.constructor.name : typeof r,
      stack: r && r.stack ? String(r.stack) : '(no stack)'
    };
    if (ev.preventDefault) ev.preventDefault();
  }, false);
} catch (e) {}
/* End diagnostics. */

/* ---------------------------------------------------------------- 工具函数 */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

/* mulberry32：确定性伪随机，保证预设场景可复现 */
function rng32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 可平铺值噪声：用于玻璃微颗粒贴图（无缝 REPEAT） */
function tileNoise(seed, period) {
  var r = rng32(seed), grid = new Float32Array(period * period), i;
  for (i = 0; i < grid.length; i++) grid[i] = r();
  function at(a, b) {
    var x = a % period; if (x < 0) x += period;
    var y = b % period; if (y < 0) y += period;
    return grid[y * period + x];
  }
  return function (x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var A = at(xi, yi), B = at(xi + 1, yi), C = at(xi, yi + 1), D = at(xi + 1, yi + 1);
    return lerp(lerp(A, B, u), lerp(C, D, u), v);
  };
}

/* 普通二维值噪声：用于场景生成 */
function noise2D(seed) {
  var r = rng32(seed), perm = new Uint8Array(512), p = [], i, j, t;
  for (i = 0; i < 256; i++) p[i] = i;
  for (i = 255; i > 0; i--) { j = (r() * (i + 1)) | 0; t = p[i]; p[i] = p[j]; p[j] = t; }
  for (i = 0; i < 512; i++) perm[i] = p[i & 255];
  function g(x, y) { return perm[(perm[x & 255] + (y & 255)) & 255] / 255; }
  return function (x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(g(xi, yi), g(xi + 1, yi), u),
                lerp(g(xi, yi + 1), g(xi + 1, yi + 1), u), v);
  };
}
function fbm(n, x, y) {
  return n(x, y) * 0.55 + n(x * 2.03 + 11.7, y * 2.03 + 5.3) * 0.3 +
         n(x * 4.17 + 3.1, y * 4.17 + 9.7) * 0.15;
}

/* --------------------------------------------------------------- 画布工具 */
function mkCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return c;
}
function hasFilter(c2) { return typeof c2.filter === 'string'; }

function softGlow(c2, px, py, r, rgb, a) {
  if (r <= 0 || a <= 0) return;
  var g = c2.createRadialGradient(px, py, 0, px, py, r);
  g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
  g.addColorStop(0.4, 'rgba(' + rgb + ',' + (a * 0.4) + ')');
  g.addColorStop(1, 'rgba(' + rgb + ',0)');
  c2.fillStyle = g;
  c2.beginPath(); c2.arc(px, py, r, 0, Math.PI * 2); c2.fill();
}

function grainPass(c2, w, h, amount, seed) {
  var t = mkCanvas(96, 96), tc = t.getContext('2d');
  var id = tc.createImageData(96, 96), d = id.data, r = rng32(seed), i, v;
  for (i = 0; i < d.length; i += 4) {
    v = (r() * 255) | 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
    d[i + 3] = (amount * 255) | 0;
  }
  tc.putImageData(id, 0, 0);
  c2.save();
  c2.globalCompositeOperation = 'overlay';
  c2.fillStyle = c2.createPattern(t, 'repeat');
  c2.fillRect(0, 0, w, h);
  c2.restore();
}

function vignettePass(c2, w, h, k) {
  var g = c2.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.22,
                                  w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.55, 'rgba(0,0,0,' + (k * 0.22) + ')');
  g.addColorStop(1, 'rgba(0,0,0,' + k + ')');
  c2.fillStyle = g; c2.fillRect(0, 0, w, h);
}

/* 飘雪：远景细点 + 近景大颗虚化雪片（散景） */
function snowPass(c2, w, h, r, count) {
  var i, sx, sy, rr, aa;
  for (i = 0; i < count; i++) {
    sx = r() * w; sy = r() * h;
    rr = 0.6 + r() * 1.7; aa = 0.14 + r() * 0.5;
    c2.fillStyle = 'rgba(224,234,250,' + aa + ')';
    c2.beginPath(); c2.arc(sx, sy, rr, 0, Math.PI * 2); c2.fill();
  }
  for (i = 0; i < count * 0.1; i++) {
    sx = r() * w; sy = r() * h; rr = 3 + r() * 10; aa = 0.04 + r() * 0.13;
    softGlow(c2, sx, sy, rr, '226,236,252', aa);
  }
}

/* 玻璃外表面质感：擦窗残留的弧形灰迹、受光细边、灰尘纤维。
   以 'lighter' 逐通道累加（R=灰迹 G=受光弧 B=灰尘），互不串色。 */
function makeGlassOverlay(w, h) {
  var cv = mkCanvas(w, h), c2 = cv.getContext('2d'), r = rng32(5150), i;
  var m = Math.min(w, h);
  c2.fillStyle = '#000'; c2.fillRect(0, 0, w, h);
  c2.globalCompositeOperation = 'lighter';
  c2.lineCap = 'round';

  var arcs = [];
  for (i = 0; i < 5; i++) {
    arcs.push({
      x: r() * w, y: r() * h, rad: m * (0.24 + r() * 0.45),
      a0: r() * Math.PI * 2, sw: (0.5 + r() * 1.3) * (r() < 0.5 ? -1 : 1),
      lw: m * (0.05 + r() * 0.13), al: 0.04 + r() * 0.07
    });
  }
  /* 宽幅弧形灰迹：擦窗布留下的半干水痕 */
  for (i = 0; i < arcs.length; i++) {
    c2.strokeStyle = 'rgba(255,0,0,' + arcs[i].al + ')';
    c2.lineWidth = arcs[i].lw;
    c2.beginPath();
    c2.arc(arcs[i].x, arcs[i].y, arcs[i].rad, arcs[i].a0, arcs[i].a0 + arcs[i].sw, arcs[i].sw < 0);
    c2.stroke();
  }
  /* 灰迹两侧的受光细边 */
  c2.lineWidth = Math.max(1, m * 0.004);
  c2.strokeStyle = 'rgba(0,255,0,0.09)';
  for (i = 0; i < arcs.length; i++) {
    var a = arcs[i];
    c2.beginPath();
    c2.arc(a.x, a.y, Math.max(1, a.rad - a.lw / 2), a.a0, a.a0 + a.sw, a.sw < 0);
    c2.stroke();
    c2.beginPath();
    c2.arc(a.x, a.y, a.rad + a.lw / 2, a.a0, a.a0 + a.sw, a.sw < 0);
    c2.stroke();
  }
  /* 斜向宽擦痕 */
  for (i = 0; i < 3; i++) {
    var sx = -w * 0.15 + r() * w * 0.4, sy = r() * h;
    c2.strokeStyle = 'rgba(255,0,0,' + (0.025 + r() * 0.04) + ')';
    c2.lineWidth = m * (0.09 + r() * 0.14);
    c2.beginPath(); c2.moveTo(sx, sy);
    c2.lineTo(sx + w * (0.7 + r() * 0.7), sy + h * (r() - 0.5) * 0.45);
    c2.stroke();
  }
  /* 细划痕受光 */
  c2.lineWidth = Math.max(1, m * 0.0025);
  c2.strokeStyle = 'rgba(0,255,0,0.06)';
  for (i = 0; i < 8; i++) {
    var qx = r() * w, qy = r() * h;
    c2.beginPath(); c2.moveTo(qx, qy);
    c2.lineTo(qx + w * (0.05 + r() * 0.2) * (r() < 0.5 ? -1 : 1), qy + h * (r() - 0.5) * 0.15);
    c2.stroke();
  }
  /* 灰尘与绒毛纤维 */
  for (i = 0; i < 420; i++) {
    c2.fillStyle = 'rgba(0,0,255,' + (0.06 + r() * 0.30) + ')';
    c2.fillRect(r() * w, r() * h, 0.4 + r() * 1.4, 0.4 + r() * 1.4);
  }
  for (i = 0; i < 16; i++) {
    var fx = r() * w, fy = r() * h;
    c2.strokeStyle = 'rgba(0,0,255,' + (0.05 + r() * 0.12) + ')';
    c2.lineWidth = Math.max(0.6, m * 0.0015);
    c2.beginPath(); c2.moveTo(fx, fy);
    c2.lineTo(fx + m * (r() - 0.5) * 0.06, fy + m * (r() - 0.5) * 0.06);
    c2.stroke();
  }
  return cv;
}

/* 电影感调色：暗部沉向午夜蓝，亮部推向暖金 */
function gradePass(c2, w, h, warmth) {
  c2.save();
  c2.globalCompositeOperation = 'soft-light';
  var g = c2.createLinearGradient(0, h, w * 0.5, 0);
  g.addColorStop(0, 'rgba(12,36,72,0.45)');
  g.addColorStop(0.5, 'rgba(90,105,125,0.12)');
  g.addColorStop(1, 'rgba(255,196,120,' + (0.16 + 0.16 * (warmth || 0)) + ')');
  c2.fillStyle = g; c2.fillRect(0, 0, w, h);
  c2.restore();
}
/* 变形宽银幕镜头的横向眩光 */
function anamorphic(c2, x, y, len, rgb, a) {
  if (len <= 0) return;
  var g = c2.createLinearGradient(x - len, y, x + len, y);
  g.addColorStop(0, 'rgba(' + rgb + ',0)');
  g.addColorStop(0.5, 'rgba(' + rgb + ',' + a + ')');
  g.addColorStop(1, 'rgba(' + rgb + ',0)');
  c2.fillStyle = g;
  var hh = Math.max(1.5, len * 0.018);
  c2.fillRect(x - len, y - hh / 2, len * 2, hh);
}

/* ------------------------------------------------------------- 预设场景一：
   冬夜街角 —— 暖金路灯、远处窗光、湿路面碎反光、前景枯枝              */
function sceneStreet(w, h, seed) {
  var cv = mkCanvas(w, h), c2 = cv.getContext('2d'), r = rng32(seed), i, j;

  var sky = c2.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#04070d'); sky.addColorStop(0.34, '#0a1424');
  sky.addColorStop(0.58, '#152b46'); sky.addColorStop(0.67, '#1c3653');
  sky.addColorStop(0.72, '#0e1b2d'); sky.addColorStop(1, '#04070c');
  c2.fillStyle = sky; c2.fillRect(0, 0, w, h);
  softGlow(c2, w * 0.6, h * 0.66, w * 0.5, '255,168,92', 0.09);
  softGlow(c2, w * 0.18, h * 0.68, w * 0.4, '140,175,225', 0.05);

  /* 远景楼群独立成层，便于整体辉光（窗户在雾后成为柔亮色块） */
  var layer = mkCanvas(w, h), lc = layer.getContext('2d'), bx = 0;
  while (bx < w) {
    var bw = w * (0.035 + r() * 0.06), bt = h * (0.38 + r() * 0.2), bbot = h * 0.75;
    lc.fillStyle = 'rgba(6,12,21,0.94)';
    lc.fillRect(bx, bt, bw, bbot - bt);
    if (r() < 0.45) lc.fillRect(bx + bw * 0.28, bt - h * 0.022, bw * 0.16, h * 0.022);
    var cols = Math.max(2, (bw / (w * 0.013)) | 0);
    var rows = Math.max(3, ((bbot - bt) / (h * 0.036)) | 0);
    for (i = 0; i < rows; i++) for (j = 0; j < cols; j++) {
      if (r() > 0.34) continue;
      var wx = bx + bw * (0.12 + ((j + 0.5) / cols) * 0.76);
      var wy = bt + ((i + 0.5) / rows) * (bbot - bt);
      var ww = Math.max(1.5, w * 0.005), wh = Math.max(2, h * 0.010);
      var q = r(), col = q < 0.76 ? '255,180,96' : (q < 0.9 ? '255,218,158' : '146,202,255');
      lc.fillStyle = 'rgba(' + col + ',0.9)';
      lc.fillRect(wx - ww / 2, wy - wh / 2, ww, wh);
    }
    bx += bw * (0.88 + r() * 0.5);
  }
  c2.drawImage(layer, 0, 0);
  c2.save();
  c2.globalCompositeOperation = 'lighter'; c2.globalAlpha = 0.5;
  if (hasFilter(c2)) c2.filter = 'blur(' + Math.max(4, w * 0.006) + 'px)';
  c2.drawImage(layer, 0, 0);
  c2.restore();

  /* 街边店铺的一线暖光：画面的暖色重心 */
  var shopG = c2.createLinearGradient(0, h * 0.65, 0, h * 0.74);
  shopG.addColorStop(0, 'rgba(255,170,80,0)');
  shopG.addColorStop(0.6, 'rgba(255,178,92,0.16)');
  shopG.addColorStop(1, 'rgba(255,160,70,0)');
  c2.fillStyle = shopG; c2.fillRect(0, h * 0.65, w, h * 0.09);
  softGlow(c2, w * 0.42, h * 0.70, Math.min(w, h) * 0.20, '255,172,86', 0.16);
  /* 远处信号灯：一点青、一点红，打破单一暖调 */
  softGlow(c2, w * 0.63, h * 0.60, Math.min(w, h) * 0.05, '90,220,255', 0.28);
  softGlow(c2, w * 0.66, h * 0.61, Math.min(w, h) * 0.035, '255,90,70', 0.20);

  /* 路面 */
  var road = c2.createLinearGradient(0, h * 0.72, 0, h);
  road.addColorStop(0, 'rgba(12,20,33,0.45)');
  road.addColorStop(0.3, 'rgba(8,14,24,0.92)');
  road.addColorStop(1, '#04070c');
  c2.fillStyle = road; c2.fillRect(0, h * 0.72, w, h * 0.28);
  /* 车道虚线：透视消失点带来纵深 */
  for (i = 0; i < 14; i++) {
    var lt = i / 14;
    var ly = h * 0.73 + Math.pow(lt, 1.8) * h * 0.27;
    var llen = h * 0.006 + lt * lt * h * 0.05;
    var lww = w * 0.002 + lt * lt * w * 0.013;
    c2.fillStyle = 'rgba(198,210,228,' + (0.04 + 0.10 * lt) + ')';
    c2.fillRect(w * 0.5 - lww / 2, ly, lww, llen);
  }

  /* 路灯 + 湿路面碎光 */
  var lamps = [{ x: w * 0.24, y: h * 0.56 }, { x: w * 0.74, y: h * 0.53 }];
  for (i = 0; i < lamps.length; i++) {
    var lp = lamps[i], hx = lp.x + w * 0.022;
    c2.strokeStyle = '#03060a'; c2.lineWidth = Math.max(2, w * 0.0032);
    c2.beginPath(); c2.moveTo(lp.x, h * 0.96); c2.lineTo(lp.x, lp.y + h * 0.01); c2.stroke();
    c2.beginPath(); c2.moveTo(lp.x, lp.y + h * 0.012); c2.lineTo(hx, lp.y); c2.stroke();
    softGlow(c2, hx, lp.y, Math.min(w, h) * 0.2, '255,182,104', 0.5);
    softGlow(c2, hx, lp.y, Math.min(w, h) * 0.05, '255,226,178', 0.9);
    c2.fillStyle = '#fff4e0';
    c2.beginPath(); c2.arc(hx, lp.y, Math.max(2, Math.min(w, h) * 0.007), 0, Math.PI * 2); c2.fill();
    /* 光锥 + 变形镜头眩光 */
    var cone = c2.createLinearGradient(0, lp.y, 0, h * 0.96);
    cone.addColorStop(0, 'rgba(255,192,116,0.10)');
    cone.addColorStop(1, 'rgba(255,178,98,0)');
    c2.fillStyle = cone;
    c2.beginPath(); c2.moveTo(hx, lp.y);
    c2.lineTo(hx - w * 0.085, h * 0.96); c2.lineTo(hx + w * 0.085, h * 0.96);
    c2.closePath(); c2.fill();
    anamorphic(c2, hx, lp.y, Math.min(w, h) * 0.24, '255,196,128', 0.20);
    for (j = 0; j < 24; j++) {
      var t = j / 24, ry = h * 0.74 + t * h * 0.24;
      var al = (1 - t) * 0.13 * (0.45 + r() * 0.9);
      var dw2 = w * (0.008 + 0.045 * (1 - t)) * (0.4 + r() * 0.9);
      c2.fillStyle = 'rgba(255,172,92,' + al + ')';
      c2.fillRect(hx - dw2 / 2 + (r() - 0.5) * w * 0.012, ry, dw2, Math.max(1, h * 0.004));
    }
  }
  /* 远处驶来的车灯 */
  softGlow(c2, w * 0.52, h * 0.705, Math.min(w, h) * 0.03, '255,240,210', 0.55);
  softGlow(c2, w * 0.545, h * 0.705, Math.min(w, h) * 0.03, '255,240,210', 0.55);
  anamorphic(c2, w * 0.533, h * 0.705, Math.min(w, h) * 0.10, '255,225,170', 0.14);

  /* 窗光碎反光 */
  for (i = 0; i < 3; i++) {
    var rx = w * (0.34 + r() * 0.42), rc = r() < 0.7 ? '255,180,100' : '150,200,255';
    for (j = 0; j < 10; j++) {
      var t2 = j / 10;
      c2.fillStyle = 'rgba(' + rc + ',' + (0.06 * (1 - t2) * (0.4 + r())) + ')';
      var rw = w * 0.02 * (0.4 + r());
      c2.fillRect(rx - rw / 2 + (r() - 0.5) * w * 0.02,
                  h * 0.74 + t2 * h * 0.18, rw, Math.max(1, h * 0.003));
    }
  }

  /* 前景枯枝（暗剪影，增加景深层次） */
  function branch(x0, y0, ang, len, wd, depth) {
    if (depth <= 0 || len < w * 0.004) return;
    var x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
    c2.strokeStyle = '#020408'; c2.lineWidth = wd; c2.lineCap = 'round';
    c2.beginPath(); c2.moveTo(x0, y0); c2.lineTo(x1, y1); c2.stroke();
    branch(x1, y1, ang - 0.22 - r() * 0.4, len * (0.66 + r() * 0.18), wd * 0.66, depth - 1);
    branch(x1, y1, ang + 0.20 + r() * 0.42, len * (0.64 + r() * 0.20), wd * 0.62, depth - 1);
    if (r() < 0.45) branch(x1, y1, ang + (r() - 0.5) * 0.3, len * 0.78, wd * 0.5, depth - 1);
  }
  branch(w * 0.05, h * 1.0, -Math.PI / 2 + 0.18, h * 0.15, Math.max(3, w * 0.006), 7);
  branch(w * 0.98, h * 1.02, -Math.PI / 2 - 0.25, h * 0.1, Math.max(2, w * 0.004), 6);

  gradePass(c2, w, h, 1.0);
  snowPass(c2, w, h, r, 320);
  grainPass(c2, w, h, 0.07, seed + 7);
  vignettePass(c2, w, h, 0.62);
  return cv;
}

/* ------------------------------------------------------------- 预设场景二：
   月下松林 —— 冷月、三层林带空气透视、层间雾带、雪地                  */
function scenePines(w, h, seed) {
  var cv = mkCanvas(w, h), c2 = cv.getContext('2d'), r = rng32(seed), i, j;

  var sky = c2.createLinearGradient(0, 0, 0, h * 0.85);
  sky.addColorStop(0, '#04080f'); sky.addColorStop(0.4, '#0a1a2b');
  sky.addColorStop(0.75, '#153247'); sky.addColorStop(1, '#1c3b50');
  c2.fillStyle = sky; c2.fillRect(0, 0, w, h);

  var mx = w * 0.74, my = h * 0.19, mr = Math.min(w, h) * 0.05;
  for (i = 0; i < 240; i++) {
    var sx = r() * w, sy = r() * h * 0.6, dx = sx - mx, dy = sy - my;
    if (dx * dx + dy * dy < (mr * 4.5) * (mr * 4.5)) continue;
    c2.fillStyle = 'rgba(218,230,250,' + (0.18 + r() * 0.6) + ')';
    var sr = r() < 0.07 ? 1.6 : 0.9;
    c2.fillRect(sx, sy, sr, sr);
  }
  /* 极淡的银河带 */
  c2.save();
  c2.translate(w * 0.35, h * 0.26); c2.rotate(-0.45);
  if (hasFilter(c2)) c2.filter = 'blur(' + Math.max(4, w * 0.006) + 'px)';
  c2.fillStyle = 'rgba(150,175,215,0.05)';
  c2.beginPath(); c2.ellipse(0, 0, w * 0.5, h * 0.06, 0, 0, Math.PI * 2); c2.fill();
  c2.restore();
  softGlow(c2, mx, my, mr * 6, '148,182,228', 0.13);
  softGlow(c2, mx, my, mr * 2, '190,214,244', 0.34);
  var mg = c2.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, mr * 0.08, mx, my, mr);
  mg.addColorStop(0, '#f6f9ff'); mg.addColorStop(0.75, '#e2ecf8'); mg.addColorStop(1, '#c8d7ea');
  c2.fillStyle = mg; c2.beginPath(); c2.arc(mx, my, mr, 0, Math.PI * 2); c2.fill();
  c2.fillStyle = 'rgba(148,168,196,0.16)';
  for (i = 0; i < 5; i++) {
    var ma = r() * Math.PI * 2, md = r() * mr * 0.6;
    c2.beginPath();
    c2.arc(mx + Math.cos(ma) * md, my + Math.sin(ma) * md, mr * (0.08 + r() * 0.14), 0, Math.PI * 2);
    c2.fill();
  }
  c2.save();
  if (hasFilter(c2)) c2.filter = 'blur(' + Math.max(6, w * 0.012) + 'px)';
  c2.fillStyle = 'rgba(120,150,192,0.09)';
  c2.beginPath(); c2.ellipse(w * 0.42, h * 0.15, w * 0.4, h * 0.028, 0.04, 0, Math.PI * 2); c2.fill();
  c2.fillStyle = 'rgba(130,160,200,0.07)';
  c2.beginPath(); c2.ellipse(w * 0.7, h * 0.3, w * 0.3, h * 0.02, -0.03, 0, Math.PI * 2); c2.fill();
  c2.restore();

  /* 雪地（先画地面，树木立于其上） */
  var gg = c2.createLinearGradient(0, h * 0.78, 0, h);
  gg.addColorStop(0, '#1d3349'); gg.addColorStop(0.5, '#14263a'); gg.addColorStop(1, '#0a1524');
  c2.fillStyle = gg; c2.fillRect(0, h * 0.78, w, h * 0.22);
  softGlow(c2, mx, h * 0.9, w * 0.22, '190,212,240', 0.09);
  for (i = 0; i < 12; i++) {
    c2.fillStyle = 'rgba(160,190,222,' + (0.02 + r() * 0.04) + ')';
    c2.beginPath();
    c2.ellipse(r() * w, h * (0.8 + r() * 0.2), w * (0.06 + r() * 0.16),
               h * (0.006 + r() * 0.016), (r() - 0.5) * 0.2, 0, Math.PI * 2);
    c2.fill();
  }
  /* 雪面星点反光 */
  for (i = 0; i < 130; i++) {
    c2.fillStyle = 'rgba(225,236,252,' + (0.08 + r() * 0.30) + ')';
    c2.fillRect(r() * w, h * (0.79 + r() * 0.21), 0.7 + r() * 1.1, 0.7 + r() * 1.1);
  }

  function pine(cx0, baseY, ph, pw, col) {
    var pts = [[cx0, baseY - ph]], tiers = 6, t, f, y, hw;
    for (t = 1; t <= tiers; t++) {
      f = t / tiers; y = baseY - ph + ph * Math.pow(f, 1.05); hw = pw * 0.5 * Math.pow(f, 0.9);
      pts.push([cx0 + hw * 0.4, y - ph * 0.05]);
      pts.push([cx0 + hw, y]);
      pts.push([cx0 + hw * 0.32, y + ph * 0.016]);
    }
    pts.push([cx0 + pw * 0.05, baseY]);
    c2.fillStyle = col; c2.beginPath();
    c2.moveTo(pts[0][0], pts[0][1]);
    for (t = 1; t < pts.length; t++) c2.lineTo(pts[t][0], pts[t][1]);
    for (t = pts.length - 1; t >= 0; t--) c2.lineTo(2 * cx0 - pts[t][0], pts[t][1]);
    c2.closePath(); c2.fill();
  }

  var layers = [
    { n: 26, col: '#203a52', hh: 0.34 },
    { n: 18, col: '#122638', hh: 0.40 },
    { n: 12, col: '#070f1b', hh: 0.46 }
  ];
  for (i = 0; i < layers.length; i++) {
    var L = layers[i];
    for (j = 0; j < L.n; j++) {
      var px = (j + 0.5 + (r() - 0.5) * 0.7) * (w / L.n);
      var ph = h * L.hh * (0.6 + r() * 0.65);
      var pw = ph * (0.32 + r() * 0.2);
      pine(px, h * (0.64 + r() * 0.14) + i * h * 0.04, ph, pw, L.col);
    }
    if (i < layers.length - 1) {
      var fy = h * (0.6 + i * 0.09);
      var fg = c2.createLinearGradient(0, fy - h * 0.07, 0, fy + h * 0.07);
      fg.addColorStop(0, 'rgba(160,190,220,0)');
      fg.addColorStop(0.5, 'rgba(160,190,220,' + (0.09 - i * 0.015) + ')');
      fg.addColorStop(1, 'rgba(160,190,220,0)');
      c2.fillStyle = fg; c2.fillRect(0, fy - h * 0.07, w, h * 0.14);
    }
  }

  /* 林间小屋的一扇暖窗：全画面唯一的暖色焦点 */
  var cbx = w * 0.26, cby = h * 0.675;
  c2.fillStyle = '#050b13';
  c2.fillRect(cbx - w * 0.028, cby - h * 0.03, w * 0.056, h * 0.03);
  c2.beginPath();
  c2.moveTo(cbx - w * 0.035, cby - h * 0.03);
  c2.lineTo(cbx, cby - h * 0.054);
  c2.lineTo(cbx + w * 0.035, cby - h * 0.03);
  c2.closePath(); c2.fill();
  c2.fillStyle = 'rgba(255,186,96,0.92)';
  c2.fillRect(cbx - w * 0.009, cby - h * 0.024, w * 0.018, h * 0.015);
  softGlow(c2, cbx, cby - h * 0.017, Math.min(w, h) * 0.07, '255,175,85', 0.45);
  anamorphic(c2, cbx, cby - h * 0.017, Math.min(w, h) * 0.06, '255,190,110', 0.10);

  gradePass(c2, w, h, 0.25);
  snowPass(c2, w, h, r, 260);
  grainPass(c2, w, h, 0.06, seed + 13);
  vignettePass(c2, w, h, 0.6);
  return cv;
}

/* ------------------------------------------------------------- 预设场景三：
   暖窗焦外 —— 大颗粒暖金散景、青蓝点缀、横向眩光、前景栏杆            */
function sceneBokeh(w, h, seed) {
  var cv = mkCanvas(w, h), c2 = cv.getContext('2d'), r = rng32(seed), i, j, k;

  var bg = c2.createRadialGradient(w * 0.45, h * 0.38, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
  bg.addColorStop(0, '#162943'); bg.addColorStop(0.5, '#0c182a'); bg.addColorStop(1, '#04070d');
  c2.fillStyle = bg; c2.fillRect(0, 0, w, h);
  /* 画面外的一盏大灯：斜向暖光渐变 */
  var warmG = c2.createRadialGradient(w * 0.86, h * 0.30, 0, w * 0.86, h * 0.30, Math.max(w, h) * 0.7);
  warmG.addColorStop(0, 'rgba(255,180,90,0.16)');
  warmG.addColorStop(0.4, 'rgba(255,160,80,0.07)');
  warmG.addColorStop(1, 'rgba(255,150,70,0)');
  c2.fillStyle = warmG; c2.fillRect(0, 0, w, h);

  for (i = 0; i < 6; i++) {
    var by = h * (0.14 + i * 0.115) + (r() - 0.5) * h * 0.04;
    var n = 4 + ((r() * 7) | 0);
    for (k = 0; k < n; k++) {
      var bx = w * (0.04 + r() * 0.92);
      var rad = Math.min(w, h) * (0.022 + r() * 0.07);
      var q = r();
      var col = q < 0.66 ? '255,176,92' : (q < 0.80 ? '255,214,150' :
                (q < 0.92 ? '120,190,255' : '255,122,98'));
      var g = c2.createRadialGradient(bx, by, 0, bx, by, rad);
      g.addColorStop(0, 'rgba(' + col + ',' + (0.16 + r() * 0.14) + ')');
      g.addColorStop(0.6, 'rgba(' + col + ',' + (0.14 + r() * 0.10) + ')');
      g.addColorStop(0.85, 'rgba(' + col + ',' + (0.26 + r() * 0.20) + ')');
      g.addColorStop(0.95, 'rgba(' + col + ',0.09)');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      c2.fillStyle = g;
      c2.beginPath(); c2.arc(bx, by, rad, 0, Math.PI * 2); c2.fill();
      if (r() < 0.15) {
        c2.fillStyle = 'rgba(' + col + ',0.05)';
        c2.fillRect(bx - rad * 3.2, by - rad * 0.05, rad * 6.4, rad * 0.1);
      }
    }
  }

  /* 近景的大颗散景：贴近镜头的灯珠 */
  for (i = 0; i < 7; i++) {
    var lx = r() * w, ly = r() * h, lr = Math.min(w, h) * (0.09 + r() * 0.08);
    var lq = r(), lcol = lq < 0.60 ? '255,190,110' : (lq < 0.82 ? '255,220,160' : '140,205,255');
    var lg = c2.createRadialGradient(lx, ly, 0, lx, ly, lr);
    lg.addColorStop(0, 'rgba(' + lcol + ',0.06)');
    lg.addColorStop(0.78, 'rgba(' + lcol + ',0.09)');
    lg.addColorStop(0.92, 'rgba(' + lcol + ',0.17)');
    lg.addColorStop(1, 'rgba(' + lcol + ',0)');
    c2.fillStyle = lg;
    c2.beginPath(); c2.arc(lx, ly, lr, 0, Math.PI * 2); c2.fill();
  }
  /* 深处清晰的小光点：在一片虚焦里给出锐度与尺度 */
  for (i = 0; i < 60; i++) {
    var dpx = r() * w, dpy = h * (0.08 + r() * 0.6), dp = r();
    var dpc = dp < 0.70 ? '255,205,140' : '170,215,255';
    c2.fillStyle = 'rgba(' + dpc + ',' + (0.25 + r() * 0.45) + ')';
    c2.fillRect(dpx, dpy, 0.8 + r() * 1.4, 0.8 + r() * 1.4);
    if (r() < 0.15) {
      softGlow(c2, dpx, dpy, 4 + r() * 8,
               dp < 0.70 ? '255,200,130' : '150,205,255', 0.10);
    }
  }

  /* 前景暗剪影：屋檐斜线 + 右侧栏杆 */
  c2.fillStyle = '#03060a';
  c2.beginPath();
  c2.moveTo(0, h); c2.lineTo(0, h * 0.8); c2.lineTo(w * 0.6, h); c2.closePath(); c2.fill();
  for (i = 0; i < 4; i++) c2.fillRect(w * (0.8 + i * 0.06), h * 0.55, Math.max(2, w * 0.006), h * 0.45);
  c2.fillRect(w * 0.76, h * 0.6, w * 0.3, Math.max(3, h * 0.008));

  /* 右上角伸入画面的枯枝：近景剪影框住构图 */
  function twig(x0, y0, ang, len, wd, depth) {
    if (depth <= 0 || len < w * 0.006) return;
    var x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
    c2.strokeStyle = '#04070c'; c2.lineWidth = wd; c2.lineCap = 'round';
    c2.beginPath(); c2.moveTo(x0, y0); c2.lineTo(x1, y1); c2.stroke();
    twig(x1, y1, ang - 0.30 - r() * 0.5, len * (0.65 + r() * 0.15), wd * 0.65, depth - 1);
    twig(x1, y1, ang + 0.28 + r() * 0.5, len * (0.62 + r() * 0.18), wd * 0.60, depth - 1);
  }
  twig(w * 1.02, -h * 0.02, Math.PI * 0.72, Math.min(w, h) * 0.20, Math.max(4, w * 0.008), 6);

  gradePass(c2, w, h, 0.85);
  snowPass(c2, w, h, r, 300);
  grainPass(c2, w, h, 0.07, seed + 21);
  vignettePass(c2, w, h, 0.66);
  return cv;
}

// Photos are local, metadata-free exports. Focus points keep the subject in a landscape crop.
var SCENES = [
  {"id": 1, "name": "阳光与云海", "file": "assets/photos/cloud-dusk.jpg", "thumb": "assets/photos/thumbs/cloud-dusk.jpg", "focus": [0.28, 0.46], "tint": [0.93, 0.91, 0.87], "saturation": 0.78, "flight": true, "make": scenePines, "seed": 90210 },
  {"id": 2, "name": "云海之上", "file": "assets/photos/cloud-sea.jpg", "thumb": "assets/photos/thumbs/cloud-sea.jpg", "focus": [0.5, 0.45], "tint": [0.89, 0.92, 0.94], "saturation": 0.82, "flight": true, "make": scenePines, "seed": 90210 },
  {"id": 3, "name": "雪谷", "file": "assets/photos/winter-valley.jpg", "thumb": "assets/photos/thumbs/winter-valley.jpg", "focus": [0.51, 0.51], "tint": [0.89, 0.92, 0.94], "saturation": 0.58, "flight": false, "make": scenePines, "seed": 90210 },
  {"id": 4, "name": "雪地暖灯", "file": "assets/photos/snow-cabin.jpg", "thumb": "assets/photos/thumbs/snow-cabin.jpg", "focus": [0.57, 0.68], "tint": [0.89, 0.92, 0.94], "saturation": 0.6, "flight": false, "make": scenePines, "seed": 90210 },
  {"id": 7, "name": "船上的蓝调时刻", "file": "assets/photos/ferry-dusk.jpg", "thumb": "assets/photos/thumbs/ferry-dusk.jpg", "focus": [0.58, 0.44], "tint": [0.89, 0.92, 0.94], "saturation": 0.65, "flight": false, "make": scenePines, "seed": 90210 },
  {"id": 14, "name": "暮色广场", "file": "assets/photos/evening-square.jpg", "thumb": "assets/photos/thumbs/evening-square.jpg", "focus": [0.5, 0.45], "tint": [0.89, 0.92, 0.94], "saturation": 0.65, "flight": false, "make": scenePines, "seed": 90210 },
  {"id": 18, "name": "河上的灯火", "file": "assets/photos/river-lights.jpg", "thumb": "assets/photos/thumbs/river-lights.jpg", "focus": [0.5, 0.48], "tint": [0.93, 0.91, 0.87], "saturation": 0.6, "flight": false, "make": scenePines, "seed": 90210 },
  {"id": 20, "name": "一起看日落", "file": "assets/photos/wing-sunset.jpg", "thumb": "assets/photos/thumbs/wing-sunset.jpg", "focus": [0.52, 0.48], "tint": [0.89, 0.92, 0.94], "saturation": 0.7, "flight": false, "make": scenePines, "seed": 90210 }
];
var originalLook = /(?:[?&])look=original(?:&|$)/.test(location.search);
var softMist = !originalLook && !/(?:[?&])look=previous(?:&|$)/.test(location.search);
var debugMode = /(?:[?&])debug(?:[=&]|$)/.test(location.search);
var sceneMatch = location.search.match(/[?&]scene=(1[0-9]|[0-9])(?:&|$)/);
var windowMatch = location.search.match(/[?&]window=([0-4])(?:&|$)/);
// Preserve the original photo numbers and bookmarked scene URLs after curation.
var initialScene = sceneMatch ? SCENES.findIndex(function (scene) { return scene.id === Number(sceneMatch[1]) + 1; }) : (windowMatch && Number(windowMatch[1]) === 2 ? 2 : 0);

var photoUse = 0;
function loadScene(index) {
  var scene = SCENES[index];
  scene.used = ++photoUse;
  if (scene.image || scene.loading || scene.failed) return;
  scene.loading = true;
  if (!scene.preview) {
    var preview = new Image();
    preview.onload = function () { scene.preview = preview; if (S.sceneIndex === index && !S.customImg && !scene.image) buildBackground(); };
    preview.src = scene.thumb;
  }
  var image = new Image();
  image.onload = function () {
    scene.image = image; scene.loading = false;
    // Retain only three full-size images; the contact sheet uses tiny exports.
    var cached = SCENES.filter(function (item) { return item.image && item !== SCENES[S.sceneIndex]; });
    cached.sort(function (a, b) { return b.used - a.used; });
    while (cached.length > 2) cached.pop().image = null;
    if (S.sceneIndex === index && !S.customImg) { buildBackground(); loadScene((index + 1) % SCENES.length); }
  };
  image.onerror = function () {
    scene.failed = true; scene.loading = false;
    if (S.sceneIndex === index && !S.customImg) {
      buildBackground(); showToast('照片未能加载，暂用绘制场景', 2600);
    }
  };
  image.src = scene.file;
}


/* ------------------------------------------------------------------ 全局状态 */
var S = {
  cssW: 0, cssH: 0, dpr: 1, bufW: 1, bufH: 1,
  sceneIndex: Math.max(0, initialScene), customImg: null,
  micOn: false, micLevel: 0, micEnv: 0,
  micDriftX: 0, micDriftY: 0, micDriftT: 0, micDriftA: 0,
  holdLevel: 0, holdX: 0, holdY: 0, manualHeld: false,
  space: false, spaceLevel: 0,
  breathLevel: 0, breathX: 0.5, breathY: 0.47, breathR: 0.16, sustain: 0,
  lastPointer: { x: 0.5, y: 0.47, t: 0 },
  pointerType: 'mouse', pointerId: null,
  down: false, mode: 'wipe', downT: 0, lastMoveT: 0,
  lastX: 0.5, lastY: 0.47, downX: 0.5, downY: 0.47,
  windowStyle: windowMatch && Number(windowMatch[1]) === 0 ? 0 : windowMatch && Number(windowMatch[1]) === 2 ? 2 : 4,
  rainAmt: 0, snowAmt: 0, melt: 1,
  weather: 'clear', weatherLevel: 0,
  wind: 0, windTarget: 0, windT: 0,
  lastTapT: 0, lastTapX: 0.5, lastTapY: 0.47,
  time: 0
};

var frameCanvas, aperture = null;
var stage, glass, flat, flatCtx, hintEl, labelEl, toastEl,
    btnMic, btnBreath, btnMelt, btnScene, btnWeather, btnWindow, btnUpload, fileEl;
var useGL = false, gl = null, prog = null, U = null;
var fogTex = null, dropTex = null, grainTex = null;
var fogTexReady = false, dropTexReady = false;
var BG = { sharp: null, blurA: null, blurB: null, glass: null, t0: null, t1: null, t2: null, tg: null };

var qualityTier = 0;
var fogSum = 0;
/* 消散三档：蒸发 / 环境重凝 / 边缘扩散 的倍率 */
var MELT = [
  { ev: 0.45, am: 0.55, ac: 0.55, df: 0.60 },
  { ev: 1.00, am: 1.00, ac: 1.00, df: 1.00 },
  { ev: 1.95, am: 1.65, ac: 1.60, df: 1.45 }
];
// Slow evaporation, wet-mark fading and edge refill together, independently of drops.
var MELT_TIME = 0.80;
var toastTimer = null, labelTimer = null;
var hintHidden = false;
var strokeDist = 0;

/* ================================================================ 雾气模拟 */
/* 密度贴图（density canvas）：
   R = 可见水汽密度  G = 湿痕（擦拭留下的潮湿）  B = 裸露程度（擦除历史）
   WebGL 模式下 A=255（干净存储）；2D 降级模式下 A=密度（作为合成蒙版）。  */

var dw = 0, dh = 0, flen = 0, densityScale = 0.1;
var fogF = null, wetF = null, bareF = null;
var ambF = null, accK = null, evpN = null, dotN = null;
var scratchF = null;
var fogCanvas = null, fogCtx = null, fogImg = null, fogBuf = null;
var dropCanvas = null, dropCtx = null, dropImg = null, dropBuf = null;
var drops = [];
var naturalAcc = 0;

/* 外层降雨（窗户外侧，位于雾气层之后） */
var rainDrops = [], rainAcc = 0;
var snowFlakes = [], snowAcc = 0;
var rainStreaks = [];
var rainIntensity = 0, rainTarget = 0;
var rainScale = 0.5, rw = 0, rh = 0;
var rainTrailC = null, rainTrailCtx = null;
var rainHeadC = null, rainHeadCtx = null;
var snowC = null, snowCtx = null;
var rainCanvas = null, rainCtx = null;
var rainTex = null, rainTexReady = false;

var BK = 56, breathKernel = null;

function makeBreathKernel() {
  var n = noise2D(31337), K = BK, a = new Float32Array(K * K), x, y, i;
  for (y = 0; y < K; y++) for (x = 0; x < K; x++) {
    i = y * K + x;
    var nx = (x + 0.5) / K * 2 - 1, ny = (y + 0.5) / K * 2 - 1;
    /* 域扭曲：雾团边缘呈羽化卷须状，而非光滑圆斑 */
    var wx = nx + (n(nx * 1.8 + 21, ny * 1.8 + 13) * 2 - 1) * 0.17;
    var wy = ny + (n(nx * 1.8 + 41, ny * 1.8 + 29) * 2 - 1) * 0.17;
    var rr = Math.sqrt(wx * wx + wy * wy);
    var lobes = 0.60 + 0.60 * n(wx * 3.1 + 8, wy * 3.1 + 8);
    var v = 1 - sstep(lobes * 0.28, lobes, rr);
    var fine = 0.66 + 0.60 * n(wx * 7.5 + 3, wy * 7.5 + 3);
    a[i] = clamp(v * fine, 0, 1);
  }
  return a;
}

function simSize() {
  /* 手机只受基准步长限制；大屏提高密度图精度，让笔画曲线更顺 */
  var big = Math.min(S.cssW, S.cssH) >= 600;
  var cap = qualityTier === 0 ? (big ? 320000 : 240000) : (big ? 170000 : 120000);
  var base = 1 / 1.7;
  var s = Math.min(base, Math.sqrt(cap / Math.max(1, S.cssW * S.cssH)));
  return {
    w: Math.max(64, Math.round(S.cssW * s)),
    h: Math.max(64, Math.round(S.cssH * s)),
    s: s
  };
}

function buildStaticFields() {
  var n = noise2D(4242), nf = noise2D(8484), x, y, i;
  ambF = new Float32Array(flen);
  accK = new Float32Array(flen);
  evpN = new Float32Array(flen);
  dotN = new Float32Array(flen);   /* 重凝结成核点：笔迹由一粒粒水珠填满 */
  for (y = 0; y < dh; y++) for (x = 0; x < dw; x++) {
    i = y * dw + x;
    var a = fbm(n, x / 26, y / 26);
    var b = n(x / 9 + 40, y / 9 + 17);
    /* 窗框最冷：四边环境凝结势更高（真实冷窗的凝结分布） */
    var fxx = (x + 0.5) / dw * 2 - 1, fyy = (y + 0.5) / dh * 2 - 1;
    var fo = Math.max(Math.abs(fxx), Math.abs(fyy));
    var coldEdge = 0.85 + 0.35 * sstep(0.5, 1.0, fo);
    ambF[i] = clamp(0.014 + 0.030 * a + 0.010 * b, 0.010, 0.055) * coldEdge;
    var c = nf(x / 7, y / 7);
    accK[i] = 0.0008 + 0.0008 * c;
    evpN[i] = 0.0013 + 0.0010 * nf(x / 5 + 31, y / 5 + 53);
    dotN[i] = sstep(0.44, 0.72, nf(x / 3.2 + 77, y / 3.2 + 19));
  }
}

function initFogArrays() {
  var n = noise2D(777), x, y, i;
  fogF = new Float32Array(flen);
  wetF = new Float32Array(flen);
  bareF = new Float32Array(flen);
  for (y = 0; y < dh; y++) for (x = 0; x < dw; x++) {
    i = y * dw + x;
    var p = fbm(n, x / 46, y / 46);
    var p2 = n(x / 13 + 9, y / 13 + 31);
    fogF[i] = clamp(0.46 + 0.32 * p + 0.06 * p2, 0.20, 0.86);
  }
}

function setupSim(preserve) {
  var sz = simSize();
  if (preserve && fogCanvas && dw > 0 && (sz.w !== dw || sz.h !== dh)) {
    /* 尺寸变化时拉伸旧密度图，保留用户已擦出的笔迹 */
    var old = fogCanvas, oFog = fogF, oWet = wetF, oBare = bareF, oW = dw, oH = dh;
    var nc = mkCanvas(sz.w, sz.h), n2 = nc.getContext('2d');
    n2.imageSmoothingEnabled = true;
    n2.drawImage(old, 0, 0, sz.w, sz.h);
    dw = sz.w; dh = sz.h; flen = dw * dh; densityScale = sz.s;
    fogF = new Float32Array(flen); wetF = new Float32Array(flen); bareF = new Float32Array(flen);
    for (var i = 0; i < flen; i++) {
      var x = i % dw, y = (i / dw) | 0;
      var ox = Math.min(oW - 1, (x * oW / dw) | 0), oy = Math.min(oH - 1, (y * oH / dh) | 0);
      var oi = oy * oW + ox;
      fogF[i] = oFog[oi]; wetF[i] = oWet[oi]; bareF[i] = oBare[oi];
    }
    fogCanvas = nc; fogCtx = n2;
  } else {
    dw = sz.w; dh = sz.h; flen = dw * dh; densityScale = sz.s;
    fogCanvas = mkCanvas(dw, dh);
    fogCtx = fogCanvas.getContext('2d');
    initFogArrays();
  }
  buildStaticFields();
  fogImg = fogCtx.createImageData(dw, dh); fogBuf = fogImg.data;
  dropCanvas = mkCanvas(dw, dh); dropCtx = dropCanvas.getContext('2d');
  dropImg = dropCtx.createImageData(dw, dh); dropBuf = dropImg.data;
  drops.length = 0;
  scratchF = new Float32Array(flen);
  setupRain();
}

/* 呼气沉积：以不规则卷积核在焦点处叠加密度 */
function depositOne(ox, oy, R, amp) {
  var x0 = Math.max(0, Math.floor(ox - R)), x1 = Math.min(dw - 1, Math.ceil(ox + R));
  var y0 = Math.max(0, Math.floor(oy - R)), y1 = Math.min(dh - 1, Math.ceil(oy + R));
  var half = BK / 2, px, py, kx, ky;
  for (py = y0; py <= y1; py++) for (px = x0; px <= x1; px++) {
    kx = ((px + 0.5 - ox) / R) * half + half;
    ky = ((py + 0.5 - oy) / R) * half + half;
    if (kx < 0 || kx >= BK || ky < 0 || ky >= BK) continue;
    fogF[py * dw + px] += amp * breathKernel[(ky | 0) * BK + (kx | 0)];
  }
}

function applyBreath(dt, f) {
  if (S.breathLevel < 0.004) {
    S.sustain -= dt * 1.5;
    if (S.sustain < 0) S.sustain = 0;
    return;
  }
  S.sustain += dt;
  if (S.sustain > 4) S.sustain = 4;
  var su = clamp(S.sustain / 2.2, 0, 1);
  var minD = Math.min(dw, dh);
  /* 持续呼气：范围扩大、强度增加（逐渐加重） */
  var R = S.breathR * minD * (0.62 + 0.55 * su);
  var amp = 0.020 * S.breathLevel * (0.65 + 0.60 * su) * 0.75 * f;
  var ang = S.time * 0.9;
  depositOne(S.breathX * dw + Math.cos(ang) * R * 0.10,
             S.breathY * dh + Math.sin(ang * 1.3) * R * 0.08, R, amp);
  depositOne(S.breathX * dw + Math.cos(ang + 2.1) * R * 0.28,
             S.breathY * dh + Math.sin(ang + 2.1) * R * 0.24, R * 0.62, amp * 0.70);
}

/* 擦拭笔触：中心强擦除、外缘弱擦除并留下湿痕 */
function stampWipe(cx, cy, R) {
  if (R < 0.6) return null;
  var x0 = Math.max(0, Math.floor(cx - R * 1.3)), x1 = Math.min(dw - 1, Math.ceil(cx + R * 1.3));
  var y0 = Math.max(0, Math.floor(cy - R * 1.3)), y1 = Math.min(dh - 1, Math.ceil(cy + R * 1.3));
  var px, py, i;
  for (py = y0; py <= y1; py++) for (px = x0; px <= x1; px++) {
    var dx = px - cx, dy = py - cy;
    var q = Math.sqrt(dx * dx + dy * dy) / R;
    if (q > 1.3) continue;
    i = py * dw + px;
    var erase = q < 0.6 ? 0.95 : (0.95 * (1 - sstep(0.6, 1.18, q)) + 0.05);
    fogF[i] *= (1 - erase);
    var wv = (1 - sstep(0.15, 1.25, q)) * 0.95;
    if (wv > wetF[i]) wetF[i] = wv;
    var bv = 1 - sstep(0.3, 1.3, q);
    if (bv > bareF[i]) bareF[i] = bv;
  }
  return { i: (clamp(cy | 0, 0, dh - 1) * dw + clamp(cx | 0, 0, dw - 1)), x: cx, y: cy };
}

function wipeSegment(x0, y0, x1, y1, R) {
  var dx = x1 - x0, dy = y1 - y0;
  var len = Math.sqrt(dx * dx + dy * dy);
  var steps = Math.ceil(len / Math.max(0.8, R * 0.33));
  if (steps > 90) steps = 90;
  var last = null, s, t, p;
  for (s = 0; s <= steps; s++) {
    t = steps === 0 ? 0 : s / steps;
    p = stampWipe(x0 + dx * t, y0 + dy * t, R);
    if (p) last = p;
  }
  return last;
}

/* 每帧弛豫：蒸发 + 低于环境势时的重新凝结；湿痕缓慢消退 */
function relaxFog(f, m) {
  var i, F, amb, sum = 0;
  for (i = 0; i < flen; i++) {
    F = fogF[i];
    F -= evpN[i] * m.ev * F * f;
    amb = ambF[i] * m.am;
    /* 缓慢重新凝结：笔迹可保持二三十秒，再被细珠一点点填满 */
    if (F < amb) F += accK[i] * m.ac * (0.40 + 0.70 * dotN[i]) * f * (amb - F);
    if (F < 0) F = 0; else if (F > 1) F = 1;
    fogF[i] = F; sum += F;
    wetF[i] -= 0.0006 * m.ev * wetF[i] * f;      /* 湿痕随档位一同消退 */
    bareF[i] -= 0.00018 * m.ev * bareF[i] * f;
  }
  return sum;
}

/* 弱扩散：雾气从边缘向擦拭区缓慢爬入，笔迹由外向内被覆盖 */
function diffuseFog(c, f) {
  var cc = c * f; if (cc > 0.9) cc = 0.9;
  var x, y, i, l, r, avg;
  for (y = 0; y < dh; y++) {
    var up = (y > 0 ? y - 1 : 0) * dw, dn = (y < dh - 1 ? y + 1 : dh - 1) * dw, row = y * dw;
    for (x = 0; x < dw; x++) {
      i = row + x;
      l = x > 0 ? i - 1 : i; r = x < dw - 1 ? i + 1 : i;
      avg = (fogF[l] + fogF[r] + fogF[up + x] + fogF[dn + x]) * 0.25;
      scratchF[i] = fogF[i] + (avg - fogF[i]) * cc;
    }
  }
  var tmp = fogF; fogF = scratchF; scratchF = tmp;
}

/* ------------------------------------------------------------------ 水珠 */
/* 终端速度：半径越大滑得越快（重力 vs 表面张力），并带个体差异 */
function dropTerminal(r) {
  var rc = r / Math.max(0.02, densityScale);   /* 换算成 css px 半径 */
  var v = 0.10 * rc * rc;
  v *= 0.65 + Math.random() * 0.7;             /* 同样大小也各不相同 */
  if (rc < 4) v = Math.min(v, 1.0 + Math.random() * 0.9); /* 微珠几乎不动 */
  return clamp(v, 0.3, 55);                     /* css px/s */
}

function spawnDrop(x, y, r, life) {
  if (drops.length >= 46) return;
  var cssV = dropTerminal(r);
  var maxV = cssV / Math.max(0.05, densityScale);   /* texels/s */
  drops.push({
    x: x, y: y, r: r, vx: 0,
    vy: maxV * (0.05 + Math.random() * 0.15),
    maxV: maxV, accel: 0.9 + Math.random() * 2.2,   /* 加速快慢因珠而异 */
    age: 0, life: life || (6 + Math.random() * 10), seed: Math.random(),
    state: Math.random() < 0.45 ? 1 : 0,            /* 初始有的在滑、有的附着 */
    stateT: 0.3 + Math.random() * 2.5, dead: false
  });
}

function dropTrail(x0, y0, x1, y1, R) {
  var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
  var steps = Math.max(1, Math.ceil(len / Math.max(0.6, R * 0.45)));
  if (steps > 24) steps = 24;
  var s, t, cx, cy, x0i, x1i, y0i, y1i, px, py, i2;
  for (s = 0; s <= steps; s++) {
    t = steps === 0 ? 0 : s / steps;
    cx = x0 + dx * t; cy = y0 + dy * t;
    x0i = Math.max(0, Math.floor(cx - R)); x1i = Math.min(dw - 1, Math.ceil(cx + R));
    y0i = Math.max(0, Math.floor(cy - R)); y1i = Math.min(dh - 1, Math.ceil(cy + R));
    for (py = y0i; py <= y1i; py++) for (px = x0i; px <= x1i; px++) {
      var ddx = px - cx, ddy = py - cy;
      var q = Math.sqrt(ddx * ddx + ddy * ddy) / R;
      if (q > 1.15) continue;
      i2 = py * dw + px;
      var e = 1 - sstep(0, 1, q);
      fogF[i2] *= (1 - 0.80 * e);
      var wv = (1 - sstep(0, 1.2, q)) * 0.85;
      if (wv > wetF[i2]) wetF[i2] = wv;
      var bv = 1 - sstep(0.2, 1.25, q);
      if (bv > bareF[i2]) bareF[i2] = bv;
    }
  }
}

function updateDrops(dt) {
  for (var i = drops.length - 1; i >= 0; i--) {
    var d = drops[i];
    d.age += dt;
    /* 粘附—滑动状态机：切换间隔与停留时长随机 → 真实的走走停停 */
    d.stateT -= dt;
    if (d.stateT <= 0) {
      if (d.state) { d.state = 0; d.stateT = 0.5 + Math.random() * 2.4; }
      else { d.state = 1; d.stateT = 0.6 + Math.random() * 2.2; }
    }
    var target = d.state ? d.maxV : d.maxV * 0.05;
    d.vy += (target - d.vy) * Math.min(1, dt * d.accel);
    /* 缓慢侧向游走，下落轨迹略带弧度 */
    d.vx = Math.sin(d.age * 0.9 + d.seed * 19.0) * Math.min(d.vy, d.maxV) * 0.10;
    var nx = d.x + d.vx * dt, ny = d.y + d.vy * dt;
    /* 快滑时轨迹细、慢爬时轨迹宽 */
    var sn = clamp(d.vy / Math.max(1, d.maxV), 0, 1);
    var tr = Math.max(1.2, d.r * (0.62 - 0.28 * sn));
    dropTrail(d.x, d.y, nx, ny, tr);
    d.x = nx; d.y = ny;
    d.r -= d.r * 0.03 * dt * (0.5 + sn);   /* 滑动时把水留在轨迹上 */
    if (ny > dh + d.r * 2 || d.age > d.life || d.r < 0.9) drops.splice(i, 1);
  }
}

/* 合并：滑动的大水珠吞并沿途小珠 → 变大、提速（现实中最典型的凝结现象） */
function mergeDrops() {
  var i, j;
  for (i = 0; i < drops.length; i++) {
    var a = drops[i];
    if (a.dead || !a.state) continue;         /* 只有正在滑动的会吞并 */
    for (j = 0; j < i; j++) {
      var b = drops[j];
      if (b.dead) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      var rr = (a.r + b.r) * 0.9;
      if (dx * dx + dy * dy >= rr * rr) continue;
      var big = a.r >= b.r ? a : b;
      var small = big === a ? b : a;
      big.r = Math.sqrt(big.r * big.r + small.r * small.r * 0.9);
      big.maxV = dropTerminal(big.r) / Math.max(0.05, densityScale);
      big.vy += small.vy * 0.25 + big.maxV * 0.06;   /* 动量叠加，立刻提速 */
      big.life = Math.max(big.life, big.age + 6);
      big.state = 1; big.stateT = 0.6 + Math.random() * 1.6;
      small.dead = true;
    }
  }
  var w = 0;
  for (i = 0; i < drops.length; i++) if (!drops[i].dead) drops[w++] = drops[i];
  drops.length = w;
}

function naturalSpawn(dt) {
  naturalAcc += dt;
  if (naturalAcc < 0.45) return;
  naturalAcc = 0;
  if (drops.length >= 24) return;
  var nx = Math.random() * dw, ny = Math.random() * dh * 0.7;
  var fi = (ny | 0) * dw + (nx | 0);
  /* 尺寸跨度大 → 有的几乎静止、有的缓缓滑落 */
  if (fogF[fi] > 0.68 && Math.random() < 0.6) spawnDrop(nx, ny, 1.4 + Math.random() * 4.6);
}

/* ================================================================ 外层降雨 */
function setupRain() {
  rainScale = Math.min(0.5, 720 / Math.max(1, S.cssW));
  rw = Math.max(96, Math.round(S.cssW * rainScale));
  rh = Math.max(96, Math.round(S.cssH * rainScale));
  rainScale = rw / Math.max(1, S.cssW);        /* 以实际整数尺寸为准 */
  rainTrailC = mkCanvas(rw, rh); rainTrailCtx = rainTrailC.getContext('2d');
  rainHeadC = mkCanvas(rw, rh);  rainHeadCtx = rainHeadC.getContext('2d');
  snowC = mkCanvas(rw, rh);      snowCtx = snowC.getContext('2d');
  rainCanvas = mkCanvas(rw, rh); rainCtx = rainCanvas.getContext('2d');
  rainDrops.length = 0; rainAcc = 0;
  snowFlakes.length = 0; snowAcc = 0;
  rainStreaks.length = 0;
  rainTexReady = false;
}

function drawRainTrail(x0, y0, x1, y1, r) {
  rainTrailCtx.globalCompositeOperation = 'lighter';
  var w = Math.max(0.9, r * 0.85);
  rainTrailCtx.lineCap = 'round';
  rainTrailCtx.beginPath(); rainTrailCtx.moveTo(x0, y0); rainTrailCtx.lineTo(x1, y1);
  rainTrailCtx.lineWidth = w;
  rainTrailCtx.strokeStyle = 'rgba(0,255,0,' + (0.09 + 0.15 * Math.min(1, r / 5)) + ')';
  rainTrailCtx.stroke();
  if (r > 3) {   /* 湿轨迹一侧的受光细边 */
    rainTrailCtx.save();
    rainTrailCtx.translate(1, 0);
    rainTrailCtx.lineWidth = Math.max(0.7, w * 0.30);
    rainTrailCtx.strokeStyle = 'rgba(0,255,0,0.10)';
    rainTrailCtx.stroke();
    rainTrailCtx.restore();
  }
}

// Weather occupies the visible opening, so switching never waits for particles
// to fall through the hidden cabin wall. Coordinates here are weather texels.
function weatherBounds() {
  var ap = MIST_WINDOWS.geometry(S.windowStyle, S.cssW, S.cssH);
  return { x: ap.x * rainScale, y: ap.y * rainScale, w: ap.w * rainScale, h: ap.h * rainScale };
}
function spawnSnow(b, spread) {
  var depth = Math.pow(Math.random(), 1.8);
  snowFlakes.push({
    x: b.x + Math.random() * b.w, y: b.y + (spread ? Math.random() * b.h : -5 * rainScale),
    r: (0.8 + depth * 3.1) * rainScale,
    vy: (14 + depth * 38) * rainScale,
    sway: (3 + depth * 12) * rainScale, swaySpeed: 0.6 + Math.random() * 1.4,
    phase: Math.random() * Math.PI * 2, soft: 0.20 + depth * 0.65,
    age: 0, life: 50, depth: depth
  });
}
function isRaining() { return S.weather === 'drizzle' || S.weather === 'rain'; }
var RAIN_PROFILES = {
  drizzle: { level: 0.28, count: 32, speed: 145, length: 8, alpha: 0.26, drops: 4, seedDrops: 9, radius: 2.5, cap: 30, wind: 0.25 },
  rain: { level: 0.88, count: 126, speed: 370, length: 24, alpha: 0.47, drops: 22, seedDrops: 24, radius: 5.4, cap: 72, wind: 0.80 }
};
function rainProfile() { return RAIN_PROFILES[S.weather] || RAIN_PROFILES.rain; }
function newRainStreak(b, spread) {
  var depth = Math.random(), p = rainProfile();
  return { x: b.x + Math.random() * b.w, y: b.y + (spread ? Math.random() * b.h : -p.length * 2 * rainScale),
    speed: p.speed * (0.55 + depth * 0.85) * rainScale,
    length: p.length * (0.5 + depth) * rainScale,
    width: (0.45 + depth * 0.65) * rainScale, alpha: p.alpha * (0.4 + depth * 0.6) };
}
function primeWeather(mode) {
  if (!rainCanvas) return;
  var b = weatherBounds(), n = clamp(b.w * b.h / (rainScale * rainScale * 150000), 0.65, 1.8) * (qualityTier === 0 ? 1 : 0.7);
  if (isRaining()) {
    var p = rainProfile(), count = Math.min(qualityTier === 0 ? 180 : 100, Math.ceil(p.count * n));
    while (rainStreaks.length < count) rainStreaks.push(newRainStreak(b, true));
    if (rainStreaks.length > count) rainStreaks.length = count;
    if (!rainDrops.length) rainAcc = p.seedDrops * n;
  }
  if (mode === 'snow' && !snowFlakes.length) for (var j = 0; j < 72 * n; j++) spawnSnow(b, true);
}
function updateWeatherButton() {
  var names = { clear: '晴', drizzle: '小雨', rain: '大雨', snow: '雪' };
  var paths = {
    clear: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4L19 5"></path>',
    drizzle: '<path d="M6 14a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9M8 18v1m7-1v1"></path>',
    rain: '<path d="M6 12a3.5 3.5 0 0 1 0-7 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 8M7 15l-2 4m8-4-2 4m8-4-2 4M8 21l-.5 1m6-1-.5 1"></path>',
    snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m10 14-1-4 4-1M4 14l4 1-1 4m10-14-1 4 4 1"></path>'
  };
  btnWeather.querySelector('svg').innerHTML = paths[S.weather];
  btnWeather.querySelector('span').textContent = names[S.weather];
  btnWeather.setAttribute('aria-label', '切换天气，当前：' + names[S.weather]);
  btnWeather.title = '当前：' + names[S.weather] + ' · 晴 / 小雨 / 大雨 / 雪';
}
function setWeather(mode, level, name) {
  S.weather = mode; S.weatherLevel = clamp(level, 0, 1);
  rainTarget = S.weatherLevel; rainIntensity = S.weatherLevel;
  if (isRaining()) {
    var b = weatherBounds();
    rainStreaks = rainStreaks.map(function (streak) { var fresh = newRainStreak(b, true); fresh.x = streak.x; fresh.y = streak.y; return fresh; });
  }
  primeWeather(mode); updateWeatherButton(); showLabel(name); hideHint();
}
function nextWeather() {
  var states = ['clear', 'drizzle', 'rain', 'snow'];
  var mode = states[(states.indexOf(S.weather) + 1) % states.length];
  setWeather(mode, mode === 'clear' ? 0 : mode === 'snow' ? 0.68 : RAIN_PROFILES[mode].level,
    mode === 'drizzle' ? '小雨' : mode === 'rain' ? '大雨' : mode === 'snow' ? '下雪了' : '放晴');
}

function updateRain(dt) {
  if (!rainCanvas) return;
  var i, d, f, profile = rainProfile(), cap = qualityTier === 0 ? profile.cap : Math.round(profile.cap * 0.7);
  var bounds = weatherBounds();
  primeWeather(S.weather);

  // Gentle variation stays within the selected intensity; drizzle never becomes a downpour.
  var baseLevel = isRaining() ? profile.level : S.weather === 'snow' ? 0.68 : 0;
  rainTarget = baseLevel * (0.94 + 0.06 * Math.sin(S.time * 0.36));
  rainIntensity += (rainTarget - rainIntensity) * Math.min(1, dt * 2.0);
  S.weatherLevel = rainIntensity;
  /* 风向缓慢摆动（雨丝与雪花都会被吹偏） */
  S.windT -= dt;
  if (S.windT <= 0) { S.windT = 4 + Math.random() * 8; S.windTarget = (Math.random() - 0.5) * 34; }
  S.wind += (S.windTarget - S.wind) * Math.min(1, dt * 0.4);
  /* 雨雪强度的视觉缓存（供着色器做空气透视） */
  S.rainAmt += ((isRaining() ? rainIntensity : 0) - S.rainAmt) * (1 - Math.exp(-dt * 10));
  S.snowAmt += ((S.weather === 'snow' ? rainIntensity : 0) - S.snowAmt) * (1 - Math.exp(-dt * 10));

  if (!isRaining() && S.rainAmt < 0.002) { rainStreaks.length = 0; rainDrops.length = 0; rainAcc = 0; rainTrailCtx.clearRect(0,0,rw,rh); }
  if (S.weather !== 'snow' && S.snowAmt < 0.002) { snowFlakes.length = 0; snowAcc = 0; }

  /* 生成：尺寸按幂律分布（小滴多、大滴少），雨越大平均雨滴越大 */
  var areaN = clamp(bounds.w * bounds.h / (rainScale * rainScale * 200000), 0.6, 1.8);
  rainAcc += dt * (isRaining() ? profile.drops : 0) * areaN * (qualityTier === 0 ? 1 : 0.7);
  while (rainAcc >= 1) {
    rainAcc -= 1;
    if (rainDrops.length >= cap) break;
    var sz = (0.85 + Math.pow(Math.random(), 2.3) * profile.radius) * rainScale;
    var rc = sz / rainScale;                       /* css px 半径 */
    var vf = 0.6 + Math.random() * 0.8;            /* 个体速度系数 */
    var cssV = 0.25 * rc * rc * vf;
    if (rc < 3) cssV = Math.min(cssV, 1.5 + Math.random() * 2.0);  /* 小滴几乎不动 */
    cssV = clamp(cssV, 0.4, 95);
    rainDrops.push({
      x: bounds.x + Math.random() * bounds.w,
      y: bounds.y + Math.random() * bounds.h,
      r: sz, vy: cssV * 0.1 * rainScale,
      maxV: cssV * rainScale, accel: 0.8 + Math.random() * 2.0, vf: vf,
      age: 0.25, life: 5 + Math.random() * 7, seed: Math.random(),
      state: Math.random() < 0.5 ? 1 : 0, stateT: 0.2 + Math.random() * 1.8
    });
  }

  /* Far flakes drift slowly; a few near flakes are larger and out of focus. */
  snowAcc += dt * (S.weather === 'snow' ? (5 + 10 * rainIntensity) : 0) * areaN;
  while (snowAcc >= 1) {
    snowAcc -= 1;
    if (snowFlakes.length >= (qualityTier === 0 ? 145 : 85)) break;
    spawnSnow(bounds, false);
  }
  for (i = 0; i < rainStreaks.length; i++) {
    var streak = rainStreaks[i];
    streak.y += streak.speed * dt;
    streak.x += (S.wind * profile.wind * rainScale - streak.speed * 0.035) * dt;
    if (streak.y > bounds.y + bounds.h + streak.length || streak.x < bounds.x - 10 || streak.x > bounds.x + bounds.w + 10) rainStreaks[i] = newRainStreak(bounds, false);
  }

  /* 雨滴断续下滑：附着时吸水变大，滑动时把水留在轨迹上变小；
     体积决定速度 → 蓄到一定程度会突然加速冲下（真实雨珠的典型行为） */
  for (i = rainDrops.length - 1; i >= 0; i--) {
    d = rainDrops[i];
    d.age += dt;
    d.stateT -= dt;
    if (d.stateT <= 0) {
      if (d.state) { d.state = 0; d.stateT = 0.5 + Math.random() * 2.6; }  /* 停下蓄水 */
      else { d.state = 1; d.stateT = 0.5 + Math.random() * 1.8; }
    }
    if (d.state) d.r += d.r * 0.080 * dt;
    else d.r -= d.r * 0.060 * dt;
    var rcN = clamp(d.r / rainScale, 0.5, 40);
    d.maxV = clamp(0.25 * rcN * rcN * d.vf, 0.4, 95) * rainScale;
    var tgt = d.state ? d.maxV : d.maxV * 0.06;
    d.vy += (tgt - d.vy) * Math.min(1, dt * d.accel);
    var ox = d.x, oy = d.y;
    d.y += d.vy * dt;
    /* 风把雨丝吹斜 */
    d.x += (Math.sin(d.age * 1.4 + d.seed * 13.0) * d.vy * 0.06 + S.wind * 0.20) * dt;
    if (d.y - oy > 0.5 || Math.abs(d.x - ox) > 0.5) drawRainTrail(ox, oy, d.x, d.y, d.r);
    if (d.y > rh + d.r * 2 || d.age > d.life || d.r < 0.35 * rainScale || d.r > 14 * rainScale) rainDrops.splice(i, 1);
  }

  /* 雪花飘落：摇曳 + 风偏 + 忽快忽慢 */
  for (i = snowFlakes.length - 1; i >= 0; i--) {
    f = snowFlakes[i];
    f.age += dt;
    var flutter = 0.82 + 0.30 * (Math.sin(f.age * 2.2 + f.phase) * 0.5 + 0.5);
    f.y += f.vy * flutter * dt;
    f.x += (S.wind * rainScale + Math.sin(f.age * f.swaySpeed + f.phase) * f.sway) * dt;
    if (f.y > bounds.y + bounds.h + f.r * 2 || f.age > f.life || f.x < bounds.x - f.r * 3 || f.x > bounds.x + bounds.w + f.r * 3) snowFlakes.splice(i, 1);
  }

  /* 湿轨迹缓慢淡去（约 1.6 秒时间常数） */
  rainTrailCtx.globalCompositeOperation = 'destination-out';
  rainTrailCtx.fillStyle = 'rgba(0,0,0,' + (1 - Math.exp(-dt / 1.6)).toFixed(4) + ')';
  rainTrailCtx.fillRect(0, 0, rw, rh);

  /* 水珠穹顶：遮罩本身是圆顶形，着色器据此算出弯折与高光 */
  rainHeadCtx.clearRect(0, 0, rw, rh);
  rainHeadCtx.globalCompositeOperation = 'lighter';
  rainHeadCtx.globalAlpha = Math.min(1, S.rainAmt / 0.68);
  for (i = 0; i < rainDrops.length; i++) {
    d = rainDrops[i];
    var a = (0.48 + 0.36 * Math.min(1, d.r / (4 * rainScale))) * Math.min(1, d.age * 4);
    var rr = d.r * 1.08;
    var g = rainHeadCtx.createRadialGradient(d.x, d.y, 0, d.x, d.y, rr);
    g.addColorStop(0, 'rgba(255,0,0,' + a + ')');
    g.addColorStop(0.55, 'rgba(255,0,0,' + (a * 0.88) + ')');
    g.addColorStop(1, 'rgba(255,0,0,0)');
    rainHeadCtx.fillStyle = g;
    rainHeadCtx.beginPath(); rainHeadCtx.arc(d.x, d.y, rr, 0, Math.PI * 2); rainHeadCtx.fill();
  }

  /* 雪花：柔软失焦的亮点，失焦程度随大小变化（近大远小） */
  snowCtx.clearRect(0, 0, rw, rh);
  snowCtx.globalCompositeOperation = 'lighter';
  snowCtx.globalAlpha = Math.min(1, S.snowAmt / 0.68);
  for (i = 0; i < snowFlakes.length; i++) {
    f = snowFlakes[i];
    var sa = 0.30 + 0.30 * f.soft + 0.18 * Math.min(1, f.r / 4);
    var srad = f.r * 1.25;
    snowCtx.save();
    snowCtx.translate(f.x, f.y);
    snowCtx.rotate(f.phase + f.age * 0.6);        /* 缓慢翻转，轮廓不那么圆 */
    var sg = snowCtx.createRadialGradient(0, 0, 0, 0, 0, srad);
    sg.addColorStop(0, 'rgba(0,0,255,' + sa + ')');
    sg.addColorStop(Math.max(0.15, 0.62 - f.soft * 0.4), 'rgba(0,0,255,' + (sa * 0.45) + ')');
    sg.addColorStop(1, 'rgba(0,0,255,0)');
    snowCtx.fillStyle = sg;
    snowCtx.beginPath();
    snowCtx.ellipse(0, 0, srad * (0.84 + 0.26 * Math.abs(Math.sin(f.phase))), srad * 0.94, 0, 0, Math.PI * 2);
    snowCtx.fill();
    snowCtx.restore();
  }

  // Falling rain shares the blue depth channel with snow. No extra GL sampler.
  snowCtx.globalAlpha = Math.min(1, S.rainAmt / 0.68);
  snowCtx.lineCap = 'round';
  for (i = 0; i < rainStreaks.length; i++) {
    var sr = rainStreaks[i];
    snowCtx.strokeStyle = 'rgba(0,0,255,' + sr.alpha + ')';
    snowCtx.lineWidth = sr.width;
    snowCtx.beginPath(); snowCtx.moveTo(sr.x, sr.y);
    var slant = 0.035 - S.wind * profile.wind * rainScale / Math.max(1, sr.speed);
    snowCtx.lineTo(sr.x + sr.length * slant, sr.y - sr.length); snowCtx.stroke();
  }
  snowCtx.globalAlpha = 1;
  /* R=attached rain, G=wet trails, B=falling precipitation, A=255. */
  rainCtx.globalCompositeOperation = 'source-over'; rainCtx.globalAlpha = 1;
  rainCtx.fillStyle = '#000'; rainCtx.fillRect(0, 0, rw, rh);
  rainCtx.globalCompositeOperation = 'lighter';
  rainCtx.globalAlpha = Math.min(1, S.rainAmt / 0.68);
  rainCtx.drawImage(rainTrailC, 0, 0);
  rainCtx.globalAlpha = 1;
  rainCtx.drawImage(rainHeadC, 0, 0);
  rainCtx.drawImage(snowC, 0, 0);
}

function uploadRainTexture() {
  if (!useGL || !gl || !rainTex || !rainCanvas) return;
  gl.activeTexture(gl.TEXTURE6);
  gl.bindTexture(gl.TEXTURE_2D, rainTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  if (!rainTexReady) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rainCanvas);
    setTexParams(rainTex, false);
    rainTexReady = true;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, rainCanvas);
  }
  gl.activeTexture(gl.TEXTURE0);
}

/* 把密度场写入画布；WebGL 模式下 A=255，2D 模式下 A=密度（合成蒙版） */
function writeFogCanvas() {
  var b = fogBuf, f = fogF, w = wetF, ba = bareF, i, o;
  for (i = 0; i < flen; i++) {
    o = i << 2;
    b[o] = f[i] * 255;
    b[o + 1] = w[i] * 255;
    b[o + 2] = ba[i] * 255;
    b[o + 3] = useGL ? 255 : f[i] * 255;
  }
  fogCtx.putImageData(fogImg, 0, 0);
}

/* 水珠头部遮罩 + 解析梯度（用作透镜法线）；G/B=128 表示零梯度 */
function writeDropCanvas() {
  var b = dropBuf, i, o;
  for (i = 0; i < flen; i++) { o = i << 2; b[o] = 0; b[o + 1] = 128; b[o + 2] = 128; b[o + 3] = 255; }
  for (i = 0; i < drops.length; i++) {
    var d = drops[i], R = d.r;
    if (R < 0.8) continue;
    var x0 = Math.max(0, Math.floor(d.x - R * 1.15)), x1 = Math.min(dw - 1, Math.ceil(d.x + R * 1.15));
    var y0 = Math.max(0, Math.floor(d.y - R * 1.15)), y1 = Math.min(dh - 1, Math.ceil(d.y + R * 1.15));
    for (var py = y0; py <= y1; py++) for (var px = x0; px <= x1; px++) {
      var ddx = px - d.x, ddy = py - d.y;
      var dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > R * 1.10) continue;
      var t = clamp((R * 1.10 - dist) / (R * 0.5), 0, 1);
      var v = t * t * (3 - 2 * t);
      var dvdd = -6 * t * (1 - t) / (R * 0.5);
      var gx = 0, gy = 0;
      if (dist > 0.35) {
        gx = dvdd * dw * ddx / (dist * R);
        gy = dvdd * dh * ddy / (dist * R);
      }
      var ex = clamp(gx * 0.0015, -1, 1), ey = clamp(gy * 0.0015, -1, 1);
      var oo = (py * dw + px) << 2;
      b[oo] = v * 255;
      b[oo + 1] = (0.5 + ex * 0.5) * 255;
      b[oo + 2] = (0.5 + ey * 0.5) * 255;
      b[oo + 3] = 255;
    }
  }
  dropCtx.putImageData(dropImg, 0, 0);
}

/* ================================================================ WebGL */
var VS_SRC = [
'attribute vec2 aPos;',
'varying vec2 vUv;',
'void main() {',
'  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);',
'  gl_Position = vec4(aPos, 0.0, 1.0);',
'}'
].join('\n');

var FS_SRC = [
'#ifdef GL_FRAGMENT_PRECISION_HIGH',
'precision highp float;',
'#else',
'precision mediump float;',
'#endif',
'varying vec2 vUv;',
'uniform sampler2D uFog;',
'uniform sampler2D uDrop;',
'uniform sampler2D uBg0;',
'uniform sampler2D uBg1;',
'uniform sampler2D uBg2;',
'uniform sampler2D uGrain;',
'uniform sampler2D uRain;',
'uniform vec2 uRainTexel;',
'uniform vec2 uTexel;',
'uniform vec2 uBuf;',
'uniform float uTime;',
'uniform float uPolish;',
'uniform float uMist;',
'uniform float uFlight;',
'uniform float uCloudTime;',
'uniform vec4 uAperture;',
'uniform vec3 uFogTint;',
'uniform float uRainAmt;',
'uniform float uSnowAmt;',
'const float GE = 0.004;',
'const float DE = 0.0015;',
'',
'float hash21(vec2 p) {',
'  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
'  p3 += dot(p3, p3.yzx + 33.33);',
'  return fract((p3.x + p3.y) * p3.z);',
'}',
'',
'vec4 grainSample(vec2 p) {',
'  vec2 q = clamp(fract(p), vec2(0.00097656), vec2(0.99902344));',
'  return texture2D(uGrain, vec2(q.x * 0.5, q.y));',
'}',
 'float cloudNoise(vec2 p) {',
'  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
'  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x),f.y);',
'}',
'float cloudField(vec2 p) {',
'  return cloudNoise(p)*.57 + cloudNoise(p*2.03+4.1)*.28 + cloudNoise(p*4.11+13.7)*.15;',
'}',
'void main() {',
'  vec2 uv = vUv;',
'  vec2 local = (uv-uAperture.xy)/max(uAperture.zw,vec2(.001));',

'',
'  vec4 f = texture2D(uFog, uv);',
'  float fog = f.r;',
'  float wet = f.g;',
'  float bare = f.b;',
'',
'  float fl = texture2D(uFog, uv - vec2(uTexel.x, 0.0)).r;',
'  float fr = texture2D(uFog, uv + vec2(uTexel.x, 0.0)).r;',
'  float fu = texture2D(uFog, uv - vec2(0.0, uTexel.y)).r;',
'  float fd = texture2D(uFog, uv + vec2(0.0, uTexel.y)).r;',
'  vec2 fg = vec2(fr - fl, fd - fu) / (2.0 * uTexel);',
'',
'  vec4 d4 = texture2D(uDrop, uv);',
'  float dv = d4.r;',
'  vec2 dg = (d4.gb - 0.5) * (2.0 / DE);',
'',
'  /* 外层降雨：水珠圆顶遮罩 + 湿轨迹（位于雾气之后） */',
'  vec4 rn = texture2D(uRain, uv);',
'  float rHead = rn.r;',
'  float rTrail = rn.g;',
'  float rSnow = rn.b;',
'  float rrl = texture2D(uRain, uv - vec2(uRainTexel.x, 0.0)).r;',
'  float rrr = texture2D(uRain, uv + vec2(uRainTexel.x, 0.0)).r;',
'  float rru = texture2D(uRain, uv - vec2(0.0, uRainTexel.y)).r;',
'  float rrd = texture2D(uRain, uv + vec2(0.0, uRainTexel.y)).r;',
'  vec2 rgrad = vec2(rrr - rrl, rrd - rru) / (2.0 * uRainTexel);',
'',
'  vec2 gq = uv * uBuf / 512.0;',
'  vec4 gi = grainSample(gq);',
'  float hgt = gi.r;',
'  vec2 gn = (gi.gb - 0.5) * 2.0;',
'',
'  /* 第二尺度：宏观凝结差异 —— 细密雾区 vs 粗大水珠区 */',
'  vec4 gi2 = grainSample(gq * 0.21 + vec2(0.31, 0.57));',
'  float macro = gi2.r;',
'  vec2 gn2 = (gi2.gb - 0.5) * 2.0;',
'',
'  /* 玻璃外表面独立一层：不随雾气增减 */',
'  vec4 gsv = texture2D(uGrain, vec2(0.50048828 + uv.x * 0.49902344, 0.00097656 + uv.y * 0.99804688));',
'',
'  /* 颗粒只做微扰：雾层整体均匀，细节靠细珠体现 */',
'  float d = clamp(fog * (0.98 + 0.06 * hgt) + (hgt - 0.5) * 0.07 * smoothstep(0.05, 0.4, fog), 0.0, 1.0);',
'',
'  /* 折射：雾层梯度 + 细珠微法线 + 粗珠弯折 + 水珠透镜 */',
'  vec2 refr = clamp(fg * 0.00025, -0.010, 0.010);',
'  refr += gn * 0.0026 * d;',
'  refr += gn2 * 0.0025 * macro * d;',
'  refr += clamp(dg * 0.000025, -0.02, 0.02) * dv;',
'  /* 雨滴掰弯背景光线；雾一厚，高频弯折即被散射掉 */',
'  refr += clamp(rgrad * 0.00007, -0.012, 0.012) * (1.0 - 0.70 * fog);',
'',
 '  vec2 buv = uv + refr;',
'  if (uFlight > .5) {',
'    float depth=smoothstep(.30,1.0,local.y);',
'    buv.x += sin(uCloudTime*.028)*(0.015+depth*.055)*uAperture.z;',
'    buv.y += sin(uCloudTime*.017+local.x)*.012*depth*uAperture.w;',
'  }',
'  vec3 s0 = texture2D(uBg0, buv).rgb;',
'  vec3 s1 = texture2D(uBg1, buv).rgb;',
'  vec3 s2 = texture2D(uBg2, buv).rgb;',
'',
'  float ca = 0.0022 * dot(uv - 0.5, uv - 0.5) * (1.0 - d);',
'  vec2 cdx = (uv - 0.5) * ca;',
'  s0.r = texture2D(uBg0, buv + cdx).r;',
'  s0.b = texture2D(uBg0, buv - cdx).b;',
'',
'  /* 局部模糊：雾层虚化基本一致，粗珠区只略微透亮 */',
'  float clarity = 1.0 - 0.22 * macro;',
'  float b1 = smoothstep(0.04, 0.5, d * clarity);',
'  float b2 = smoothstep(0.30, 0.95, d * clarity);',
'  // Dense condensation scatters detail earlier; the simulation density is unchanged.',
'  b1 = mix(b1, smoothstep(0.025, 0.32, d), uMist);',
'  b2 = mix(b2, smoothstep(0.10, 0.68, d), uMist);',
'  float corner = smoothstep(0.28, 0.85, length(uv - 0.5));',
'  b2 = clamp(b2 + corner * 0.20, 0.0, 1.0);',
'',
'  vec3 bg = mix(s0, s1, b1);',
'  bg = mix(bg, s2, b2);',
'',
 '  if (uFlight > .5) {',
'    vec2 cp=vec2(local.x*3.4+uCloudTime*.020,local.y*5.0);',
'    float cloud=cloudField(cp);',
'    float above=cloudField(cp+vec2(-.1,-.14));',
'    float veil=smoothstep(.44,.73,cloud)*smoothstep(.52,.96,local.y)*.22;',
'    vec3 cloudColor=vec3(.83,.88,.91)+(above-cloud)*.40;',
'    bg=mix(bg,cloudColor,veil*(1.0-.55*d));',
'  }',
'  /* 外层雨：湿轨迹泛光 + 雨珠高光/暗缘（随后被内层雾一并散射） */',
'  vec2 rld = normalize(vec2(-0.5, -0.86));',
'  float rsp = pow(max(0.0, dot(normalize(rgrad + vec2(0.0001)), rld)), 6.0);',
'  bg += vec3(0.50, 0.64, 0.82) * rTrail * 0.10 * (0.55 + 0.45 * fog);',
'  bg += vec3(0.90, 0.94, 1.00) * rHead * (0.05 + 0.50 * rsp) * (1.0 - 0.50 * fog);',
'  bg -= vec3(0.05, 0.06, 0.07) * rHead * (1.0 - rsp) * 0.30;',
'  /* 雪花：柔和亮点，雾厚时被散射得更虚 */',
'  float snowMix = uSnowAmt / max(0.001, uSnowAmt + uRainAmt);',
'  float rainLight = 1.0 - smoothstep(.25,.70,dot(bg,vec3(.2126,.7152,.0722)));',
'  vec3 rainColor = mix(vec3(.22,.30,.34),vec3(.86,.91,.94),rainLight);',
'  bg = mix(bg, mix(rainColor,vec3(.96,.98,1.0),snowMix), rSnow * mix(.82,.90,snowMix) * (1.0-.45*fog));',
'',
'  /* 雨雪带来的空气透视：雨中更沉更暗，雪中更亮更平 */',
'  bg = mix(bg, bg * vec3(0.84, 0.88, 0.97) + vec3(0.015, 0.025, 0.045), uRainAmt * 0.55);',
'  bg = mix(bg, bg * vec3(0.96, 0.99, 1.06) + vec3(0.03, 0.04, 0.055), uSnowAmt * 0.45);',
'',
'  /* 凝结散射：整面均匀乳白，仅随颗粒细微起伏 */',
'  float op = 1.0 - exp(-3.2 * d * (1.06 - 0.22 * macro));',
'  vec3 fogc = vec3(0.30, 0.33, 0.39) * (0.92 + 0.16 * hgt) + bg * (0.26 + 0.08 * macro);',
'  fogc += vec3(0.030, 0.018, 0.006) * (1.0 - d * 0.5);',
'  fogc += vec3(0.030, 0.035, 0.045) * bare * (1.0 - d);',
'  float sceneLight = dot(s2, vec3(0.2126, 0.7152, 0.0722));',
'  vec3 photoFog = bg * 0.46 + uFogTint * (0.16 + 0.16 * sceneLight);',
'  fogc = mix(fogc, photoFog, uPolish * 0.55);',
'  // Soft room light and a broad scene glow, inspired by the earlier renderer.',
'  // Scattering follows local density; it disappears completely in a wiped stroke.',
'  vec3 scatterTint = mix(uFogTint, vec3(0.94), 0.60);',
'  vec3 scatter = scatterTint * (0.39 + 0.46 * sceneLight);',
'  vec3 bloom = max(s2 - 0.58, vec3(0.0));',
'  scatter += mix(bloom, vec3(dot(bloom, vec3(0.2126, 0.7152, 0.0722))), 0.65) * 0.20;',
'  vec3 mistColor = mix(s2, scatter, 0.80);',
'  mistColor *= (0.995 + 0.010 * hgt) * (1.0 - .075*uRainAmt);',
'  mistColor += vec3(.020,.025,.030) * uSnowAmt;',
'  fogc = mix(fogc, mistColor, uMist);',
'  vec3 col = mix(bg, fogc, op * 0.96);',
'',
'  /* 水膜：密度极高处微珠并成连续水膜，更透更亮泽 */',
'  float film = smoothstep(0.80, 1.0, d) * (1.0 - macro);',
'  col = mix(col, col * vec3(0.90, 0.94, 1.02) + vec3(0.04, 0.05, 0.06), film * 0.45);',
'',
'  /* 湿玻璃更暗、更亮泽 */',
'  float wl = wet * (1.0 - d * 0.75);',
'  col *= 1.0 - 0.14 * wl;',
'',
'  /* 潮湿边缘：密度突变处一线受光的水痕 */',
'  float edge = smoothstep(4.0, 55.0, length(fg));',
'  col += mix(vec3(0.62, 0.72, 0.88), uFogTint, uPolish * 0.55) * edge * (0.04 + 0.16 * wet);',
'',
'  /* 细密凝结颗粒：均匀细珠上的微弱高光 */',
'  vec2 ldir = normalize(vec2(-0.5, -0.86));',
'  float sp = pow(max(0.0, dot(normalize(gn + vec2(0.0001)), ldir)), 7.0);',
'  float beads = smoothstep(0.68, 0.98, hgt) * d;',
'  col += vec3(0.85, 0.90, 1.00) * beads * (0.02 + 0.30 * sp) * (0.70 + 0.30 * macro) * mix(1.0, 0.35, uMist);',
'  col -= vec3(0.05, 0.06, 0.075) * (1.0 - smoothstep(0.08, 0.45, hgt)) * d * 0.32 * mix(1.0, 0.20, uMist);',
'',
'  /* 局部略粗的水珠：很轻的亮心与暗缘 */',
'  float bigBead = smoothstep(0.68, 0.95, macro) * d;',
'  float sp2 = pow(max(0.0, dot(normalize(gn2 + vec2(0.0001)), ldir)), 6.0);',
'  col += vec3(0.80, 0.86, 0.97) * bigBead * (0.03 + 0.16 * sp2) * mix(1.0, 0.30, uMist);',
'  col -= vec3(0.04, 0.05, 0.065) * smoothstep(0.30, 0.72, hgt) * bigBead * 0.28 * mix(1.0, 0.18, uMist);',
'',
'  // Subpixel condensation beads exist only where there is mist, never as permanent dirt.',
'  vec2 microP = uv * uBuf / 3.2;',
'  vec2 microCell = floor(microP);',
'  vec2 microOffset = vec2(hash21(microCell), hash21(microCell + 37.1));',
'  vec2 microLocal = fract(microP) - (0.35 + microOffset * 0.30);',
'  float microR = 0.10 + 0.16 * clamp(d, 0.0, 1.0);',
'  float microLens = 1.0 - smoothstep(microR * 0.45, microR, length(microLocal));',
'  float microShine = 1.0 - smoothstep(0.0, microR * 0.65, length(microLocal + vec2(microR * 0.24)));',
'  col += (microShine * 0.036 - microLens * 0.006) * smoothstep(0.04, 0.55, d) * uMist;',
'',
'  /* 水珠：透镜内折射 + 球面高光 */',
'  float dsp = pow(max(0.0, dot(normalize(dg + vec2(0.0001)), ldir)), 5.0);',
'  col += vec3(0.72, 0.80, 0.95) * dv * 0.10;',
'  col += vec3(0.95, 0.97, 1.00) * dv * dsp * 0.50;',
'',
'  /* --- 玻璃窗户质感 --- */',
'  /* 1) 宽窄两道斜向环境反光：光滑表面映出的天空与室内光 */',
'  float rA = 1.0 - smoothstep(0.0, 0.11, abs((uv.x * 0.72 + uv.y * 0.70) - 0.80));',
'  float rB = 1.0 - smoothstep(0.0, 0.045, abs((uv.x * 0.50 - uv.y * 0.88) + 0.12));',
'  col += vec3(0.50, 0.60, 0.76) * rA * rA * 0.050 * (0.45 + 0.55 * wet);',
'  col += vec3(0.40, 0.50, 0.68) * rB * rB * 0.030;',
'',
'  /* 2) 中空双层玻璃：亮部带一道轻微错位的重影 */',
'  vec3 ghost = texture2D(uBg0, buv + vec2(0.007, -0.005)).rgb;',
'  col += ghost * smoothstep(0.22, 0.85, dot(ghost, vec3(0.33))) * 0.050 * mix(1.0, 1.0 - smoothstep(0.03, 0.35, d), uMist);',
'',
'  /* 3) 表面灰迹 / 擦拭弧痕 / 灰尘：擦开雾气后依然存在的那层脏 */',
'  float smudge = gsv.r;',
'  col = mix(col, col * vec3(0.93, 0.95, 1.00) + vec3(0.020, 0.024, 0.030), smudge * mix(0.60, 0.30, uPolish) * (1.0 - uMist));',
'  col += vec3(0.62, 0.74, 0.90) * gsv.g * 0.055 * (1.0 - uMist);',
'  col += vec3(0.75, 0.82, 0.95) * gsv.b * 0.12 * (1.0 - uMist);',
'',
'  /* 4) 窗框内侧：边缘压暗 + 一道接光内倒角，读作真实窗格 */',
'  vec2 qq = abs(uv - 0.5) * 2.0;',
'  float outer = max(qq.x, qq.y);',
'  col *= 1.0 - 0.35 * smoothstep(0.90, 1.0, outer);',
'  float bevel = smoothstep(0.87, 0.90, outer) * (1.0 - smoothstep(0.90, 0.95, outer));',
'  col += vec3(0.45, 0.55, 0.70) * bevel * 0.050;',
'',
'  /* 5) 冷边凝结：靠窗框处水汽更厚、微珠更亮 */',
'  float nearFrame = smoothstep(0.60, 0.95, outer);',
'  col += vec3(0.80, 0.87, 1.00) * beads * nearFrame * 0.060 * mix(1.0, 0.35, uMist);',
'',
'  /* 胶片颗粒 + 暗角 + 轻微反差 */',
'  float fn = hash21(uv * uBuf + vec2(fract(uTime * 17.0), fract(uTime * 9.0)) * 97.0) - 0.5;',
'  col += fn * mix(0.020, 0.012, uPolish) * mix(1.0, 0.25, uMist);',
'',
'  float vig = 1.0 - smoothstep(0.42, 1.30, length((uv - vec2(0.5, 0.47)) * vec2(1.02, 1.0) * 1.6));',
'  col *= mix(mix(0.52, 0.65, uPolish), 1.0, vig);',
'',
'  col = clamp((col - 0.5) * mix(1.05, 1.025, uPolish) + 0.5, 0.0, 1.0);',
'  gl_FragColor = vec4(col, 1.0);',
'}'
].join('\n');

function compileShader(type, src) {
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    if (window.console && console.error) console.error('shader error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function makeGrainCanvas() {
  var N = 512, cv = mkCanvas(N, N), c2 = cv.getContext('2d');
  var id = c2.createImageData(N, N), d = id.data;
  var n1 = tileNoise(101, 12), n2 = tileNoise(202, 24), n3 = tileNoise(303, 48);
  var hg = new Float32Array(N * N), x, y, i;
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    var u = x / N, v = y / N;
    hg[y * N + x] = n1(u * 12, v * 12) * 0.45 + n2(u * 24, v * 24) * 0.35 + n3(u * 48, v * 48) * 0.20;
  }
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    i = y * N + x;
    var xm = x > 0 ? x - 1 : N - 1, xp = x < N - 1 ? x + 1 : 0;
    var ym = y > 0 ? y - 1 : N - 1, yp = y < N - 1 ? y + 1 : 0;
    var nx = (hg[y * N + xp] - hg[y * N + xm]) * 0.5;
    var ny = (hg[yp * N + x] - hg[ym * N + x]) * 0.5;
    var ex = clamp(nx * 12, -1, 1), ey = clamp(ny * 12, -1, 1);
    var o = i * 4;
    d[o] = (hg[i] * 255) | 0;
    d[o + 1] = ((0.5 + ex * 0.5) * 255) | 0;
    d[o + 2] = ((0.5 + ey * 0.5) * 255) | 0;
    d[o + 3] = 255;
  }
  c2.putImageData(id, 0, 0);
  return cv;
}

var grainBase = null;
function makeGrainAtlas() {
  if (!grainBase) grainBase = makeGrainCanvas();
  var atlas = mkCanvas(1024, 512), c2 = atlas.getContext('2d');
  c2.drawImage(grainBase, 0, 0);
  c2.fillStyle = '#000'; c2.fillRect(512, 0, 512, 512);
  if (BG.glass) c2.drawImage(BG.glass, 512, 0, 512, 512);
  return atlas;
}

function setTexParams(tex, repeat) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
}

function texFromCanvas(tex, canvas, repeat) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  setTexParams(tex, repeat);
}

function initGL() {
  var opt = {
    alpha: false, depth: false, stencil: false, antialias: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false
  };
  if (/(?:[?&])gl=0(?:&|$)/.test(location.search)) return false;
  gl = glass.getContext('webgl', opt) || glass.getContext('experimental-webgl', opt);
  if (!gl) return false;

  var vs = compileShader(gl.VERTEX_SHADER, VS_SRC);
  var fs = compileShader(gl.FRAGMENT_SHADER, FS_SRC);
  if (!vs || !fs) return false;

  prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (window.console && console.error) console.error('link error:', gl.getProgramInfoLog(prog));
    return false;
  }
  gl.useProgram(prog);

  var quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  var vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  U = {
    fog: gl.getUniformLocation(prog, 'uFog'),
    drop: gl.getUniformLocation(prog, 'uDrop'),
    bg0: gl.getUniformLocation(prog, 'uBg0'),
    bg1: gl.getUniformLocation(prog, 'uBg1'),
    bg2: gl.getUniformLocation(prog, 'uBg2'),
    grain: gl.getUniformLocation(prog, 'uGrain'),
    rain: gl.getUniformLocation(prog, 'uRain'),
    rainTexel: gl.getUniformLocation(prog, 'uRainTexel'),
    rainAmt: gl.getUniformLocation(prog, 'uRainAmt'),
    snowAmt: gl.getUniformLocation(prog, 'uSnowAmt'),
    texel: gl.getUniformLocation(prog, 'uTexel'),
    buf: gl.getUniformLocation(prog, 'uBuf'),
    time: gl.getUniformLocation(prog, 'uTime'),
    polish: gl.getUniformLocation(prog, 'uPolish'),
    mist: gl.getUniformLocation(prog, 'uMist'),
    flight: gl.getUniformLocation(prog, 'uFlight'),
    cloudTime: gl.getUniformLocation(prog, 'uCloudTime'),
    aperture: gl.getUniformLocation(prog, 'uAperture'),
    fogTint: gl.getUniformLocation(prog, 'uFogTint')
  };
  gl.uniform1i(U.fog, 0);
  gl.uniform1i(U.drop, 1);
  gl.uniform1i(U.bg0, 2);
  gl.uniform1i(U.bg1, 3);
  gl.uniform1i(U.bg2, 4);
  gl.uniform1i(U.grain, 5);
  gl.uniform1i(U.rain, 6);

  fogTex = gl.createTexture();
  dropTex = gl.createTexture();
  grainTex = gl.createTexture();
  rainTex = gl.createTexture();
  /* 每个纹理必须绑定到着色器声明的纹理单元，否则采样为空 */
  gl.activeTexture(gl.TEXTURE5);
  texFromCanvas(grainTex, makeGrainAtlas(), false);
  gl.activeTexture(gl.TEXTURE0);

  glass.addEventListener('webglcontextlost', onContextLost, false);
  return true;
}

function onContextLost(e) {
  if (e.preventDefault) e.preventDefault();
  switchToFlat('渲染上下文丢失，已切换到简化模式');
}

function switchToFlat(msg) {
  useGL = false;
  gl = null; prog = null; U = null;
  glass.hidden = true;
  flat.hidden = false;
  flatCtx = flat.getContext('2d');
  BG.t0 = BG.t1 = BG.t2 = null;
  if (msg) showToast(msg, 2800);
}

/* 背景纹理：清晰 / 软焦 / 重焦三层，着色器按雾密度混合 */
function drawCover(c2, img, w, h, focus) {
  var iw = img.naturalWidth || img.width || 0, ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return;
  var ap0 = MIST_WINDOWS.geometry(S.windowStyle, S.cssW, S.cssH), scale = w / S.cssW;
  var ap = { x: ap0.x*scale, y: ap0.y*scale, w: ap0.w*scale, h: ap0.h*scale };
  // Overscan allows cloud parallax without revealing the texture boundary.
  if (S.windowStyle === 4 && !S.customImg && SCENES[S.sceneIndex].flight) {
    ap.x -= ap.w*.12; ap.y -= ap.h*.12; ap.w *= 1.24; ap.h *= 1.24;
  }
  var s = Math.max(ap.w / iw, ap.h / ih);
  var dww = iw * s, dhh = ih * s;
  var fx = focus ? focus[0] : 0.5, fy = focus ? focus[1] : 0.5;
  var dx = clamp(ap.x + ap.w * 0.5 - dww * fx, ap.x + ap.w - dww, ap.x);
  var dy = clamp(ap.y + ap.h * 0.5 - dhh * fy, ap.y + ap.h - dhh, ap.y);
  c2.drawImage(img, dx, dy, dww, dhh);
}

function buildBackground() {
  if (S.cssW < 2 || S.cssH < 2) return;
  var tw = Math.max(8, Math.min(Math.round(S.cssW * S.dpr), 2000));
  var th = Math.max(8, Math.round(tw * S.cssH / S.cssW));
  var source;
  if (S.customImg) {
    source = mkCanvas(tw, th);
    drawCover(source.getContext('2d'), S.customImg, tw, th);
  } else {
    var Sc = SCENES[S.sceneIndex];
    if (Sc.image || Sc.preview) {
      source = mkCanvas(tw, th);
      var photoCtx = source.getContext('2d');
      if (hasFilter(photoCtx)) photoCtx.filter = 'saturate(' + Sc.saturation + ') contrast(0.94)';
      drawCover(photoCtx, Sc.image || Sc.preview, tw, th, Sc.focus);
      photoCtx.filter = 'none';
    } else if (Sc.failed) source = Sc.make(tw, th, Sc.seed);
    else {
      if (BG.sharp) return;
      source = mkCanvas(tw, th);
      source.getContext('2d').fillStyle = '#17232b';
      source.getContext('2d').fillRect(0, 0, tw, th);
    }
  }

  var sharp = mkCanvas(tw, th), sc = sharp.getContext('2d');
  sc.imageSmoothingEnabled = true;
  sc.drawImage(source, 0, 0, tw, th);

  var aw = Math.max(8, tw >> 1), ah = Math.max(8, th >> 1);
  var bA = mkCanvas(aw, ah), ac = bA.getContext('2d');
  ac.imageSmoothingEnabled = true;
  if (hasFilter(ac)) {
    ac.filter = 'blur(' + Math.max(1.5, Math.min(aw, ah) * (softMist ? 0.024 : 0.018)) + 'px)';
    ac.drawImage(sharp, 0, 0, aw, ah);
    ac.filter = 'none';
  } else ac.drawImage(sharp, 0, 0, aw, ah);

  var bw = Math.max(8, Math.round(tw * 0.2)), bh = Math.max(8, Math.round(th * 0.2));
  var bB = mkCanvas(bw, bh), bc = bB.getContext('2d');
  bc.imageSmoothingEnabled = true;
  if (hasFilter(bc)) {
    bc.filter = 'blur(' + Math.max(1.0, Math.min(bw, bh) * (softMist ? 0.085 : 0.05)) + 'px)';
    bc.drawImage(sharp, 0, 0, bw, bh);
    bc.filter = 'none';
  } else bc.drawImage(sharp, 0, 0, bw, bh);

  BG.sharp = sharp; BG.blurA = bA; BG.blurB = bB;

  /* 玻璃外表面质感层（与雾气层相互独立） */
  var gOw = clamp(Math.round(tw * 0.6), 400, 1200);
  var gOh = Math.max(200, Math.round(gOw * S.cssH / S.cssW));
  BG.glass = makeGlassOverlay(gOw, gOh);

  if (useGL && gl) {
    if (!BG.t0) { BG.t0 = gl.createTexture(); BG.t1 = gl.createTexture(); BG.t2 = gl.createTexture(); }
    gl.activeTexture(gl.TEXTURE2);
    texFromCanvas(BG.t0, sharp, false);
    gl.activeTexture(gl.TEXTURE3);
    texFromCanvas(BG.t1, bA, false);
    gl.activeTexture(gl.TEXTURE4);
    texFromCanvas(BG.t2, bB, false);
    gl.activeTexture(gl.TEXTURE6);
    gl.activeTexture(gl.TEXTURE5);
    texFromCanvas(grainTex, makeGrainAtlas(), false);
    gl.activeTexture(gl.TEXTURE0);
    fogTexReady = false; dropTexReady = false;
  }
}

function uploadSimTextures() {
  if (!useGL || !gl || !fogTex) return;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fogTex);
  if (!fogTexReady) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fogCanvas);
    setTexParams(fogTex, false);
    fogTexReady = true;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, fogCanvas);
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, dropTex);
  if (!dropTexReady) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dropCanvas);
    setTexParams(dropTex, false);
    dropTexReady = true;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, dropCanvas);
  }
}

/* ------------------------------------------------------------------ 渲染 */
var tmpC = null, tmpCtx = null;

function renderGL(t) {
  gl.viewport(0, 0, S.bufW, S.bufH);
  gl.useProgram(prog);
  gl.uniform2f(U.texel, 1 / Math.max(1, dw), 1 / Math.max(1, dh));
  gl.uniform2f(U.buf, S.bufW, S.bufH);
  gl.uniform2f(U.rainTexel, 1 / Math.max(1, rw), 1 / Math.max(1, rh));
  gl.uniform1f(U.rainAmt, S.rainAmt);
  gl.uniform1f(U.snowAmt, S.snowAmt);
  gl.uniform1f(U.time, t);
  gl.uniform1f(U.flight, flightScene() ? 1 : 0);
  gl.uniform1f(U.cloudTime, MIST_WINDOWS.state().reduced ? 0 : t);
  gl.uniform4f(U.aperture, aperture.x/S.cssW, aperture.y/S.cssH, aperture.w/S.cssW, aperture.h/S.cssH);
  gl.uniform1f(U.polish, originalLook ? 0 : 1);
  gl.uniform1f(U.mist, softMist ? 1 : 0);
  gl.uniform3fv(U.fogTint, S.customImg ? [0.90, 0.91, 0.91] : SCENES[S.sceneIndex].tint);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function flightScene() { return S.windowStyle === 4 && !S.customImg && SCENES[S.sceneIndex].flight; }
function drawFlatBackground(ctx,img,t,W,H) {
  var offset=flightScene()&&!MIST_WINDOWS.state().reduced?Math.sin(t*.028)*.035*aperture.w*S.dpr:0;
  ctx.drawImage(img,offset,0,W,H);
}
function renderFlat(t) {
  if (!flatCtx) return;
  var W = S.bufW, H = S.bufH;
  if (!tmpC || tmpC.width !== W || tmpC.height !== H) {
    tmpC = mkCanvas(W, H); tmpCtx = tmpC.getContext('2d');
  }
  var c2 = flatCtx;
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.clearRect(0, 0, W, H);
  if (BG.sharp) drawFlatBackground(c2, BG.sharp, t, W, H);

  if (fogCanvas && BG.blurB) {
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    tmpCtx.globalCompositeOperation = 'source-over';
    tmpCtx.globalAlpha = 1;
    tmpCtx.clearRect(0, 0, W, H);
    drawFlatBackground(tmpCtx, BG.blurB, t, W, H);
    if (softMist) {
      var tint = S.customImg ? [0.90, 0.91, 0.91] : SCENES[S.sceneIndex].tint;
      tmpCtx.fillStyle = 'rgba(' + Math.round(tint[0]*196) + ',' + Math.round(tint[1]*196) + ',' + Math.round(tint[2]*196) + ',0.40)';
      tmpCtx.fillRect(0, 0, W, H);
    }
    tmpCtx.globalCompositeOperation = 'destination-in';
    tmpCtx.drawImage(fogCanvas, 0, 0, W, H);
    tmpCtx.globalCompositeOperation = 'source-over';
    c2.save(); c2.globalAlpha = 0.92; c2.drawImage(tmpC, 0, 0); c2.restore();
  }
  /* 简化模式下叠加表面灰迹与灰尘 */
  if (BG.glass) {
    c2.save();
    c2.globalCompositeOperation = 'lighter';
    c2.globalAlpha = softMist ? 0 : 0.35;
    c2.drawImage(BG.glass, 0, 0, W, H);
    c2.restore();
  }
  /* 简化模式下的雨雪 */
  for (i = 0; i < snowFlakes.length; i++) {
    var sfl = snowFlakes[i];
    softGlow(c2, sfl.x / Math.max(1, rw) * W, sfl.y / Math.max(1, rh) * H,
             Math.max(1.5, sfl.r / Math.max(1, rw) * W * 1.4),
             '226,236,252', (0.20 + 0.25 * Math.min(1, sfl.r / 4)) * Math.min(1, S.snowAmt / 0.68));
  }
  for (i = 0; i < rainDrops.length; i++) {
    var rdr = rainDrops[i];
    softGlow(c2, rdr.x / Math.max(1, rw) * W, rdr.y / Math.max(1, rh) * H,
             Math.max(1.2, rdr.r / Math.max(1, rw) * W * 0.9), '210,228,250', 0.28 * Math.min(1, S.rainAmt / 0.68));
  }
  c2.save();
  c2.globalAlpha = Math.min(1, S.rainAmt / 0.68);
  for (i = 0; i < rainStreaks.length; i++) {
    var rs = rainStreaks[i], rx = W / rw, ry = H / rh;
    c2.strokeStyle = 'rgba(135,161,177,' + rs.alpha + ')'; c2.lineWidth = Math.max(0.5, rs.width * rx);
    c2.beginPath(); c2.moveTo(rs.x * rx, rs.y * ry);
    c2.lineTo((rs.x + rs.length * .045) * rx, (rs.y - rs.length) * ry); c2.stroke();
  }
  c2.restore();
  /* 降级模式下的水珠 */
  for (var i = 0; i < drops.length; i++) {
    var d = drops[i];
    var px = d.x / dw * W, py = d.y / dh * H, R = d.r / dw * W;
    if (R < 0.8) continue;
    var g = c2.createRadialGradient(px - R * 0.25, py - R * 0.3, R * 0.05, px, py, R);
    g.addColorStop(0, 'rgba(235,244,255,0.55)');
    g.addColorStop(0.55, 'rgba(160,190,225,0.20)');
    g.addColorStop(1, 'rgba(120,150,190,0)');
    c2.fillStyle = g;
    c2.beginPath(); c2.arc(px, py, R, 0, Math.PI * 2); c2.fill();
  }
}

function render(t) {
  if (useGL && gl && prog) renderGL(t);
  else renderFlat(t);
}

/* ================================================================ 麦克风 */
var micStream = null, micCtx = null, micAn = null, micTime = null, micFreq = null;
var micFloor = 0.006, micPending = false, micRequest = 0;

function updateMic(dt) {
  S.micLevel = 0;
  if (!S.micOn || !micAn || !micTime) return;
  if (micCtx && micCtx.state !== 'running') return;

  micAn.getByteTimeDomainData(micTime);
  var n = micTime.length, sum = 0, i, v;
  for (i = 0; i < n; i++) { v = (micTime[i] - 128) / 128; sum += v * v; }
  var rms = Math.sqrt(sum / n);

  /* 自适应底噪：下降快、上升极慢（长吹气不会把阈值顶高） */
  if (rms < micFloor) micFloor += (rms - micFloor) * Math.min(1, dt * 9);
  else micFloor += (rms - micFloor) * Math.min(1, dt * 0.004);
  if (micFloor < 0.0009) micFloor = 0.0009;

  var raw = sstep(1.8, 4.0, rms / micFloor) * sstep(0.006, 0.045, rms);

  /* 高频气流声占比：呼气是宽带噪声，低频嗡声不计入 */
  micAn.getByteFrequencyData(micFreq);
  var hi = 0, all = 0;
  for (i = 4; i < 100; i++) { all += micFreq[i]; if (i >= 16) hi += micFreq[i]; }
  var hf = all > 0 ? hi / all : 0.5;
  raw *= 0.7 + 0.5 * clamp(hf * 2.2, 0, 1);
  if (raw > 1) raw = 1;

  var k = raw > S.micEnv ? dt * 7 : dt * 2.2;
  if (k > 1) k = 1;
  S.micEnv += (raw - S.micEnv) * k;
  S.micLevel = S.micEnv;
}

function updateMicButton() {
  var paused = S.micOn && micCtx && micCtx.state !== 'running';
  btnMic.classList.toggle('active', S.micOn);
  btnMic.classList.toggle('pending', micPending);
  btnMic.setAttribute('aria-pressed', S.micOn ? 'true' : 'false');
  btnMic.setAttribute('aria-busy', micPending ? 'true' : 'false');
  btnMic.querySelector('span').textContent = micPending ? '连接中' : paused ? '点按恢复' : S.micOn ? '已开启' : '麦克风';
  btnMic.setAttribute('aria-label', micPending ? '取消麦克风连接' : paused ? '恢复麦克风哈气' : S.micOn ? '关闭麦克风哈气' : '开启麦克风哈气');
}
function micFail(msg) {
  stopMic(); showToast(msg + '，可以用「按住哈气」', 3400);
}
function stopStream(stream) { stream.getTracks().forEach(function (track) { track.stop(); }); }
function micOk(stream, request) {
  if (request !== micRequest || !micPending || document.hidden) { stopStream(stream); return; }
  micStream = stream;
  try {
    var src = micCtx.createMediaStreamSource(stream);
    var hp = micCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 700; hp.Q.value = 0.7;
    micAn = micCtx.createAnalyser(); micAn.fftSize = 1024; micAn.smoothingTimeConstant = 0.5;
    var mute = micCtx.createGain(); mute.gain.value = 0;
    src.connect(hp); hp.connect(micAn); micAn.connect(mute); mute.connect(micCtx.destination);
    micTime = new Uint8Array(micAn.fftSize); micFreq = new Uint8Array(micAn.frequencyBinCount);
    micFloor = 0.006; S.micEnv = 0; S.micLevel = 0;
    micPending = false; S.micOn = true;
    stream.getAudioTracks().forEach(function (track) {
      track.onended = function () { if (request === micRequest) micFail('麦克风连接已结束'); };
    });
    updateMicButton(); hideHint();
    showToast('对着手机麦克风轻轻哈气 · 声音仅在本机分析', 3200);
  } catch (e) { micFail('麦克风暂时不可用'); }
}
function startMic() {
  if (micPending || S.micOn) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { micFail('当前浏览器未开放麦克风'); return; }
  var request = ++micRequest;
  micPending = true; updateMicButton();
  try {
    // Create and resume inside the tap gesture, before waiting for permission.
    micCtx = new AC();
    micCtx.onstatechange = function () { if (request === micRequest) updateMicButton(); };
    if (micCtx.resume) micCtx.resume().catch(function () { if (request === micRequest) micFail('音频未能启动'); });
  } catch (e) { micFail('音频未能启动'); return; }
  showToast('允许麦克风后，轻轻哈一口气', 3000);
  var constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  navigator.mediaDevices.getUserMedia(constraints).then(function (stream) { micOk(stream, request); }).catch(function (err) {
    if (request !== micRequest) return;
    if (err && err.name === 'OverconstrainedError') {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) { micOk(stream, request); }).catch(function () { if (request === micRequest) micFail('麦克风未能开启'); });
    } else micFail('麦克风未开启');
  });
}
function stopMic() {
  ++micRequest; micPending = false;
  S.micOn = false; S.micLevel = 0; S.micEnv = 0;
  if (micStream) { stopStream(micStream); micStream = null; }
  if (micCtx) { var ctx = micCtx; micCtx = null; ctx.onstatechange = null; try { if (ctx.close) ctx.close().catch(function () {}); } catch (e) {} }
  micAn = null; micTime = null; micFreq = null;
  updateMicButton(); btnMic.style.setProperty('--mic-level', '0');
}
function toggleMic() {
  if (micPending) { stopMic(); showToast('已取消，按住按钮也可以哈气'); }
  else if (S.micOn && micCtx && micCtx.state !== 'running') {
    micCtx.resume().then(updateMicButton).catch(function () { micFail('麦克风未能恢复'); });
  } else if (S.micOn) { stopMic(); showToast('麦克风已关闭', 1500); }
  else startMic();
}

/* ================================================================ 呼吸源 */
function updateHoldCheck() {
  if (!S.down || S.mode === 'hold') return;
  if (!MIST_WINDOWS.contains(aperture, S.lastX * S.cssW, S.lastY * S.cssH)) return;
  /* 停笔约 0.7 秒不动 → 在该处呼气；一动即恢复写字 */
  if (S.time - S.lastMoveT > 0.68 && S.time - S.downT > 0.72) {
    /* 按住不动 → 在该区域呼气 */
    S.mode = 'hold';
    S.holdX = S.lastX * S.cssW;
    S.holdY = S.lastY * S.cssH;
    hideHint();
  }
}

function updateBreath(dt) {
  var holdT = (S.manualHeld || (S.down && S.mode === 'hold')) ? 1 : 0;
  var hk = Math.min(1, dt * (holdT ? 5 : 9));
  S.holdLevel += (holdT - S.holdLevel) * hk;

  var sk = Math.min(1, dt * (S.space ? 5.5 : 9));
  S.spaceLevel += ((S.space ? 1 : 0) - S.spaceLevel) * sk;

  updateMic(dt);

  var lvl = 0, src = null;
  if (S.holdLevel > lvl) { lvl = S.holdLevel; src = 'hold'; }
  if (S.spaceLevel > lvl) { lvl = S.spaceLevel; src = 'space'; }
  if (S.micLevel > lvl) { lvl = S.micLevel; src = 'mic'; }
  S.breathLevel = lvl;

  var tx = 0.5, ty = 0.46, rr = 0.16;
  if (src === 'hold') {
    tx = S.holdX / Math.max(1, S.cssW);
    ty = S.holdY / Math.max(1, S.cssH);
    rr = 0.13;
  } else if (src === 'space') {
    tx = S.lastPointer.x; ty = S.lastPointer.y; rr = 0.17;
  } else if (src === 'mic') {
    /* 麦克风没有方位：焦点在画面中央附近缓慢游移，仍保持局部扩散 */
    S.micDriftT -= dt;
    if (S.micDriftT <= 0) {
      S.micDriftT = 2.0 + Math.random() * 2.5;
      S.micDriftA = Math.random() * Math.PI * 2;
    }
    S.micDriftX += Math.cos(S.micDriftA) * dt * 0.05;
    S.micDriftY += Math.sin(S.micDriftA) * dt * 0.05;
    if (S.micDriftX > 0.12) S.micDriftX = 0.12;
    if (S.micDriftX < -0.12) S.micDriftX = -0.12;
    if (S.micDriftY > 0.10) S.micDriftY = 0.10;
    if (S.micDriftY < -0.10) S.micDriftY = -0.10;
    tx = 0.5 + S.micDriftX; ty = 0.47 + S.micDriftY; rr = 0.30;
  }
  if (!MIST_WINDOWS.contains(aperture, tx * S.cssW, ty * S.cssH)) {
    var point=MIST_WINDOWS.breathPoint(aperture);
    if(point){tx=point.x/S.cssW;ty=point.y/S.cssH;}else{S.breathLevel=0;lvl=0;}
  }
  S.breathR = rr;
  var kk = Math.min(1, dt * 4);
  S.breathX += (tx - S.breathX) * kk;
  S.breathY += (ty - S.breathY) * kk;
}

/* ================================================================ 交互 */
function brushRadius() {
  var m = Math.min(S.cssW, S.cssH);
  /* 笔宽按书写调校：中心一擦即清，外缘仍留潮湿痕迹 */
  if (S.pointerType === 'touch') return clamp(m * 0.04, 15, 26);
  return clamp(m * 0.017, 12, 22);
}

function fakePointerDown(cx, cy) {
  if (!MIST_WINDOWS.contains(aperture, cx, cy)) return;
  try {
    var nx = clamp(cx / Math.max(1, S.cssW), 0, 1);
    var ny = clamp(cy / Math.max(1, S.cssH), 0, 1);
    S.down = true; S.mode = 'wipe';
    S.downT = S.time; S.lastMoveT = S.time;
    S.lastX = nx; S.lastY = ny; S.downX = nx; S.downY = ny;
    S.lastPointer.x = nx; S.lastPointer.y = ny; S.lastPointer.t = S.time;
    strokeDist = 0;
    S.tapStarted = Date.now(); S.tapMoved = false;
    hideHint();
    /* 落点立即擦一笔，写字手感更直接 */
    if (fogF) stampWipe(nx * dw, ny * dh, brushRadius() * densityScale);
  } catch (err) {
    throw makeDiagError('POINTER_DOWN', err);
  }
}

function fakePointerMove(cx, cy) {
  if (!S.down) return;
  if (Math.abs(cx / S.cssW - S.downX) * S.cssW > 8 || Math.abs(cy / S.cssH - S.downY) * S.cssH > 8) S.tapMoved = true;
  if (!MIST_WINDOWS.contains(aperture, cx, cy)) {
    S.mode = "wipe"; S.lastX = cx / S.cssW; S.lastY = cy / S.cssH; S.lastMoveT = S.time;
    return;
  }
  try {
    var nx = clamp(cx / Math.max(1, S.cssW), 0, 1);
    var ny = clamp(cy / Math.max(1, S.cssH), 0, 1);
    S.lastMoveT = S.time;
    var dx = (nx - S.lastX) * S.cssW, dy = (ny - S.lastY) * S.cssH;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (S.mode === 'hold') {
      if (dist <= 5) { S.lastX = nx; S.lastY = ny; S.lastPointer.x = nx; S.lastPointer.y = ny; return; }
      S.mode = 'wipe'; /* 移动 → 从呼气切回擦拭写字 */
    }

    if (fogF) {
      var R = brushRadius() * densityScale;
      var p = wipeSegment(S.lastX * dw, S.lastY * dh, nx * dw, ny * dh, R);
      strokeDist += dist * densityScale;
      /* 湿笔迹偶尔聚成小水珠下滑 */
      if (p && strokeDist > 45 && wetF[p.i] > 0.3 && Math.random() < 0.4) {
        spawnDrop(p.x, p.y, 1.6 + Math.random() * 4.0, 7 + Math.random() * 7);
        strokeDist = 0;
      }
      hideHint();
    }
    S.lastX = nx; S.lastY = ny;
    S.lastPointer.x = nx; S.lastPointer.y = ny; S.lastPointer.t = S.time;
  } catch (err) {
    throw makeDiagError('POINTER_MOVE', err);
  }
}

function fakePointerUp(cancelled) {
  if (!S.down) return;
  S.down = false;
  var nowMs = Date.now(), nx = S.downX, ny = S.downY;
  if (!cancelled && !S.tapMoved && nowMs - S.tapStarted < 250) {
    var dx = (nx - S.lastTapX) * S.cssW, dy = (ny - S.lastTapY) * S.cssH;
    if (S.lastTapT && nowMs - S.lastTapT < 320 && dx * dx + dy * dy < 1600) {
      nextWeather(); S.lastTapT = 0;
    } else { S.lastTapT = nowMs; S.lastTapX = nx; S.lastTapY = ny; }
  } else S.lastTapT = 0;
  if (S.mode === 'hold') S.mode = 'wipe';
}

function targetInDock(target) {
  var el = target;
  while (el && el !== document) {
    if (el.id === 'controls' || el.id === 'shadeHandle' || el.id === 'dock' || el.id === 'melt' || el.id === 'btnMic' || el.id === 'btnScene' ||
        el.id === 'btnWeather' || el.id === 'btnWindow' || el.id === 'btnUpload') return true;
    el = el.parentNode;
  }
  return false;
}

function bindInput() {
  if (window.PointerEvent) {
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      if (targetInDock(e.target)) return;
      S.pointerType = e.pointerType || 'mouse';
      if (S.pointerId !== null) return;
      S.pointerId = e.pointerId;
      try { if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId); } catch (err) {}
      fakePointerDown(e.clientX, e.clientY);
      if (e.preventDefault) e.preventDefault();
    }, false);

    stage.addEventListener('pointermove', function (e) {
      var nx = clamp(e.clientX / Math.max(1, S.cssW), 0, 1);
      var ny = clamp(e.clientY / Math.max(1, S.cssH), 0, 1);
      if (!S.down) {
        S.lastPointer.x = nx; S.lastPointer.y = ny; S.lastPointer.t = S.time;
        return;
      }
      if (e.pointerId !== S.pointerId) return;
      var evs = null;
      if (e.getCoalescedEvents) {
        try { evs = e.getCoalescedEvents(); } catch (err) { evs = null; }
      }
      if (evs && evs.length > 0) {
        for (var i = 0; i < evs.length; i++) {
          fakePointerMove(evs[i].clientX, evs[i].clientY);
        }
      } else fakePointerMove(e.clientX, e.clientY);
    }, false);

    function up(e) {
      if (e && S.pointerId !== null && e.pointerId !== S.pointerId) return;
      S.pointerId = null;
      fakePointerUp(e && e.type !== 'pointerup');
    }
    stage.addEventListener('pointerup', up, false);
    stage.addEventListener('pointercancel', up, false);
    stage.addEventListener('lostpointercapture', up, false);
    stage.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') up(e);
    }, false);
  } else {
    /* 触摸 / 鼠标降级路径 */
    stage.addEventListener('touchstart', function (e) {
      if (targetInDock(e.target)) return;
      if (!e.touches || e.touches.length !== 1) { fakePointerUp(); return; }
      S.pointerType = 'touch';
      S.pointerId = 'fallback';
      fakePointerDown(e.touches[0].clientX, e.touches[0].clientY);
      if (e.preventDefault) e.preventDefault();
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      fakePointerMove(e.touches[0].clientX, e.touches[0].clientY);
      if (e.preventDefault) e.preventDefault();
    }, { passive: false });
    stage.addEventListener('touchend', function () { S.pointerId = null; fakePointerUp(); }, false);
    stage.addEventListener('touchcancel', function () { S.pointerId = null; fakePointerUp(true); }, false);

    stage.addEventListener('mousedown', function (e) {
      if (e.button) return;
      if (targetInDock(e.target)) return;
      S.pointerType = 'mouse';
      S.pointerId = 'fallback';
      fakePointerDown(e.clientX, e.clientY);
    }, false);
    window.addEventListener('mousemove', function (e) {
      var nx = clamp(e.clientX / Math.max(1, S.cssW), 0, 1);
      var ny = clamp(e.clientY / Math.max(1, S.cssH), 0, 1);
      S.lastPointer.x = nx; S.lastPointer.y = ny; S.lastPointer.t = S.time;
      if (S.down) fakePointerMove(e.clientX, e.clientY);
    }, false);
    window.addEventListener('mouseup', function () { S.pointerId = null; fakePointerUp(); }, false);
  }
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
}

function bindKeys() {
  window.addEventListener('keydown', function (e) {
    var k = e.key || e.code;
    var isSpace = (k === ' ' || k === 'Spacebar' || k === 'Space');
    if (isSpace) {
      var tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!S.space) { S.space = true; hideHint(); }
      if (e.preventDefault) e.preventDefault();
      return;
    }
    if (k === 'm' || k === 'M') toggleMic();
    if (k === 'c' || k === 'C') nextScene();
  }, false);
  window.addEventListener('keyup', function (e) {
    var k = e.key || e.code;
    if (k === ' ' || k === 'Spacebar' || k === 'Space') {
      S.space = false;
      if (e.preventDefault) e.preventDefault();
    }
  }, false);
  window.addEventListener('blur', function () {
    S.space = false; stopManualBreath();
    S.pointerId = null;
    fakePointerUp(true);
  }, false);
}

function stopManualBreath() {
  S.manualHeld = false;
  if (btnBreath) { btnBreath.classList.remove('held'); btnBreath.querySelector('span').textContent = '按住哈气'; }
}
function bindBreathButton() {
  var pointer = null;
  function start(e) {
    if (e && e.preventDefault) e.preventDefault();
    var point = MIST_WINDOWS.breathPoint(aperture);
    if (!point) { showToast('先拉开遮光板，再哈气', 2000); return; }
    fakePointerUp(true); S.holdX = point.x; S.holdY = point.y;
    S.manualHeld = true; btnBreath.classList.add('held');
    btnBreath.querySelector('span').textContent = '正在哈气'; hideHint();
  }
  function end() { pointer = null; stopManualBreath(); }
  if (window.PointerEvent) {
    btnBreath.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || pointer !== null) return;
      pointer = e.pointerId; start(e);
      try { btnBreath.setPointerCapture(e.pointerId); } catch (err) {}
    });
    function release(e) { if (pointer === null || e.pointerId === pointer) end(); }
    btnBreath.addEventListener('pointerup', release);
    btnBreath.addEventListener('pointercancel', release);
    btnBreath.addEventListener('lostpointercapture', release);
  } else {
    btnBreath.addEventListener('touchstart', function (e) { if (e.touches.length === 1) start(e); }, {passive:false});
    btnBreath.addEventListener('touchend', end); btnBreath.addEventListener('touchcancel', end);
    btnBreath.addEventListener('mousedown', function (e) { if (!e.button) start(e); });
    window.addEventListener('mouseup', end);
  }
  btnBreath.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') { e.stopPropagation(); if (!e.repeat) start(e); else e.preventDefault(); } });
  btnBreath.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') { e.stopPropagation(); e.preventDefault(); end(); } });
  btnBreath.addEventListener('blur', end);
  btnBreath.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  function suspend() { end(); S.space = false; S.pointerId = null; fakePointerUp(true); stopMic(); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) suspend(); });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('blur', end);
}

/* ================================================================ UI */
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl.style.opacity = '0';
}
function showToast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, ms || 2200);
}
function showLabel(msg) {
  labelEl.textContent = msg;
  labelEl.style.opacity = '1';
  if (labelTimer) clearTimeout(labelTimer);
  labelTimer = setTimeout(function () { labelEl.style.opacity = '0'; }, 1600);
}

function selectScene(index) {
  S.sceneIndex = index;
  S.customImg = null;
  loadScene(index);
  buildBackground();
  showLabel(SCENES[index].name);
  loadScene((index + 1) % SCENES.length);
  hideHint();
}
function nextScene() { selectScene((S.sceneIndex + 1) % SCENES.length); }

function nextWindow() {
  stopManualBreath();
  S.windowStyle = S.windowStyle === 4 ? 2 : S.windowStyle === 2 ? 0 : 4;
  fakePointerUp(true);
  syncFrame();
  setupRain();
  primeWeather(S.weather);
  buildBackground();
  showLabel(S.windowStyle === 4 ? '飞机舷窗' : S.windowStyle === 2 ? '火车窗' : '无框玻璃');
}

var uiTick = 0;
function updateUI() {
  if (++uiTick % 3) return;
  btnBreath.style.setProperty('--breath-level', S.breathLevel.toFixed(2));
  btnMic.style.setProperty('--mic-level', S.micLevel.toFixed(2));
}

/* ================================================================ 主循环 */
var lastT = 0, perfAcc = 0, perfCnt = 0, adapted = false;
var qaFrames = [], qaCpu = [], qaTicks = 0;
if (debugMode) window.__mist = {
  stats: function () {
    function avg(a) { var sum = 0; for (var i = 0; i < a.length; i++) sum += a[i]; return sum / Math.max(1, a.length); }
    var centre = ((dh * 0.48) | 0) * dw + ((dw * 0.5) | 0);
    return { gl: useGL, scene: S.sceneIndex, photoNumber: SCENES[S.sceneIndex].id, photoReady: !!SCENES[S.sceneIndex].image,
      rain: rainDrops.length, rainStreaks: rainStreaks.length, snow: snowFlakes.length, rainAmt: S.rainAmt, snowAmt: S.snowAmt, rainIntensity: rainIntensity,
      custom: !!S.customImg, windowStyle: S.windowStyle, melt: S.melt, weather: S.weather,
      fps: 1000 / Math.max(1, avg(qaFrames)), cpuMs: avg(qaCpu), frames: qaTicks,
      mic: S.micLevel, micOn: S.micOn, micPending: micPending, manualHeld: S.manualHeld, breath: S.breathLevel, fog: fogSum / Math.max(1, flen),
      centerFog: fogF ? fogF[centre] : 0, grid: [dw, dh], dpr: S.dpr, drops: drops.length,
      aperture: aperture ? [aperture.x, aperture.y, aperture.w, aperture.h] : null,
      shade: MIST_WINDOWS.state(), flight: flightScene(), samplers: useGL ? 7 : 0, error: window.__dbgErr, look: originalLook ? 'original' : softMist ? 'soft-mist' : 'previous' };
  }
};

function frame(t) {
  window.requestAnimationFrame(frame);
  try {
    var cpuStart = debugMode ? performance.now() : 0;
    if (debugMode && lastT) { qaFrames.push(t - lastT); if (qaFrames.length > 120) qaFrames.shift(); }
    if (!lastT) lastT = t;
    var dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0.001) dt = 0.001;
    S.time += dt;
    MIST_WINDOWS.tick(dt);
    if (MIST_WINDOWS.state().dragging && S.down) fakePointerUp();
    var f = clamp(dt * 60, 0.2, 2.2);

    updateHoldCheck();
    updateBreath(dt);

    var m = MELT[S.melt] || MELT[1];
    if (fogF) {
      applyBreath(dt, f);
      updateDrops(dt);
      mergeDrops();
      naturalSpawn(dt);
      fogSum = relaxFog(f * MELT_TIME, m);
      diffuseFog(0.030 * m.df, f * MELT_TIME);
      writeFogCanvas();
      writeDropCanvas();
      uploadSimTextures();
    }
    updateRain(dt);
    uploadRainTexture();
    render(S.time);
    updateUI();
    if (debugMode) { qaTicks++; qaCpu.push(performance.now() - cpuStart); if (qaCpu.length > 120) qaCpu.shift(); }

    /* 自适应精度：持续掉帧时降低密度图分辨率 */
    perfAcc += dt; perfCnt++;
    if (perfCnt >= 90) {
      var avg = perfAcc / perfCnt;
      perfAcc = 0; perfCnt = 0;
      if (!adapted && avg > 0.030 && qualityTier === 0) {
        adapted = true;
        qualityTier = 1;
        setupSim(true);
        fogTexReady = false; dropTexReady = false;
        showToast('已降低雾气精度以保持流畅', 2400);
      }
    }
  } catch (err) {
    window.__dbgRethrow = true;
    throw makeDiagError('FRAME', err);
  }
}

/* ================================================================ 尺寸 */
function syncFrame() {
  aperture = MIST_WINDOWS.draw(frameCanvas, S.windowStyle, S.cssW, S.cssH, S.dpr);
  btnWindow.setAttribute('aria-label', '切换窗户，当前：' + (S.windowStyle === 4 ? '飞机舷窗' : S.windowStyle === 2 ? '火车窗' : '无框玻璃'));
  hintEl.innerHTML='按住哈气 · 松开写字<b>'+(S.windowStyle===4?'上方把手可开合遮光板':'也可打开麦克风，轻轻哈气')+'</b>';
  hintEl.style.left = aperture.x + 'px'; hintEl.style.width = aperture.w + 'px'; hintEl.style.right = 'auto'; hintEl.style.padding = '0 12px';
  hintEl.style.top = S.windowStyle ? ((aperture.y + aperture.h * 0.47) / S.cssH * 100) + '%' : '57%';
  if (!MIST_WINDOWS.contains(aperture, S.lastPointer.x * S.cssW, S.lastPointer.y * S.cssH)) {
    S.lastPointer.x = (aperture.x + aperture.w * 0.5) / S.cssW;
    S.lastPointer.y = (aperture.y + aperture.h * 0.5) / S.cssH;
  }
}
var resizeTimer = null;
function applyResize() {
  var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
  var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
  var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
  if (w === S.cssW && h === S.cssH && dpr === S.dpr && fogCanvas) return;

  S.cssW = w; S.cssH = h; S.dpr = dpr;
  S.bufW = Math.max(1, Math.round(w * dpr));
  S.bufH = Math.max(1, Math.round(h * dpr));
  glass.width = S.bufW; glass.height = S.bufH;
  flat.width = S.bufW; flat.height = S.bufH;
  tmpC = null;

  setupSim(!!fogCanvas);
  syncFrame();
  buildBackground();
  if (useGL && gl) gl.viewport(0, 0, S.bufW, S.bufH);
}
function onResize() {
  stopManualBreath();
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyResize, 160);
}

/* ================================================================ 初始化 */
function bindDom() {
  stage = document.getElementById('stage');
  frameCanvas = document.getElementById('windowFrame');
  glass = document.getElementById('glass');
  flat = document.getElementById('flat');
  hintEl = document.getElementById('hint');
  labelEl = document.getElementById('label');
  toastEl = document.getElementById('toast');
  btnBreath = document.getElementById('btnBreath');
  btnMelt = document.getElementById('btnMelt');
  btnMic = document.getElementById('btnMic');
  btnScene = document.getElementById('btnScene');
  btnWeather = document.getElementById('btnWeather');
  btnWindow = document.getElementById('btnWindow');
  btnUpload = document.getElementById('btnUpload');
  fileEl = document.getElementById('file');
}

function bindButtons() {
  btnMic.addEventListener('click', function () { toggleMic(); if (this.blur) this.blur(); }, false);
  bindBreathButton();
  btnScene.addEventListener('click', function () { nextScene(); this.blur(); });
  updateWeatherButton();
  btnWeather.addEventListener('click', function () { nextWeather(); if (this.blur) this.blur(); }, false);
  btnWindow.addEventListener('click', function () { nextWindow(); if (this.blur) this.blur(); }, false);
  btnMelt.addEventListener('click', function () {
    S.melt = (S.melt + 1) % 3;
    var text = ['慢', '中', '快'][S.melt];
    btnMelt.querySelector('span').textContent = '消散·' + text;
    btnMelt.setAttribute('aria-label', '切换消散速度，当前：' + text);
    showLabel('消散速度 · ' + text); this.blur();
  });
  btnUpload.addEventListener('click', function () { fileEl.click(); if (this.blur) this.blur(); }, false);

  fileEl.addEventListener('change', function () {
    try {
      var fl = fileEl.files && fileEl.files[0];
      fileEl.value = '';            /* 立刻清空：同一张图也能再次选择 */
      if (!fl) return;
      if (fl.type && fl.type.indexOf('image/') !== 0) {
        showToast('请选择一张图片作为背景', 2400);
        return;
      }
      var url = URL.createObjectURL(fl);
      var img = new Image();
      img.onload = function () {
        try {
          S.customImg = img;
          buildBackground();
          showLabel('自定义照片');
        } catch (err) { throw makeDiagError('BG_UPLOAD', err); }
        try { URL.revokeObjectURL(url); } catch (e) {}
      };
      img.onerror = function () {
        showToast('图片读取失败，可换一张试试', 2400);
        try { URL.revokeObjectURL(url); } catch (e) {}
      };
      img.src = url;
    } catch (err) {
      throw makeDiagError('BG_SELECT', err);
    }
  }, false);
}

function makeDiagError(where, err) {
  var detail;
  if (err && err.stack) detail = String(err.stack);
  else if (err && err.message) detail = String(err.name || 'Error') + ': ' + String(err.message);
  else detail = Object.prototype.toString.call(err) + ' ' + String(err);
  return new Error('[' + where + '_DIAG] ' + detail);
}

function init() {
  try {
    bindDom();
    breathKernel = makeBreathKernel();
    useGL = initGL();
    if (!useGL) {
      glass.hidden = true;
      flat.hidden = false;
      flatCtx = flat.getContext('2d');
      if (gl) { /* 上下文存在但着色器失败：换画布避开上下文类型冲突 */ gl = null; }
      showToast('当前环境不支持 WebGL，已使用简化渲染', 3200);
    }
    bindInput();
    bindKeys();
    bindButtons();
    applyResize();
    loadScene(S.sceneIndex);
    window.addEventListener('resize', onResize, false);
    window.addEventListener('orientationchange', onResize, false);
    window.requestAnimationFrame(frame);
    setTimeout(function () {
      try { if (!hintHidden) hintEl.style.opacity = '1'; }
      catch (e) { throw makeDiagError('HINT', e); }
    }, 550);
  } catch (err) {
    window.__dbgRethrow = true;
    throw makeDiagError('INIT', err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, false);
else init();

})();

/* ============================================================================
   许可证（随附原项目）

   MIT License — fog-mirror, Copyright (c) 2026 Maher Khan
   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:
   The above copyright notice and this permission notice shall be included in all
   copies or substantial portions of the Software.
   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.

   MIT License — DEWGLASS, Copyright (c) 2026 Sourav Kamble
   （同上，全文一致）

   MIT License — Raindrop / raindrop-fx, Copyright (c) 2021 SardineFish
   （同上，全文一致）
   ========================================================================== */


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
  holdLevel: 0, holdX: 0, holdY: 0,
  space: false, spaceLevel: 0,
  breathLevel: 0, breathX: 0.5, breathY: 0.47, breathR: 0.16, sustain: 0,
  lastPointer: { x: 0.5, y: 0.47, t: 0 },
  pointerType: 'mouse', pointerId: null,
  down: false, mode: 'wipe', downT: 0, lastMoveT: 0,
  lastX: 0.5, lastY: 0.47, downX: 0.5, downY: 0.47,
  windowStyle: windowMatch && Number(windowMatch[1]) === 0 ? 0 : windowMatch && Number(windowMatch[1]) === 2 ? 2 : 4,
  rainAmt: 0, snowAmt: 0, melt: 1,
  weather: 'clear', weatherLevel: 0, weatherHold: 0,
  wind: 0, windTarget: 0, windT: 0,
  lastTapT: 0, lastTapX: 0.5, lastTapY: 0.47,
  time: 0
};

var frameCanvas, aperture = null;
var stage, glass, flat, flatCtx, hintEl, labelEl, toastEl, ringEl, cursorEl,
    btnSave, btnMelt, btnScene, btnWeather, btnWindow, btnUpload, fileEl;
var useGL = false, gl = null, prog = null, U = null;
var fogTex = null, dropTex = null, grainTex = null;
var fogTexReady = false, dropTexReady = false;
var BG = { sharp: null, blurA: null, blurB: null, glass: null, t0: null, t1: null, t2: null, tg: null };

var qualityTier = 0;
var fogSum = 0;
/* 消散四档：蒸发 / 环境重凝 / 边缘扩散 的倍率；最后一档保留雾与字迹 */
var MELT = [
  { ev: 0.45, am: 0.55, ac: 0.55, df: 0.60 },
  { ev: 1.00, am: 1.00, ac: 1.00, df: 1.00 },
  { ev: 1.95, am: 1.65, ac: 1.60, df: 1.45 },
  { ev: 0, am: 0, ac: 0, df: 0, hold: true }
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
var fogF = null, wetF = null, bareF = null, resF = null;
var goalF = null, introK = null, introT = 0;     /* 开场：玻璃先是干净的，水汽一片片凝上来 */
var fogU8 = null;
var DROP_CAP = 120;
var sites = [];
var ambF = null, accK = null, evpN = null, dotN = null;
var scratchF = null;
var fogCanvas = null, fogCtx = null, fogImg = null, fogBuf = null;
var drops = [];
var naturalAcc = 0;

/* 外层降雨（窗户外侧，位于雾气层之后） */
var rainDrops = [], rainAcc = 0;
var snowFlakes = [], snowAcc = 0;
var rainStreaks = [];
var rainIntensity = 0.6, rainTarget = 0.6, rainIntensityT = 0;
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
  var n = noise2D(777), nk = noise2D(1999), x, y, i;
  fogF = new Float32Array(flen);
  wetF = new Float32Array(flen);
  bareF = new Float32Array(flen);
  resF = new Float32Array(flen);
  goalF = new Float32Array(flen);
  introK = new Float32Array(flen);
  introT = 0;
  for (y = 0; y < dh; y++) for (x = 0; x < dw; x++) {
    i = y * dw + x;
    var p = fbm(n, x / 46, y / 46);
    var p2 = n(x / 13 + 9, y / 13 + 31);
    var yy = (y + 0.5) / dh, ex = Math.abs((x + 0.5) / dw * 2 - 1);
    /* 冷玻璃下半部和两侧更容易结雾，上方中间薄一些，能透出窗外 */
    goalF[i] = clamp(0.36 + 0.26 * p + 0.05 * p2 + 0.26 * yy * yy + 0.10 * sstep(0.6, 1, ex), 0.20, 0.86);
    introK[i] = (0.25 + 1.25 * fbm(nk, x / 18, y / 18)) * (0.7 + 0.5 * yy + 0.4 * ex);
  }
}

function setupSim(preserve) {
  var sz = simSize();
  if (preserve && fogCanvas && dw > 0 && (sz.w !== dw || sz.h !== dh)) {
    /* 尺寸变化时拉伸旧密度图，保留用户已擦出的笔迹 */
    var old = fogCanvas, oFog = fogF, oWet = wetF, oBare = bareF, oRes = resF, oGoal = goalF, oK = introK, oW = dw, oH = dh;
    var nc = mkCanvas(sz.w, sz.h), n2 = nc.getContext('2d');
    n2.imageSmoothingEnabled = true;
    n2.drawImage(old, 0, 0, sz.w, sz.h);
    dw = sz.w; dh = sz.h; flen = dw * dh; densityScale = sz.s;
    fogF = new Float32Array(flen); wetF = new Float32Array(flen); bareF = new Float32Array(flen); resF = new Float32Array(flen);
    goalF = oGoal ? new Float32Array(flen) : null; introK = oGoal ? new Float32Array(flen) : null;
    for (var i = 0; i < flen; i++) {
      var x = i % dw, y = (i / dw) | 0;
      var ox = Math.min(oW - 1, (x * oW / dw) | 0), oy = Math.min(oH - 1, (y * oH / dh) | 0);
      var oi = oy * oW + ox;
      fogF[i] = oFog[oi]; wetF[i] = oWet[oi]; bareF[i] = oBare[oi]; resF[i] = oRes[oi];
      if (oGoal) { goalF[i] = oGoal[oi]; introK[i] = oK[oi]; }
    }
    fogCanvas = nc; fogCtx = n2;
  } else {
    dw = sz.w; dh = sz.h; flen = dw * dh; densityScale = sz.s;
    fogCanvas = mkCanvas(dw, dh);
    fogCtx = fogCanvas.getContext('2d');
    initFogArrays();
  }
  buildStaticFields();
  fogImg = fogCtx.createImageData(dw, dh); fogBuf = fogImg.data; fogU8 = null;
  drops.length = 0;
  buildSites();
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
    var F0 = fogF[i];
    fogF[i] *= (1 - erase);
    resF[i] *= (1 - erase);
    /* 手指把水推到笔画边上，堆成一圈稍大的水珠 */
    if (q > 0.92) { var ridge = Math.min(1, F0 * 0.85 + 0.12) * (1 - sstep(1.12, 1.3, q)); if (ridge > resF[i]) resF[i] = ridge; }
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
    /* 残留水珠：跟着雾长起来，但比雾散得慢，雾退后还挂一阵 */
    var R = resF[i];
    if (m.hold) { /* 不融化：残留水珠也原样保留 */ }
    else if (F > R) R += (F - R) * 0.12 * f;
    else { R -= (0.00012 + 0.06 * evpN[i]) * m.ev * f; if (R < 0) R = 0; }
    resF[i] = R;
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
/* 一颗水珠的一生：雾厚的地方慢慢成核 → 吸周围的水汽长大（周围留出一圈干净）
   → 超过临界大小开始往下滑，走走停停，吞并路上的珠子越滑越快
   → 沿途留下细小水珠；雾散了以后，没滑走的珠子慢慢蒸发变小。
   坐标和半径都是雾气网格单位（texel），速度换算自 css px。 */
function dropCritical() {
  return clamp(Math.min(S.cssW, S.cssH) * 0.0062, 3.0, 5.4) * densityScale;
}
function dropSpeed(d) {
  var e = d.r / d.rc - 0.66;
  if (e <= 0) return 0;
  return (7 + 78 * Math.pow(e, 1.5)) * d.vf * densityScale;   /* texels/s */
}
function spawnDrop(x, y, r, grow) {
  if (drops.length >= DROP_CAP) return null;
  var d = {
    x: x, y: y, r: r, rc: dropCritical() * (0.82 + 0.4 * Math.random()),
    vx: 0, vy: 0, maxV: 1, vf: 0.75 + 0.5 * Math.random(), gk: 0.7 + 0.8 * Math.random(),
    grow: grow !== false, slide: false, pause: 0, wander: (Math.random() - 0.5) * 0.3,
    dist: 0, nextPin: 0, nextBead: 0, age: 0, seed: Math.random(), dead: false
  };
  d.nextPin = d.r * (3 + Math.random() * 9);
  d.nextBead = d.r * (2 + Math.random() * 4);
  drops.push(d);
  return d;
}

function fogAt(x, y) {
  var xi = clamp(x | 0, 0, dw - 1), yi = clamp(y | 0, 0, dh - 1);
  return fogF[yi * dw + xi];
}

/* 滑过的地方：把雾和残留水珠一起带走，返回收集到的水量 */
function dropTrail(x0, y0, x1, y1, R) {
  // Droplets still move, while this mode preserves the writing underneath them.
  if (MELT[S.melt].hold) return 0;
  var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
  var steps = Math.max(1, Math.ceil(len / Math.max(0.6, R * 0.45)));
  if (steps > 24) steps = 24;
  var s, t, cx, cy, x0i, x1i, y0i, y1i, px, py, i2, got = 0;
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
      got += fogF[i2] * 0.82 * e;
      fogF[i2] *= (1 - 0.82 * e);
      resF[i2] *= (1 - 0.85 * e);
      var wv = (1 - sstep(0, 1.2, q)) * 0.85;
      if (wv > wetF[i2]) wetF[i2] = wv;
      var bv = 1 - sstep(0.2, 1.25, q);
      if (bv > bareF[i2]) bareF[i2] = bv;
    }
  }
  return got / (steps + 1);
}

/* 静止的水珠吸周围的水汽：留下一圈更干净的玻璃 */
function dropAbsorb(d, dt) {
  var R = d.r * 2.4, k = 0.22 * dt;
  var x0 = Math.max(0, Math.floor(d.x - R)), x1 = Math.min(dw - 1, Math.ceil(d.x + R));
  var y0 = Math.max(0, Math.floor(d.y - R)), y1 = Math.min(dh - 1, Math.ceil(d.y + R));
  for (var py = y0; py <= y1; py++) for (var px = x0; px <= x1; px++) {
    var dx = px + 0.5 - d.x, dy = py + 0.5 - d.y, q = Math.sqrt(dx * dx + dy * dy) / R;
    if (q > 1) continue;
    var i = py * dw + px, w = q < 0.42 ? 1 : 1 - sstep(0.42, 1, q);
    fogF[i] *= 1 - Math.min(1, k * w * (q < 0.42 ? 6 : 1));
    if (q < 0.5) resF[i] *= 1 - Math.min(1, k * 4);
  }
}

function updateDrops(dt) {
  var m = MELT[S.melt] || MELT[1], hold = !!m.hold, i;
  var cssPx = densityScale;
  for (i = drops.length - 1; i >= 0; i--) {
    var d = drops[i];
    d.age += dt;
    if (!d.slide) {
      /* 附着：看外圈的雾，雾厚就长，雾散了就慢慢蒸发 */
      var ring = d.r * 2.7;
      var Fc = (fogAt(d.x - ring, d.y) + fogAt(d.x + ring, d.y) + fogAt(d.x, d.y - ring) + fogAt(d.x, d.y + ring)) * 0.25;
      if (d.grow && Fc > 0.30) d.r += 0.70 * (Fc - 0.30) * d.gk * cssPx * dt;
      else if (!hold) d.r -= (Fc < 0.18 ? 0.05 : 0.018) * m.ev * MELT_TIME * cssPx * dt * (d.grow ? 1 : 1.4);
      if (!hold && d.grow) dropAbsorb(d, dt);
      d.vy *= Math.exp(-dt * 10); d.vx *= Math.exp(-dt * 10);
      if (d.r >= d.rc) { d.slide = true; d.grow = true; d.pause = 0; }
    } else {
      d.maxV = Math.max(1, dropSpeed(d));
      if (d.pause > 0) d.pause -= dt;
      var target = d.pause > 0 ? 0 : dropSpeed(d);
      d.vy += (target - d.vy) * Math.min(1, dt * (target > d.vy ? 2.2 : 10));
      /* 横向：慢慢游走，并偏向更干的一侧（沿旧水痕走） */
      d.wander += (Math.random() - 0.5) * dt * 1.6;
      d.wander = clamp(d.wander, -0.35, 0.35);
      var ahead = d.y + d.r * 1.6;
      var steer = clamp((fogAt(d.x - d.r * 1.3, ahead) - fogAt(d.x + d.r * 1.3, ahead)) * 1.4, -0.4, 0.4);
      d.vx = d.vy * clamp(d.wander + steer, -0.45, 0.45);
      var nx = d.x + d.vx * dt, ny = d.y + d.vy * dt;
      var ds = Math.sqrt((nx - d.x) * (nx - d.x) + (ny - d.y) * (ny - d.y));
      if (ds > 0) {
        var sn = clamp(d.vy / Math.max(1, d.maxV), 0, 1);
        var got = dropTrail(d.x, d.y, nx, ny, Math.max(1.0, d.r * (0.66 - 0.2 * sn)));
        /* 质量：在干玻璃上留水变小，在雾上滑会顺路收水 */
        var r2 = d.r * d.r * (1 - 0.0042 * ds / cssPx * 0.59) + got * 0.035;
        d.r = Math.sqrt(Math.max(0, r2));
        d.dist += ds;
        if (d.dist > d.nextBead) {
          d.nextBead = d.dist + d.r * (2.4 + Math.random() * 5.5);
          if (Math.random() < 0.55) {
            var br = d.r * (0.16 + Math.random() * 0.17);
            var b = spawnDrop(d.x + (Math.random() - 0.5) * d.r * 0.7, d.y - d.r * (0.9 + Math.random() * 0.4), br, false);
            if (b) d.r = Math.sqrt(Math.max(0, d.r * d.r - br * br * 0.8));
          }
        }
        if (d.dist > d.nextPin) {
          d.nextPin = d.dist + d.r * (3 + Math.random() * 10);
          /* 碰到玻璃上的小瑕疵：小珠会顿一下，大珠直接冲过去 */
          if (d.r < d.rc * 1.45 && Math.random() < 0.55) d.pause = 0.12 + Math.random() * (d.r < d.rc * 1.1 ? 1.4 : 0.5);
        }
      }
      d.x = nx; d.y = ny;
      if (d.r < d.rc * 0.6) { d.slide = false; d.grow = false; }
    }
    var bottom = aperture && aperture.type ? (aperture.y + aperture.h) * densityScale : dh;
    if (d.y - d.r > Math.min(dh, bottom + 2) || d.r < 0.32 * cssPx) drops.splice(i, 1);
  }
}

/* 合并：碰到就并成一颗（面积守恒略打折），并完更可能越过临界、立刻提速 */
function mergeDrops() {
  var i, j;
  for (i = 0; i < drops.length; i++) {
    var a = drops[i];
    if (a.dead) continue;
    for (j = 0; j < i; j++) {
      var b = drops[j];
      if (b.dead || (!a.slide && !b.slide && !a.grow && !b.grow)) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      var rr = (a.r + b.r) * (a.slide || b.slide ? 0.92 : 0.82);
      if (dx * dx + dy * dy >= rr * rr) continue;
      var big = a.r >= b.r ? a : b;
      var small = big === a ? b : a;
      var w = small.r * small.r / (big.r * big.r + small.r * small.r);
      big.x += (small.x - big.x) * w * (big.slide ? 0.3 : 1);
      big.y += (small.y - big.y) * w * (big.slide ? 0 : 1);
      big.r = Math.sqrt(big.r * big.r + small.r * small.r * 0.92);
      big.grow = true;
      if (big.slide) { big.vy += Math.max(small.vy, 0) * 0.3; big.pause = 0; }
      if (big.r >= big.rc) big.slide = true;
      small.dead = true;
    }
  }
  var k = 0;
  for (i = 0; i < drops.length; i++) if (!drops[i].dead) drops[k++] = drops[i];
  drops.length = k;
}

/* 成核点：每隔约 26 css px 一个（带抖动）。雾持续够厚，水才会在这里聚成珠 */
function buildSites() {
  sites = [];
  var sp = 26 * densityScale, cols = Math.ceil(dw / sp), rows = Math.ceil(dh / sp);
  for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
    var sx = (x + 0.15 + Math.random() * 0.7) * sp, sy = (y + 0.15 + Math.random() * 0.7) * sp;
    if (sx >= dw || sy >= dh) continue;
    sites.push({ x: sx, y: sy, i: (sy | 0) * dw + (sx | 0), acc: -Math.random() * 0.6, k: Math.random() < 0.58 ? 0 : 0.6 + Math.random() * 0.9, drop: null });
  }
}
function naturalSpawn(dt) {
  if (MELT[S.melt].hold) return;
  for (var n = 0; n < sites.length; n++) {
    var st = sites[n], F = fogF[st.i];
    if (st.drop && (st.drop.slide || drops.indexOf(st.drop) < 0)) st.drop = null;
    if (!st.k) continue;
    if (F > 0.42) st.acc += dt * (F - 0.42) * 0.85 * st.k;
    else if (st.acc > 0) st.acc -= dt * 0.08;
    if (st.acc >= 1 && !st.drop && drops.length < DROP_CAP - 30) {
      st.acc = -Math.random() * 0.5;
      var cx = st.x / densityScale, cy = st.y / densityScale;
      if (!MIST_WINDOWS.contains(aperture, cx, cy)) continue;
      st.drop = spawnDrop(st.x, st.y, (0.9 + Math.random() * 0.7) * densityScale, true);
    }
  }
}

/* 开场：干净的玻璃在一两秒里由下往上、一片片凝上水汽 */
function introFog(dt) {
  if (!goalF || MELT[S.melt].hold) return;
  introT += dt;
  var k = sstep(0.15, 1.4, introT) * dt * 1.6;
  for (var i = 0; i < flen; i++) {
    if (bareF[i] > 0.05) continue;
    var g = goalF[i], F = fogF[i];
    if (F < g) fogF[i] = F + (g - F) * Math.min(1, k * introK[i]);
  }
  if (introT > 5) { goalF = null; introK = null; }
}

/* 手指擦过：碰到的水珠被抹掉 */
function wipeDrops(x0, y0, x1, y1, R) {
  var dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  for (var i = drops.length - 1; i >= 0; i--) {
    var d = drops[i], t = L2 > 0 ? clamp(((d.x - x0) * dx + (d.y - y0) * dy) / L2, 0, 1) : 0;
    var ex = d.x - (x0 + dx * t), ey = d.y - (y0 + dy * t), lim = R * 0.95 + d.r * 0.3;
    if (ex * ex + ey * ey < lim * lim) drops.splice(i, 1);
  }
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
function newRainStreak(b, spread) {
  var depth = Math.random();
  return { x: b.x + Math.random() * b.w, y: b.y + (spread ? Math.random() * b.h : -22 * rainScale),
    speed: (220 + depth * 270) * rainScale, length: (11 + depth * 23) * rainScale,
    width: (0.5 + depth * 0.7) * rainScale, alpha: 0.22 + depth * 0.34 };
}
function primeWeather(mode) {
  if (!rainCanvas) return;
  var b = weatherBounds(), n = clamp(b.w * b.h / (rainScale * rainScale * 150000), 0.65, 1.8) * (qualityTier === 0 ? 1 : 0.7);
  if (mode === 'rain') {
    if (!rainStreaks.length) for (var i = 0; i < 60 * n; i++) rainStreaks.push(newRainStreak(b, true));
    if (!rainDrops.length) rainAcc = 14 * n;
  }
  if (mode === 'snow' && !snowFlakes.length) for (var j = 0; j < 72 * n; j++) spawnSnow(b, true);
}
function updateWeatherButton() {
  var names = { clear: '晴', rain: '雨', snow: '雪' };
  var paths = {
    clear: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4L19 5"></path>',
    rain: '<path d="M6 15a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9M7 18l-1 3m6-3-1 3m6-3-1 3"></path>',
    snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m10 14-1-4 4-1M4 14l4 1-1 4m10-14-1 4 4 1"></path>'
  };
  btnWeather.querySelector('svg').innerHTML = paths[S.weather];
  btnWeather.querySelector('span').textContent = names[S.weather];
  btnWeather.setAttribute('aria-label', '切换天气，当前：' + names[S.weather]);
  btnWeather.title = '当前：' + names[S.weather] + ' · 晴 / 雨 / 雪';
}
function setWeather(mode, level, name) {
  S.weather = mode;
  S.weatherLevel = clamp(level, 0, 1);
  S.weatherHold = 18; rainIntensityT = 0;
  rainTarget = S.weatherLevel;
  rainIntensity = S.weatherLevel;
  primeWeather(mode);
  updateWeatherButton();
  showLabel(name);
  hideHint();
}
function nextWeather() {
  // Predictable cycle: every activation gives a different, immediate result.
  var mode = S.weather === 'clear' ? 'rain' : S.weather === 'rain' ? 'snow' : 'clear';
  setWeather(mode, mode === 'clear' ? 0 : 0.68, mode === 'rain' ? '下雨了' : mode === 'snow' ? '下雪了' : '放晴');
}

function updateRain(dt) {
  if (!rainCanvas) return;
  var i, d, f, cap = qualityTier === 0 ? 70 : 45;
  var bounds = weatherBounds();
  primeWeather(S.weather);

  /* 天气强度：用户设定保持约 18 秒，之后恢复自然起伏 */
  if (S.weatherHold > 0) {
    S.weatherHold -= dt;
    rainTarget = S.weatherLevel;
    rainIntensity += (rainTarget - rainIntensity) * Math.min(1, dt * 0.9);
  } else {
    rainIntensityT -= dt;
    if (rainIntensityT <= 0) {
      rainIntensityT = 6 + Math.random() * 14;
      rainTarget = 0.30 + Math.random() * 0.70;
    }
    rainIntensity += (rainTarget - rainIntensity) * Math.min(1, dt * 0.25);
    S.weatherLevel = rainIntensity;
  }
  /* 风向缓慢摆动（雨丝与雪花都会被吹偏） */
  S.windT -= dt;
  if (S.windT <= 0) { S.windT = 4 + Math.random() * 8; S.windTarget = (Math.random() - 0.5) * 34; }
  S.wind += (S.windTarget - S.wind) * Math.min(1, dt * 0.4);
  /* 雨雪强度的视觉缓存（供着色器做空气透视） */
  S.rainAmt += ((S.weather === 'rain' ? rainIntensity : 0) - S.rainAmt) * (1 - Math.exp(-dt * 10));
  S.snowAmt += ((S.weather === 'snow' ? rainIntensity : 0) - S.snowAmt) * (1 - Math.exp(-dt * 10));

  if (S.weather !== 'rain' && S.rainAmt < 0.002) { rainStreaks.length = 0; rainDrops.length = 0; rainAcc = 0; rainTrailCtx.clearRect(0,0,rw,rh); }
  if (S.weather !== 'snow' && S.snowAmt < 0.002) { snowFlakes.length = 0; snowAcc = 0; }

  /* 生成：尺寸按幂律分布（小滴多、大滴少），雨越大平均雨滴越大 */
  var areaN = clamp(bounds.w * bounds.h / (rainScale * rainScale * 200000), 0.6, 1.8);
  rainAcc += dt * (S.weather === 'rain' ? (9 + 26 * rainIntensity) : 0) * areaN * (qualityTier === 0 ? 1 : 0.7);
  while (rainAcc >= 1) {
    rainAcc -= 1;
    if (rainDrops.length >= cap) break;
    var sz = 1.0 + Math.pow(Math.random(), 2.3) * (2.4 + 5.0 * rainIntensity);
    var rc = sz / rainScale;                       /* css px 半径 */
    var vf = 0.6 + Math.random() * 0.8;            /* 个体速度系数 */
    var cssV = 0.25 * rc * rc * vf;
    if (rc < 3) cssV = Math.min(cssV, 1.5 + Math.random() * 2.0);  /* 小滴几乎不动 */
    cssV = clamp(cssV, 0.4, 95);
    rainDrops.push({
      x: bounds.x + Math.random() * bounds.w,
      y: bounds.y + Math.random() * bounds.h,
      r: sz, vy: cssV * 0.1 / rainScale,
      maxV: cssV / rainScale, accel: 0.8 + Math.random() * 2.0, vf: vf,
      age: 0, life: 3 + Math.random() * 6, seed: Math.random(),
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
    streak.x += (S.wind * rainScale - streak.speed * 0.045) * dt;
    if (streak.y > bounds.y + bounds.h + streak.length || streak.x < bounds.x - 10) rainStreaks[i] = newRainStreak(bounds, false);
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
    d.maxV = clamp(0.25 * rcN * rcN * d.vf, 0.4, 95) / rainScale;
    var tgt = d.state ? d.maxV : d.maxV * 0.06;
    d.vy += (tgt - d.vy) * Math.min(1, dt * d.accel);
    var ox = d.x, oy = d.y;
    d.y += d.vy * dt;
    /* 风把雨丝吹斜 */
    d.x += (Math.sin(d.age * 1.4 + d.seed * 13.0) * d.vy * 0.06 + S.wind * 0.20) * dt;
    if (d.y - oy > 0.5 || Math.abs(d.x - ox) > 0.5) drawRainTrail(ox, oy, d.x, d.y, d.r);
    if (d.y > rh + d.r * 2 || d.age > d.life || d.r < 0.6 || d.r > 14) rainDrops.splice(i, 1);
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
    var a = 0.60 + 0.40 * Math.min(1, d.r / 5);
    var rr = d.r * 1.08;
    /* 滑动中的雨珠被拉成上窄下圆的泪滴，静止的是略扁的圆 */
    var sn = clamp(d.vy / Math.max(0.001, d.maxV), 0, 1) * (d.state ? 1 : 0.3);
    var st = 1 + 0.38 * sn * Math.min(1, d.r / (2.5 * rainScale + 0.5));
    var g = rainHeadCtx.createRadialGradient(0, 0, 0, 0, 0, rr);
    g.addColorStop(0, 'rgba(255,0,0,' + a + ')');
    g.addColorStop(0.55, 'rgba(255,0,0,' + (a * 0.88) + ')');
    g.addColorStop(1, 'rgba(255,0,0,0)');
    rainHeadCtx.fillStyle = g;
    rainHeadCtx.save();
    rainHeadCtx.translate(d.x, d.y - rr * (st - 1) * 0.55);
    rainHeadCtx.scale(1 / Math.sqrt(st), st * (d.state ? 1 : 0.94));
    rainHeadCtx.beginPath(); rainHeadCtx.arc(0, 0, rr, 0, Math.PI * 2); rainHeadCtx.fill();
    rainHeadCtx.restore();
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
    snowCtx.lineTo(sr.x + sr.length * 0.045, sr.y - sr.length); snowCtx.stroke();
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

/* 打包密度场：WebGL 直接上传数组（A = 残留水珠）；2D 模式写进画布（A = 雾，作合成蒙版） */
function writeFogCanvas() {
  var b = fogBuf, f = fogF, w = wetF, ba = bareF, r = resF, i, o;
  for (i = 0; i < flen; i++) {
    o = i << 2;
    b[o] = f[i] * 255;
    b[o + 1] = w[i] * 255;
    b[o + 2] = ba[i] * 255;
    b[o + 3] = useGL ? r[i] * 255 : (1 - Math.exp(-3.1 * f[i])) * 0.96 * 255;
  }
  if (!useGL) fogCtx.putImageData(fogImg, 0, 0);
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
'uniform sampler2D uBg0;',
'uniform sampler2D uBg1;',
'uniform sampler2D uBg2;',
'uniform sampler2D uGrain;',
'uniform sampler2D uRain;',
'uniform vec2 uRainTexel;',
'uniform vec2 uTexel;',
'uniform vec2 uBuf;',
'uniform float uDpr;',
'uniform float uTime;',
'uniform float uFlight;',
'uniform float uCloudTime;',
'uniform vec4 uAperture;',
'uniform vec3 uFogTint;',
'uniform float uRainAmt;',
'uniform float uSnowAmt;',
'const vec2 LDIR = vec2(-0.479, -0.878);',
'',
'float hash21(vec2 p) {',
'  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
'  p3 += dot(p3, p3.yzx + 33.33);',
'  return fract((p3.x + p3.y) * p3.z);',
'}',
'float cloudNoise(vec2 p) {',
'  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
'  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x),f.y);',
'}',
'float cloudField(vec2 p) {',
'  return cloudNoise(p)*.57 + cloudNoise(p*2.03+4.1)*.28 + cloudNoise(p*4.11+13.7)*.15;',
'}',
'/* Atlas: grain | glass (top), fine beads | coarse beads (bottom). */',
'vec4 atlas(vec2 p, vec2 o) {',
'  vec2 q = clamp(fract(p), vec2(0.0009766), vec2(0.9990234));',
'  return texture2D(uGrain, o + q * 0.5);',
'}',
'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
'',
'void main() {',
'  vec2 uv = vUv;',
'  vec2 local = (uv-uAperture.xy)/max(uAperture.zw,vec2(.001));',
'  vec2 css = uv * uBuf / uDpr;',
'  vec2 pxUv = uDpr / uBuf;',
'',
'  /* R 凝结水汽  G 湿痕  B 擦过的历史  A 残留水珠（比雾散得慢） */',
'  vec4 f = texture2D(uFog, uv);',
'  float fog = f.r, wet = f.g, res = f.a;',
'  float fl = texture2D(uFog, uv - vec2(uTexel.x, 0.0)).r;',
'  float fr = texture2D(uFog, uv + vec2(uTexel.x, 0.0)).r;',
'  float fu = texture2D(uFog, uv - vec2(0.0, uTexel.y)).r;',
'  float fd = texture2D(uFog, uv + vec2(0.0, uTexel.y)).r;',
'  vec2 fg = vec2(fr - fl, fd - fu) / (2.0 * uTexel);',
'',
'  vec4 rn = texture2D(uRain, uv);',
'  float rHead = rn.r, rTrail = rn.g, rSnow = rn.b;',
'  float rrl = texture2D(uRain, uv - vec2(uRainTexel.x, 0.0)).r;',
'  float rrr = texture2D(uRain, uv + vec2(uRainTexel.x, 0.0)).r;',
'  float rru = texture2D(uRain, uv - vec2(0.0, uRainTexel.y)).r;',
'  float rrd = texture2D(uRain, uv + vec2(0.0, uRainTexel.y)).r;',
'  vec2 rgrad = vec2(rrr - rrl, rrd - rru);',
'',
'  vec4 gi = atlas(css / 300.0, vec2(0.0));',
'  float hgt = gi.r;',
'  vec2 gn = (gi.gb - 0.5) * 2.0;',
'  float macro = atlas(css / 1500.0 + vec2(0.31, 0.57), vec2(0.0)).r;',
'  float d = clamp(fog * (0.96 + 0.08 * hgt) + (hgt - 0.5) * 0.05 * smoothstep(0.05, 0.4, fog), 0.0, 1.0);',
'',
'  /* 细密凝结珠：雾薄时碎成一粒粒，雾厚时连成乳白一片 */',
'  vec4 fb = atlas(css / 179.0, vec2(0.0, 0.5));',
'  vec2 fp = (fb.gb - 0.5) * 3.0;',
'  float fr2 = dot(fp, fp);',
'  float fIn = 1.0 - smoothstep(0.70, 1.0, fr2);',
'  float speck = fIn * smoothstep(fb.r - 0.06, fb.r + 0.04, d * 1.7);',
'  float sparse = 1.0 - smoothstep(0.10, 0.40, d);',
'',
'  /* 稍大的水珠：跟着残留水量出现，雾散以后还挂一阵 */',
'  vec4 cb = atlas(css / 236.0 + vec2(0.37, 0.11), vec2(0.5, 0.5));',
'  vec2 cp = (cb.gb - 0.5) * 3.0;',
'  float cr2 = dot(cp, cp);',
'  float cIn = 1.0 - smoothstep(0.72, 1.0, cr2);',
'  /* 雾厚时大珠藏在乳白里，只在雾薄、刚散开或笔画边上显出来 */',
'  float cv = cIn * smoothstep(cb.r - 0.05, cb.r + 0.03, res * 1.1) * (0.18 + 0.82 * (1.0 - smoothstep(0.12, 0.42, d)));',
'',
'  vec2 refr = clamp(fg * 0.00022, -0.008, 0.008);',
'  refr += gn * 0.0016 * d;',
'  vec2 buv = uv + refr;',
'  if (uFlight > .5) {',
'    float depth=smoothstep(.30,1.0,local.y);',
'    buv.x += sin(uCloudTime*.028)*(0.015+depth*.055)*uAperture.z;',
'    buv.y += sin(uCloudTime*.017+local.x)*.012*depth*uAperture.w;',
'  }',
'  vec3 s0 = texture2D(uBg0, buv).rgb;',
'  vec3 s1 = texture2D(uBg1, buv).rgb;',
'  vec3 s2 = texture2D(uBg2, buv).rgb;',
'  float b1 = smoothstep(0.03, 0.34, d);',
'  float b2 = smoothstep(0.12, 0.70, d);',
'  vec3 bg = mix(mix(s0, s1, b1), s2, b2);',
'',
'  if (uFlight > .5) {',
'    vec2 cpos=vec2(local.x*3.4+uCloudTime*.020,local.y*5.0);',
'    float cloud=cloudField(cpos);',
'    float above=cloudField(cpos+vec2(-.1,-.14));',
'    float veil=smoothstep(.44,.73,cloud)*smoothstep(.52,.96,local.y)*.22;',
'    vec3 cloudColor=vec3(.83,.88,.91)+(above-cloud)*.40;',
'    bg=mix(bg,cloudColor,veil*(1.0-.55*d));',
'  }',
'',
'  /* 窗外雨珠：小透镜，倒映出外面的景，边缘暗、顶上一点高光 */',
'  float rIn = smoothstep(0.05, 0.32, rHead);',
'  float rgl = length(rgrad);',
'  vec2 rdir = rgrad / max(rgl, 0.0001);',
'  float rp = clamp(1.0 - rHead * 1.15, 0.0, 1.0);',
'  vec3 rcol = texture2D(uBg0, buv + rdir * rp * 6.0 * pxUv).rgb;',
'  rcol *= 1.0 - 0.48 * smoothstep(0.40, 0.95, rp);',
'  rcol += vec3(0.96, 0.97, 1.0) * pow(max(0.0, dot(-rdir, LDIR)), 9.0) * smoothstep(0.25, 0.75, rp) * 0.50;',
'  rcol += rcol * pow(max(0.0, dot(rdir, LDIR)), 3.0) * smoothstep(0.15, 0.7, rp) * 0.22;',
'  bg = mix(bg, rcol, rIn * (1.0 - 0.75 * b2));',
'  bg += vec3(0.62, 0.70, 0.82) * rTrail * 0.06 * (1.0 - b2);',
'  float snowMix = uSnowAmt / max(0.001, uSnowAmt + uRainAmt);',
'  bg = mix(bg, mix(vec3(.50,.58,.66),vec3(.97,.98,1.0),snowMix), rSnow * mix(.62,.90,snowMix) * (1.0-.45*fog));',
'  bg = mix(bg, bg * vec3(0.90, 0.93, 0.98) + vec3(0.01, 0.016, 0.03), uRainAmt * 0.40);',
'  bg = mix(bg, bg * vec3(0.98, 1.0, 1.03) + vec3(0.025, 0.03, 0.04), uSnowAmt * 0.35);',
'',
'  /* 水汽：前向散射的乳白，保留窗外的色彩和亮处的光晕 */',
'  float L2 = luma(s2);',
'  vec3 diffuse = mix(s2, vec3(L2), 0.26);',
'  vec3 room = mix(uFogTint, vec3(1.0), 0.45);',
'  vec3 milky = diffuse * 0.76 + room * (0.17 + 0.18 * L2);',
'  milky += max(s2 - 0.55, vec3(0.0)) * 0.42;',
'  milky *= (0.985 + 0.03 * hgt) * (1.0 - 0.06 * uRainAmt);',
'  milky += vec3(0.02, 0.024, 0.03) * uSnowAmt;',
'  milky -= max(milky - 0.80, vec3(0.0)) * 0.55;',
'  float op = (1.0 - exp(-3.1 * d * (1.04 - 0.12 * macro))) * 0.94;',
'  op *= mix(1.0, clamp(speck * 1.9, 0.0, 1.0), sparse);',
'  vec3 col = mix(bg, milky, op);',
'',
'  vec2 hp = LDIR * 0.42;',
'  float fHi = exp(-dot(fp - hp, fp - hp) * 16.0) * fIn;',
'  col += vec3(1.0) * fHi * speck * (0.03 + 0.05 * sparse);',
'  col -= col * smoothstep(0.45, 1.0, fr2) * fIn * speck * 0.16 * sparse;',
'',
'  vec3 bead = texture2D(uBg1, buv - cp * 2.6 * pxUv).rgb;',
'  bead *= 1.0 - 0.46 * smoothstep(0.35, 1.0, cr2);',
'  bead += vec3(1.0) * exp(-dot(cp - hp, cp - hp) * 14.0) * 0.24;',
'  bead += bead * exp(-dot(cp + hp * 0.7, cp + hp * 0.7) * 6.0) * 0.22;',
'  bead = mix(bead, milky * 1.03, smoothstep(0.15, 0.6, d) * 0.7);',
'  col = mix(col, bead, cv * 0.9);',
'',
'  /* 擦过的地方：玻璃微湿，堆起来的水脊略亮 */',
'  col *= 1.0 - 0.045 * wet * (1.0 - d);',
'  float edge = smoothstep(6.0, 60.0, length(fg));',
'  col = mix(col, milky * 1.06, edge * 0.08 * smoothstep(0.1, 0.5, d));',
'',
'  /* 干净玻璃：一道很淡的天光反射 + 双层玻璃的淡重影 */',
'  float rA = 1.0 - smoothstep(0.0, 0.14, abs((uv.x * 0.72 + uv.y * 0.70) - 0.82));',
'  col += vec3(0.75, 0.82, 0.92) * rA * rA * 0.022;',
'  vec3 ghost = texture2D(uBg1, buv + vec2(0.006, -0.004)).rgb;',
'  col += ghost * smoothstep(0.45, 0.95, luma(ghost)) * 0.035 * (1.0 - op);',
'',
'  float vig = smoothstep(0.55, 1.35, length((uv - 0.5) * vec2(1.4, 1.25)));',
'  col *= 1.0 - 0.10 * vig;',
'  col += (hash21(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0) - 0.5) * 0.008;',
'  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
'}'
].join('\n');

/* 内侧水珠：每颗一个小四边形，按真实屏幕分辨率画出泪滴形透镜 */
var DROP_VS = [
'attribute vec2 aCorner;',
'attribute vec4 aDrop;',
'attribute vec2 aDir;',
'uniform vec2 uCss;',
'varying vec2 vLocal;',
'varying vec2 vU;',
'varying vec2 vShape;',
'void main() {',
'  vec2 u = aDir, v = vec2(-u.y, u.x);',
'  float r = aDrop.z, T = aDrop.w;',
'  float a = aCorner.x > 0.0 ? r * 1.25 : -(r * 1.25 + T);',
'  float b = aCorner.y * r * 1.25;',
'  vec2 p = aDrop.xy + u * a + v * b;',
'  vLocal = vec2(a, b); vU = u; vShape = vec2(r, T);',
'  gl_Position = vec4(p.x / uCss.x * 2.0 - 1.0, 1.0 - p.y / uCss.y * 2.0, 0.0, 1.0);',
'}'
].join('\n');

var DROP_FS = [
'#ifdef GL_FRAGMENT_PRECISION_HIGH',
'precision highp float;',
'#else',
'precision mediump float;',
'#endif',
'uniform sampler2D uBg0;',
'uniform sampler2D uBg1;',
'uniform sampler2D uBg2;',
'uniform vec2 uBuf;',
'uniform vec2 uCss;',
'varying vec2 vLocal;',
'varying vec2 vU;',
'varying vec2 vShape;',
'const vec2 LDIR = vec2(-0.479, -0.878);',
'/* x = 归一化距离（1 = 边缘），y = 该处水珠高度（css px） */',
'vec2 shape(vec2 l) {',
'  float r = vShape.x, T = vShape.y, q, w = r;',
'  if (l.x >= 0.0 || T < 0.01) {',
'    q = length(vec2(l.x * (l.x > 0.0 ? 1.04 : 0.97), l.y)) / r;',
'  } else {',
'    float t = clamp(-l.x / T, 0.0, 1.0);',
'    w = r * (1.0 - 0.62 * pow(t, 0.85));',
'    q = -l.x <= T ? abs(l.y) / w : length(vec2(-l.x - T, l.y)) / w;',
'  }',
'  return vec2(q, 0.62 * w * sqrt(max(0.0, 1.0 - q * q)));',
'}',
'void main() {',
'  vec2 s = shape(vLocal);',
'  float r = vShape.x, dpr = uBuf.x / uCss.x;',
'  float aa = clamp(1.4 / (r * dpr), 0.03, 0.6);',
'  float cov = 1.0 - smoothstep(1.0 - aa, 1.0, s.x);',
'  if (cov <= 0.0) discard;',
'  float e = 0.35;',
'  float ga = (shape(vLocal + vec2(e, 0.0)).y - s.y) / e;',
'  float gb = (shape(vLocal + vec2(0.0, e)).y - s.y) / e;',
'  vec2 v = vec2(-vU.y, vU.x);',
'  vec2 g = vU * ga + v * gb;',
'  float glen = min(length(g), 3.0);',
'  vec2 gd = g / max(length(g), 0.0001);',
'  vec2 uv = vec2(gl_FragCoord.x / uBuf.x, 1.0 - gl_FragCoord.y / uBuf.y);',
'  /* 透镜：倒着映出窗外，越靠边越弯 */',
'  vec2 luv = uv + gd * glen * r * 0.55 / uCss;',
'  /* 小水珠只看得到一团柔和的亮光，大水珠才映得出清楚的倒影 */',
'  float sharp = smoothstep(1.8, 6.0, r);',
'  vec3 soft = texture2D(uBg2, luv).rgb;',
'  soft = soft * 0.82 + 0.12 + max(soft - 0.5, vec3(0.0)) * 0.3;',
'  vec3 col = mix(soft, mix(texture2D(uBg0, luv).rgb, texture2D(uBg1, luv).rgb, 0.25), sharp);',
'  float rim = smoothstep(0.60, 1.0, s.x);',
'  col *= 1.0 - (0.22 + 0.33 * sharp) * rim;',
'  col += vec3(0.05, 0.055, 0.06) * rim;',
'  vec2 off = (vU * vLocal.x + v * vLocal.y) / r;',
'  float spec = pow(max(0.0, dot(-gd, LDIR)), 14.0) * smoothstep(0.45, 0.85, s.x) * (1.0 - smoothstep(0.92, 1.0, s.x));',
'  float spot = exp(-dot(off - LDIR * 0.40, off - LDIR * 0.40) * 38.0);',
'  float caustic = exp(-dot(off + LDIR * 0.40, off + LDIR * 0.40) * 7.0) * (1.0 - rim);',
'  col += vec3(1.0) * (spec * 0.50 + spot * 0.75);',
'  col += (col + 0.08) * caustic * 0.30;',
'  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * cov, cov);',
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
/* 水珠图块（可平铺）：每个像素记下离它最近那颗珠子的相对位置和出现门槛。
   R = 门槛（雾/残留水量超过它才显出这颗珠子），GB = 相对珠心的位置 / 半径 / 1.5。
   大珠子门槛低：雾散时小珠先消失，大珠多挂一会儿。 */
function makeBeadTile(seed, cell, rMin, rMax) {
  var N = 512, cv = mkCanvas(N, N), c2 = cv.getContext('2d');
  var id = c2.createImageData(N, N), d = id.data, best = new Float32Array(N * N), rnd = rng32(seed);
  var i, x, y;
  for (i = 0; i < N * N; i++) { best[i] = 1.3; d[i * 4] = 0; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = 255; }
  var cells = N / cell;
  for (var cy = 0; cy < cells; cy++) for (var cx = 0; cx < cells; cx++) {
    if (rnd() < 0.28) continue;
    var sz = Math.pow(rnd(), 2.2);
    var r = rMin + (rMax - rMin) * sz;
    var bx = (cx + 0.5 + (rnd() - 0.5) * 0.62) * cell, by = (cy + 0.5 + (rnd() - 0.5) * 0.62) * cell;
    var th = clamp(0.10 + 0.82 * rnd() - 0.28 * sz, 0.04, 0.98);
    var ext = Math.ceil(r * 1.3) + 1;
    for (y = -ext; y <= ext; y++) for (x = -ext; x <= ext; x++) {
      var px = Math.floor(bx) + x, py = Math.floor(by) + y;
      var ox = (px + 0.5 - bx) / r, oy = (py + 0.5 - by) / r, q = Math.sqrt(ox * ox + oy * oy);
      var wx = ((px % N) + N) % N, wy = ((py % N) + N) % N, k = wy * N + wx;
      if (q >= best[k]) continue;
      best[k] = q;
      var o = k * 4;
      d[o] = th * 255;
      d[o + 1] = (0.5 + ox / 3) * 255;
      d[o + 2] = (0.5 + oy / 3) * 255;
    }
  }
  c2.putImageData(id, 0, 0);
  return cv;
}
var beadFine = null, beadCoarse = null;
function makeGrainAtlas() {
  if (!grainBase) grainBase = makeGrainCanvas();
  if (!beadFine) { beadFine = makeBeadTile(515, 8, 1.5, 2.4); beadCoarse = makeBeadTile(919, 16, 1.8, 4.6); }
  var atlas = mkCanvas(1024, 1024), c2 = atlas.getContext('2d');
  c2.drawImage(grainBase, 0, 0);
  c2.fillStyle = '#000'; c2.fillRect(512, 0, 512, 512);
  if (BG.glass) c2.drawImage(BG.glass, 512, 0, 512, 512);
  c2.drawImage(beadFine, 0, 512);
  c2.drawImage(beadCoarse, 512, 512);
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
  var vbo = quadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  U = {
    fog: gl.getUniformLocation(prog, 'uFog'),
    dpr: gl.getUniformLocation(prog, 'uDpr'),
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
  gl.uniform1i(U.bg0, 2);
  gl.uniform1i(U.bg1, 3);
  gl.uniform1i(U.bg2, 4);
  gl.uniform1i(U.grain, 5);
  gl.uniform1i(U.rain, 6);

  fogTex = gl.createTexture();
  grainTex = gl.createTexture();
  rainTex = gl.createTexture();
  /* 每个纹理必须绑定到着色器声明的纹理单元，否则采样为空 */
  gl.activeTexture(gl.TEXTURE5);
  texFromCanvas(grainTex, makeGrainAtlas(), false);
  gl.activeTexture(gl.TEXTURE0);

  if (!initDropProgram()) return false;
  glass.addEventListener('webglcontextlost', onContextLost, false);
  return true;
}

var quadVbo = null, dprog = null, DU = null, dropVbo = null, dropVerts = null;
function initDropProgram() {
  var vs = compileShader(gl.VERTEX_SHADER, DROP_VS);
  var fs = compileShader(gl.FRAGMENT_SHADER, DROP_FS);
  if (!vs || !fs) return false;
  dprog = gl.createProgram();
  gl.attachShader(dprog, vs); gl.attachShader(dprog, fs);
  gl.bindAttribLocation(dprog, 0, 'aCorner');
  gl.bindAttribLocation(dprog, 1, 'aDrop');
  gl.bindAttribLocation(dprog, 2, 'aDir');
  gl.linkProgram(dprog);
  if (!gl.getProgramParameter(dprog, gl.LINK_STATUS)) return false;
  gl.useProgram(dprog);
  DU = { css: gl.getUniformLocation(dprog, 'uCss'), buf: gl.getUniformLocation(dprog, 'uBuf') };
  gl.uniform1i(gl.getUniformLocation(dprog, 'uBg0'), 2);
  gl.uniform1i(gl.getUniformLocation(dprog, 'uBg1'), 3);
  gl.uniform1i(gl.getUniformLocation(dprog, 'uBg2'), 4);
  dropVbo = gl.createBuffer();
  dropVerts = new Float32Array(DROP_CAP * 6 * 8);
  gl.useProgram(prog);
  return true;
}

var CORNERS = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
function renderDrops() {
  var n = 0, i, k, v = dropVerts, inv = 1 / Math.max(0.02, densityScale);
  for (i = 0; i < drops.length && n < DROP_CAP; i++) {
    var d = drops[i], r = d.r * inv;
    if (r < 0.45) continue;
    var ux = 0, uy = 1, T = 0;
    if (d.slide) {
      var sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
      if (sp > 0.001) { ux = d.vx / sp; uy = d.vy / sp; }
      T = r * (0.25 + 2.1 * clamp(d.vy / Math.max(0.001, d.maxV), 0, 1)) * (0.6 + 0.4 * d.seed);
    }
    var cx = d.x * inv, cy = d.y * inv;
    for (k = 0; k < 6; k++) {
      var o = (n * 6 + k) * 8;
      v[o] = CORNERS[k * 2]; v[o + 1] = CORNERS[k * 2 + 1];
      v[o + 2] = cx; v[o + 3] = cy; v[o + 4] = r; v[o + 5] = T;
      v[o + 6] = ux; v[o + 7] = uy;
    }
    n++;
  }
  if (!n) return;
  gl.useProgram(dprog);
  gl.uniform2f(DU.css, S.cssW, S.cssH);
  gl.uniform2f(DU.buf, S.bufW, S.bufH);
  gl.bindBuffer(gl.ARRAY_BUFFER, dropVbo);
  gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, n * 48), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 8);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, n * 6);
  gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(prog);
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
      /* 照片基本保持原色，只收一点点饱和，不再整体发灰 */
      if (hasFilter(photoCtx)) photoCtx.filter = 'saturate(' + Math.min(1, Sc.saturation + 0.24).toFixed(2) + ')';
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
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  if (!fogU8 || fogU8.buffer !== fogBuf.buffer) fogU8 = new Uint8Array(fogBuf.buffer, fogBuf.byteOffset, fogBuf.length);
  if (!fogTexReady) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dw, dh, 0, gl.RGBA, gl.UNSIGNED_BYTE, fogU8);
    setTexParams(fogTex, false);
    fogTexReady = true;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, fogU8);
  }
}

/* ------------------------------------------------------------------ 渲染 */
var tmpC = null, tmpCtx = null;

function renderGL(t) {
  gl.viewport(0, 0, S.bufW, S.bufH);
  gl.useProgram(prog);
  gl.uniform1f(U.dpr, S.bufW / Math.max(1, S.cssW));
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
  renderDrops();
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
      tmpCtx.fillStyle = 'rgba(' + Math.round(tint[0]*240) + ',' + Math.round(tint[1]*240) + ',' + Math.round(tint[2]*240) + ',0.46)';
      tmpCtx.fillRect(0, 0, W, H);
    }
    tmpCtx.globalCompositeOperation = 'destination-in';
    tmpCtx.drawImage(fogCanvas, 0, 0, W, H);
    tmpCtx.globalCompositeOperation = 'source-over';
    c2.save(); c2.globalAlpha = 0.97; c2.drawImage(tmpC, 0, 0); c2.restore();
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
    var tail = d.slide ? R * (0.3 + 2.0 * clamp(d.vy / Math.max(0.001, d.maxV), 0, 1)) : 0;
    c2.save();
    c2.beginPath();
    c2.moveTo(px - R, py);
    c2.arc(px, py, R, Math.PI, 0, true);
    if (tail > 0.5) c2.quadraticCurveTo(px + R * 0.5, py - tail * 0.6, px, py - R - tail);
    if (tail > 0.5) c2.quadraticCurveTo(px - R * 0.5, py - tail * 0.6, px - R, py);
    else c2.arc(px, py, R, 0, Math.PI, true);
    c2.closePath();
    var g = c2.createLinearGradient(px, py - R - tail, px, py + R);
    g.addColorStop(0, 'rgba(40,50,60,0.10)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0.32)');
    c2.fillStyle = g; c2.fill();
    c2.strokeStyle = 'rgba(30,38,46,0.28)'; c2.lineWidth = Math.max(0.8, R * 0.18); c2.stroke();
    c2.fillStyle = 'rgba(255,255,255,0.85)';
    c2.beginPath(); c2.arc(px - R * 0.35, py - R * 0.4, Math.max(0.6, R * 0.18), 0, Math.PI * 2); c2.fill();
    c2.restore();
  }
}

function render(t) {
  if (useGL && gl && prog) renderGL(t);
  else renderFlat(t);
}

function capturePicture() {
  suspendInput();
  if (!BG.sharp) throw new Error('photo-not-ready');
  render(S.time);
  var canvas = mkCanvas(S.bufW, S.bufH), ctx = canvas.getContext('2d');
  ctx.drawImage(useGL ? glass : flat, 0, 0);
  ctx.scale(S.dpr, S.dpr);
  MIST_WINDOWS.snapshot(ctx);
  return canvas;
}

/* ================================================================ 呼吸源 */
function updateHoldCheck() {
  if (!S.down || S.tapMoved || S.mode === 'hold') return;
  if (!MIST_WINDOWS.contains(aperture, S.lastX * S.cssW, S.lastY * S.cssH)) return;
  /* 落指停留约 0.7 秒 → 哈气；随后拖动涂雾，松手后恢复写字 */
  if (S.time - S.lastMoveT > 0.68 && S.time - S.downT > 0.72) {
    /* 按住不动 → 在该区域呼气 */
    S.mode = 'hold';
    S.holdX = S.lastX * S.cssW;
    S.holdY = S.lastY * S.cssH;
    hideHint();
  }
}

function updateBreath(dt) {
  var holdT = (S.down && S.mode === 'hold') ? 1 : 0;
  var hk = Math.min(1, dt * (holdT ? 5 : 9));
  S.holdLevel += (holdT - S.holdLevel) * hk;

  var sk = Math.min(1, dt * (S.space ? 5.5 : 9));
  S.spaceLevel += ((S.space ? 1 : 0) - S.spaceLevel) * sk;
  var lvl = 0, src = null;
  if (S.holdLevel > lvl) { lvl = S.holdLevel; src = 'hold'; }
  if (S.spaceLevel > lvl) { lvl = S.spaceLevel; src = 'space'; }
  S.breathLevel = lvl;

  var tx = 0.5, ty = 0.46, rr = 0.16;
  if (src === 'hold') {
    tx = S.holdX / Math.max(1, S.cssW);
    ty = S.holdY / Math.max(1, S.cssH);
    rr = 0.13;
  } else if (src === 'space') {
    tx = S.lastPointer.x; ty = S.lastPointer.y; rr = 0.17;
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
  if (S.pointerType === 'touch') {
    // Match the writing area, not the finger's contact patch. Keep mouse input unchanged.
    var paneSize = aperture && aperture.type ? Math.min(aperture.w, aperture.h) : m;
    return clamp(paneSize * 0.023, 5, 8.5);
  }
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
      S.holdX = cx; S.holdY = cy;
      S.lastX = nx; S.lastY = ny; S.lastPointer.x = nx; S.lastPointer.y = ny;
      return;  /* Hold-and-drag paints condensation; a new gesture wipes it. */
    }

    if (fogF) {
      var R = brushRadius() * densityScale;
      var p = wipeSegment(S.lastX * dw, S.lastY * dh, nx * dw, ny * dh, R);
      wipeDrops(S.lastX * dw, S.lastY * dh, nx * dw, ny * dh, R);
      strokeDist += dist * densityScale;
      /* 被推到笔画下沿的水，过一会儿聚成水珠；横着写的笔画更容易挂珠 */
      if (p && strokeDist > R * 3.2) {
        strokeDist = 0;
        var horiz = Math.abs(dx) / Math.max(0.001, dist);
        var ex = p.x + (Math.random() - 0.5) * R * 0.6, ey = p.y + R * (1.0 + Math.random() * 0.15);
        if (Math.random() < 0.16 + 0.42 * horiz && fogAt(ex, ey + R * 0.3) > 0.28) {
          var sd = spawnDrop(ex, ey, dropCritical() * (0.62 + 0.46 * Math.random()), true);
          if (sd) sd.gk *= 2.2;
        }
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
    if (el.id === 'controls' || el.id === 'shadeHandle' || el.id === 'dock' || el.id === 'btnScene' ||
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
      S.hoverGlass = !targetInDock(e.target);
      if (e.pointerType) S.pointerType = e.pointerType;
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
      S.hoverGlass = false;
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
    if (window.MIST_SAVE && MIST_SAVE.isOpen()) return;
    var k = e.key || e.code;
    var isSpace = (k === ' ' || k === 'Spacebar' || k === 'Space');
    if (isSpace) {
      var tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!S.space) { S.space = true; hideHint(); }
      if (e.preventDefault) e.preventDefault();
      return;
    }
    if (k === 'c' || k === 'C') nextScene();
  }, false);
  window.addEventListener('keyup', function (e) {
    var k = e.key || e.code;
    if (k === ' ' || k === 'Spacebar' || k === 'Space') {
      S.space = false;
      var tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.preventDefault) e.preventDefault();
    }
  }, false);
  window.addEventListener('blur', function () {
    S.space = false;
    S.pointerId = null;
    fakePointerUp(true);
  }, false);
}

function suspendInput() { S.space = false; S.pointerId = null; fakePointerUp(true); }
document.addEventListener('visibilitychange', function () { if (document.hidden) suspendInput(); });
window.addEventListener('pagehide', suspendInput);

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

function clearLabel() {
  if (labelTimer) clearTimeout(labelTimer);
  labelTimer = null; labelEl.textContent = ''; labelEl.style.opacity = '0';
}

function selectScene(index) {
  S.sceneIndex = index;
  S.customImg = null;
  loadScene(index);
  buildBackground();
  clearLabel();
  loadScene((index + 1) % SCENES.length);
  hideHint();
}
function nextScene() { selectScene((S.sceneIndex + 1) % SCENES.length); }

function nextWindow() {
  suspendInput();
  S.windowStyle = S.windowStyle === 4 ? 2 : S.windowStyle === 2 ? 0 : 4;
  fakePointerUp(true);
  syncFrame();
  setupRain();
  primeWeather(S.weather);
  buildBackground();
  showLabel(S.windowStyle === 4 ? '飞机舷窗' : S.windowStyle === 2 ? '火车窗' : '无框玻璃');
}

/* ---------------------------------------------------------------- 手势反馈 */
var ringShown = -1, ringBurst = 0, wasHold = false, writingOn = false, cursorOn = false, cursorKey = '';
var finePointer = !!(window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches);
function updateGestureUI(dt) {
  var hold = S.down && S.mode === 'hold';
  if (hold && !wasHold) ringBurst = 1;
  wasHold = hold;
  var p = 0, scale = 1, op = 0;
  if (S.down && !S.tapMoved && S.mode !== 'hold' && MIST_WINDOWS.contains(aperture, S.lastX * S.cssW, S.lastY * S.cssH)) {
    p = clamp((S.time - S.downT - 0.22) / 0.50, 0, 1);
    scale = 1.35 - 0.6 * p; op = p * 0.85;
  }
  if (ringBurst > 0) {
    ringBurst = Math.max(0, ringBurst - dt * 2.2);
    scale = 0.75 + (1 - ringBurst) * 0.9; op = ringBurst * 0.7;
  }
  var key = op < 0.01 ? 0 : op.toFixed(3) + scale.toFixed(3) + S.lastX.toFixed(4) + S.lastY.toFixed(4);
  if (key !== ringShown) {
    ringShown = key;
    ringEl.style.opacity = op < 0.01 ? '0' : op.toFixed(3);
    if (op >= 0.01) ringEl.style.transform = 'translate3d(' + (S.lastX * S.cssW).toFixed(1) + 'px,' + (S.lastY * S.cssH).toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
  }
  var writing = S.down && S.tapMoved;
  if (writing !== writingOn) { writingOn = writing; document.body.classList.toggle('writing', writing); }
  /* 桌面：鼠标在玻璃上时显示笔刷大小 */
  var lx = S.lastPointer.x * S.cssW, ly = S.lastPointer.y * S.cssH;
  var showCursor = finePointer && S.pointerType === 'mouse' && S.hoverGlass && MIST_WINDOWS.contains(aperture, lx, ly) && !MIST_WINDOWS.state().dragging;
  if (showCursor !== cursorOn) { cursorOn = showCursor; cursorEl.style.opacity = showCursor ? '1' : '0'; document.body.classList.toggle('cursor-glass', showCursor); }
  if (showCursor) {
    var r = brushRadius(), ck = lx.toFixed(1) + ',' + ly.toFixed(1) + ',' + r;
    if (ck !== cursorKey) {
      cursorKey = ck;
      cursorEl.style.width = cursorEl.style.height = (r * 2) + 'px';
      cursorEl.style.transform = 'translate3d(' + (lx - r).toFixed(1) + 'px,' + (ly - r).toFixed(1) + 'px,0)' + (S.mode === 'hold' && S.down ? ' scale(1.6)' : '');
    }
  }
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
      inputMode: S.mode, down: S.down, breath: S.breathLevel, fog: fogSum / Math.max(1, flen),
      centerFog: fogF ? fogF[centre] : 0, grid: [dw, dh], dpr: S.dpr, drops: drops.length,
      aperture: aperture ? [aperture.x, aperture.y, aperture.w, aperture.h] : null,
      shade: MIST_WINDOWS.state(), flight: flightScene(), samplers: useGL ? 7 : 0, error: window.__dbgErr, look: originalLook ? 'original' : softMist ? 'soft-mist' : 'previous',
      sliding: drops.filter(function (d) { return d.slide; }).length, maxDropCss: drops.reduce(function (m, d) { return Math.max(m, d.r / densityScale); }, 0), residual: (function () { var t = 0; for (var i = 0; i < flen; i += 7) t += resF[i]; return t / Math.ceil(flen / 7); })() };
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
    updateGestureUI(dt);

    var m = MELT[S.melt] || MELT[1];
    if (fogF) {
      introFog(dt);
      applyBreath(dt, f);
      updateDrops(dt);
      mergeDrops();
      naturalSpawn(dt);
      fogSum = relaxFog(f * MELT_TIME, m);
      diffuseFog(0.030 * m.df, f * MELT_TIME);
      writeFogCanvas();
      uploadSimTextures();
    }
    updateRain(dt);
    uploadRainTexture();
    render(S.time);
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
  hintEl.innerHTML='长按涂雾 · 划过写字<b>'+(S.windowStyle===4?'上方把手可开合遮光板':'松手后，再划就能擦开雾气')+'</b>';
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
  suspendInput();
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
  ringEl = document.getElementById('ring');
  cursorEl = document.getElementById('cursor');
  btnSave = document.getElementById('btnSave');
  btnMelt = document.getElementById('btnMelt');
  btnScene = document.getElementById('btnScene');
  btnWeather = document.getElementById('btnWeather');
  btnWindow = document.getElementById('btnWindow');
  btnUpload = document.getElementById('btnUpload');
  fileEl = document.getElementById('file');
}

function bindButtons() {
  MIST_SAVE.bind(btnSave, capturePicture, showToast);

  btnScene.addEventListener('click', function () { nextScene(); this.blur(); });
  updateWeatherButton();
  btnWeather.addEventListener('click', function () { nextWeather(); if (this.blur) this.blur(); }, false);
  btnWindow.addEventListener('click', function () { nextWindow(); if (this.blur) this.blur(); }, false);
  btnMelt.addEventListener('click', function () {
    S.melt = (S.melt + 1) % MELT.length;
    var text = ['慢', '中', '快', '不融化'][S.melt];
    btnMelt.querySelector('span').textContent = MELT[S.melt].hold ? text : '消散·' + text;
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
          clearLabel();
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

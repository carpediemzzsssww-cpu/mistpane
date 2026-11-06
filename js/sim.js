/*
 * 水汽场模拟（CPU，低分辨率网格）
 *
 * 每个格子存四样东西：
 *   Hm  玻璃表面的湿度（呼气带来，扩散、上浮、衰减回环境值）
 *   D   凝结水量（0..Dmax）；湿度超过阈值就凝结、加厚，低于阈值从薄处先蒸发
 *   Wf  擦过之后残留的水膜 / 被手指推到边上的水脊，几秒内干掉
 *   G   指纹油脂；几分钟才散。再哈气时这里凝结得不一样 → 字迹「鬼影」
 *   A   最近一次擦拭的方向（用于渲染顺着笔画的细水纹）
 *
 * 渲染层每帧把这些打包成一张 RGBA 贴图交给 shader。
 */
(function () {
  'use strict';
  var FG = (window.FG = window.FG || {});

  function rng(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  FG.rng = rng;

  // 可平铺的分形值噪声，输出 0..1
  function noiseMap(w, h, cell, octaves, seed) {
    var rnd = rng(seed);
    var out = new Float32Array(w * h);
    var amp = 1;
    for (var o = 0; o < octaves; o++) {
      var cw = Math.max(1, Math.round(w / cell));
      var ch = Math.max(1, Math.round(h / cell));
      var lat = new Float32Array(cw * ch);
      var i;
      for (i = 0; i < lat.length; i++) lat[i] = rnd();
      for (var y = 0; y < h; y++) {
        var fy = (y / h) * ch;
        var y0 = Math.floor(fy);
        var ty = fy - y0;
        ty = ty * ty * (3 - 2 * ty);
        var y1 = (y0 + 1) % ch;
        y0 = y0 % ch;
        for (var x = 0; x < w; x++) {
          var fx = (x / w) * cw;
          var x0 = Math.floor(fx);
          var tx = fx - x0;
          tx = tx * tx * (3 - 2 * tx);
          var x1 = (x0 + 1) % cw;
          x0 = x0 % cw;
          var a = lat[y0 * cw + x0];
          var b = lat[y0 * cw + x1];
          var c = lat[y1 * cw + x0];
          var d = lat[y1 * cw + x1];
          var top = a + (b - a) * tx;
          var bot = c + (d - c) * tx;
          out[y * w + x] += amp * (top + (bot - top) * ty);
        }
      }
      amp *= 0.5;
      cell *= 0.5;
      if (cell < 1) break;
    }
    var mn = 1e9;
    var mx = -1e9;
    for (var k = 0; k < out.length; k++) {
      if (out[k] < mn) mn = out[k];
      if (out[k] > mx) mx = out[k];
    }
    var r = mx - mn || 1;
    for (k = 0; k < out.length; k++) out[k] = (out[k] - mn) / r;
    return out;
  }
  FG.noiseMap = noiseMap;

  function smooth01(t) {
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }

  function Sim() {
    this.gw = 0;
    this.gh = 0;
    this.time = 0;
    this.sources = {};
    this.ambient = 0.8;
    this.totalD = 0;
    this.params = {
      hc: 0.22, // 凝结阈值（湿度）
      kc: 1.05, // 凝结速度
      capGain: 2.4, // 湿度 → 可凝结的最大厚度
      Dmax: 1.6,
      ke: 0.095, // 蒸发速度
      hDecay: 0.55, // 湿度回落（半衰期约 1.3 秒）
      hDiff: 2.2, // 湿度扩散
      hRise: 1.4, // 暖湿空气往上飘
      wDecay: 0.34, // 水膜干燥
      gDecay: 0.0035 // 油脂（几分钟）
    };
  }

  Sim.prototype.resize = function (W, H) {
    var cs = Math.max(3, Math.sqrt((W * H) / 85000));
    var gw = Math.max(16, Math.round(W / cs));
    var gh = Math.max(16, Math.round(H / cs));
    var old = this.gw
      ? { gw: this.gw, gh: this.gh, Hm: this.Hm, D: this.D, Wf: this.Wf, G: this.G, A: this.A }
      : null;
    this.W = W;
    this.H = H;
    this.gw = gw;
    this.gh = gh;
    this.csx = W / gw;
    this.csy = H / gh;
    this.cs = (this.csx + this.csy) / 2;
    var n = gw * gh;
    this.Hm = new Float32Array(n);
    this.D = new Float32Array(n);
    this.Wf = new Float32Array(n);
    this.G = new Float32Array(n);
    this.A = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.bytes = new Uint8Array(n * 4);

    // 成核不均匀：有的地方先起雾、起得厚；蒸发也不均匀
    this.nuc = noiseMap(gw, gh, Math.max(4, 70 / this.cs), 4, 11);
    this.ev = noiseMap(gw, gh, Math.max(4, 110 / this.cs), 3, 23);
    for (var i = 0; i < n; i++) {
      this.nuc[i] = 0.45 + this.nuc[i] * 1.1;
      this.ev[i] = 0.6 + this.ev[i] * 0.8;
    }
    if (!this.turb) this.turb = noiseMap(128, 128, 22, 3, 37);
    this.amb = new Float32Array(n);
    this.buildAmbient();

    if (old) {
      for (var y = 0; y < gh; y++) {
        var oy = Math.min(old.gh - 1, Math.floor(((y + 0.5) / gh) * old.gh));
        for (var x = 0; x < gw; x++) {
          var ox = Math.min(old.gw - 1, Math.floor(((x + 0.5) / gw) * old.gw));
          var oi = oy * old.gw + ox;
          var j = y * gw + x;
          this.Hm[j] = old.Hm[oi];
          this.D[j] = old.D[oi];
          this.Wf[j] = old.Wf[oi];
          this.G[j] = old.G[oi];
          this.A[j] = old.A[oi];
        }
      }
    } else {
      this.seedAmbient();
    }
  };

  // 冷玻璃的边角和底部常年有一层薄雾：环境湿度图
  Sim.prototype.buildAmbient = function () {
    var gw = this.gw;
    var gh = this.gh;
    var aspect = this.W / this.H;
    var nz = noiseMap(gw, gh, Math.max(4, 50 / this.cs), 3, 51);
    for (var y = 0; y < gh; y++) {
      var v = (y + 0.5) / gh;
      for (var x = 0; x < gw; x++) {
        var u = (x + 0.5) / gw;
        var i = y * gw + x;
        var bottom = Math.pow(smooth01((v - 0.8) / 0.2), 1.4);
        var e = Math.min(u * aspect, (1 - u) * aspect, v, 1 - v);
        var rim = 1 - smooth01(e / 0.06);
        var cxn = u < 0.5 ? 0 : 1;
        var dc = Math.sqrt(Math.pow((u - cxn) * aspect, 2) + Math.pow(v - 1, 2));
        var corner = Math.max(0, 1 - dc / 0.42);
        corner *= corner;
        var f = Math.min(1, bottom * 0.95 + rim * 0.55 + corner * 0.75);
        f *= 0.55 + 0.9 * nz[i];
        this.amb[i] = Math.min(0.62, f * 0.5) * this.ambient;
      }
    }
  };

  Sim.prototype.setAmbient = function (a) {
    this.ambient = a;
    if (this.gw) this.buildAmbient();
  };

  // 开窗时边角的薄雾已经在那儿了，不用等它慢慢长出来
  Sim.prototype.seedAmbient = function () {
    var P = this.params;
    for (var i = 0; i < this.amb.length; i++) {
      this.Hm[i] = this.amb[i];
      var cap = (this.amb[i] - P.hc) * P.capGain;
      if (cap > this.D[i]) this.D[i] = cap * (0.7 + 0.3 * this.nuc[i] / 1.55);
    }
  };

  // 呼气源：位置 + 强度 0..1。同一个 id 每帧更新即可，强度 0 时自动淘汰
  Sim.prototype.setSource = function (id, x, y, strength, R0) {
    var s = this.sources[id];
    if (!s) {
      if (strength <= 0) return;
      s = this.sources[id] = { x: x, y: y, strength: 0, age: 0, R0: R0, phase: Math.random() * 100 };
    }
    s.x = x;
    s.y = y;
    s.strength = strength;
    if (R0) s.R0 = R0;
  };
  Sim.prototype.endSource = function (id) {
    delete this.sources[id];
  };

  Sim.prototype.depositSource = function (src, dt) {
    var s = src.strength;
    if (s <= 0.002) return;
    src.age += dt;
    var t = this.time;
    var ph = src.phase;
    var grow = Math.min(1, src.age / 1.8);
    var R = src.R0 * (0.5 + 0.5 * grow) * (0.8 + 0.3 * s);
    var cx = src.x + Math.sin(t * 0.7 + ph) * R * 0.05;
    var cy = src.y + Math.cos(t * 0.53 + ph * 1.3) * R * 0.04 - R * 0.06 * grow;
    var csx = this.csx;
    var csy = this.csy;
    var gw = this.gw;
    var gh = this.gh;
    var ext = R * 1.75;
    var x0 = Math.max(0, Math.floor((cx - ext) / csx));
    var x1 = Math.min(gw - 1, Math.ceil((cx + ext) / csx));
    var y0 = Math.max(0, Math.floor((cy - ext) / csy));
    var y1 = Math.min(gh - 1, Math.ceil((cy + ext) / csy));
    var Hm = this.Hm;
    var nuc = this.nuc;
    var turb = this.turb;
    var relax = Math.min(1, 5 * dt);
    var sc1 = t * 9;
    var sc2 = t * 6;
    for (var y = y0; y <= y1; y++) {
      var py = (y + 0.5) * csy - cy;
      for (var x = x0; x <= x1; x++) {
        var px = (x + 0.5) * csx - cx;
        var ang = Math.atan2(py, px);
        var rr =
          R *
          (1 +
            0.16 * Math.sin(3 * ang + ph + t * 0.6) +
            0.09 * Math.sin(5 * ang + ph * 2.1 - t * 0.9) +
            0.05 * Math.sin(9 * ang + ph * 3.7 + t * 1.7));
        var q = (px * px + py * py) / (rr * rr);
        if (q > 3) continue;
        // 气流的湍动：两层反向流动的噪声
        var wx = (x + 0.5) * csx;
        var wy = (y + 0.5) * csy;
        var ta = turb[(((wy / 7 + sc1) | 0) & 127) * 128 + (((wx / 7) | 0) & 127)];
        var tb = turb[(((wy / 11) | 0) & 127) * 128 + (((wx / 11 - sc2) | 0) & 127)];
        var i = y * gw + x;
        var shape = Math.exp(-q * 1.25) * (0.55 + 0.5 * ta + 0.35 * tb) * (0.75 + 0.25 * nuc[i]);
        var target = 1.32 * s * shape;
        if (target > Hm[i]) Hm[i] += (target - Hm[i]) * relax;
      }
    }
  };

  Sim.prototype.step = function (dt) {
    var P = this.params;
    var gw = this.gw;
    var gh = this.gh;
    var n = gw * gh;
    this.time += dt;
    for (var k in this.sources) this.depositSource(this.sources[k], dt);

    // 湿度：扩散 + 上浮 + 回落到环境值
    var Hm = this.Hm;
    var tmp = this.tmp;
    var amb = this.amb;
    var c = Math.min(0.24, P.hDiff * dt);
    var rise = Math.min(0.5, P.hRise * dt);
    var decay = Math.min(1, P.hDecay * dt);
    var x;
    var y;
    var i;
    for (y = 0; y < gh; y++) {
      var row = y * gw;
      for (x = 0; x < gw; x++) {
        i = row + x;
        var h = Hm[i];
        var il = x > 0 ? i - 1 : i;
        var ir = x < gw - 1 ? i + 1 : i;
        var iu = y > 0 ? i - gw : i;
        var id = y < gh - 1 ? i + gw : i;
        var hv = h + c * (Hm[il] + Hm[ir] + Hm[iu] + Hm[id] - 4 * h) + rise * (Hm[id] - h);
        hv += (amb[i] - hv) * decay;
        tmp[i] = hv;
      }
    }
    this.Hm = tmp;
    this.tmp = Hm;
    Hm = this.Hm;

    // 凝结 / 蒸发
    var D = this.D;
    var Wf = this.Wf;
    var G = this.G;
    var nuc = this.nuc;
    var ev = this.ev;
    var hc = P.hc;
    var wdec = Math.exp(-P.wDecay * dt);
    var gdec = Math.exp(-P.gDecay * dt);
    var sum = 0;
    for (i = 0; i < n; i++) {
      var hh = Hm[i];
      var d = D[i];
      var cap = (hh - hc) * P.capGain;
      if (cap > P.Dmax) cap = P.Dmax;
      if (hh > hc && d < cap) {
        var ex = hh - hc;
        d += P.kc * ex * Math.sqrt(ex) * nuc[i] * (1 - d / cap) * dt;
      } else if (d > 0 && d > cap) {
        var thin = 1 - (d < 1 ? d : 1);
        var e = P.ke * ev[i] * (0.55 + 2.0 * thin * thin);
        if (hh > 0) e *= Math.max(0.15, 1 - (hh / hc) * 0.85);
        d -= e * dt;
        var floor = cap > 0 ? cap : 0;
        if (d < floor) d = floor;
      }
      D[i] = d;
      sum += d;
      Wf[i] *= wdec;
      G[i] *= gdec;
    }
    this.totalD = sum / n;
  };

  // 手指擦一下：中心擦净，边缘推起一道水脊，留下水膜和油脂。返回擦掉的水量
  Sim.prototype.stamp = function (cx, cy, r, ang, strength) {
    var csx = this.csx;
    var csy = this.csy;
    var gw = this.gw;
    var gh = this.gh;
    var D = this.D;
    var Wf = this.Wf;
    var G = this.G;
    var A = this.A;
    var Dmax = this.params.Dmax;
    var ext = r * 1.45;
    var x0 = Math.max(0, Math.floor((cx - ext) / csx));
    var x1 = Math.min(gw - 1, Math.ceil((cx + ext) / csx));
    var y0 = Math.max(0, Math.floor((cy - ext) / csy));
    var y1 = Math.min(gh - 1, Math.ceil((cy + ext) / csy));
    var a = ang % Math.PI;
    if (a < 0) a += Math.PI;
    var av = a / Math.PI;
    var removed = 0;
    for (var y = y0; y <= y1; y++) {
      var dy = (y + 0.5) * csy - cy;
      for (var x = x0; x <= x1; x++) {
        var dx = (x + 0.5) * csx - cx;
        var d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d > 1.45) continue;
        var i = y * gw + x;
        var core = d < 0.62 ? 1 : d < 1 ? 1 - smooth01((d - 0.62) / 0.38) : 0;
        if (core > 0) {
          var before = D[i];
          var take = before * core * strength;
          D[i] = before - take;
          removed += take;
          var film = core * Math.min(1, 0.08 + before * 0.75 + Wf[i] * 0.5);
          if (film > Wf[i]) Wf[i] = film;
          var g = core * 0.9;
          if (g > G[i]) G[i] = g;
          if (core > 0.35) A[i] = av;
        }
        var rg = (d - 1.05) / 0.17;
        var ring = Math.exp(-rg * rg);
        if (ring > 0.04) {
          var dd = D[i];
          Wf[i] = Math.min(1, Wf[i] + ring * 0.22 * Math.min(1, dd));
          D[i] = Math.min(Dmax, dd + ring * 0.05 * dd);
        }
      }
    }
    return removed * csx * csy;
  };

  // 水珠滑过：把路径上的雾吸掉
  Sim.prototype.clearDisk = function (cx, cy, r, amount, film) {
    var csx = this.csx;
    var csy = this.csy;
    var gw = this.gw;
    var gh = this.gh;
    var D = this.D;
    var Wf = this.Wf;
    var rr = Math.max(r, this.cs * 0.6);
    var x0 = Math.max(0, Math.floor((cx - rr) / csx));
    var x1 = Math.min(gw - 1, Math.floor((cx + rr) / csx));
    var y0 = Math.max(0, Math.floor((cy - rr) / csy));
    var y1 = Math.min(gh - 1, Math.floor((cy + rr) / csy));
    var removed = 0;
    for (var y = y0; y <= y1; y++) {
      var dy = (y + 0.5) * csy - cy;
      for (var x = x0; x <= x1; x++) {
        var dx = (x + 0.5) * csx - cx;
        var d = Math.sqrt(dx * dx + dy * dy) / rr;
        if (d >= 1) continue;
        var i = y * gw + x;
        var core = 1 - d * d;
        var take = D[i] * core * amount;
        D[i] -= take;
        removed += take;
        if (film) {
          var f = core * film;
          if (f > Wf[i]) Wf[i] = f;
        }
      }
    }
    return removed * csx * csy;
  };

  Sim.prototype.sample = function (arr, x, y) {
    var gx = Math.floor(x / this.csx);
    var gy = Math.floor(y / this.csy);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return 0;
    return arr[gy * this.gw + gx];
  };

  Sim.prototype.clearAll = function () {
    this.D.fill(0);
    this.Wf.fill(0);
    this.G.fill(0);
    for (var i = 0; i < this.Hm.length; i++) this.Hm[i] = this.amb[i];
  };

  // 打包成 RGBA8：R = 水量/1.5，G = 水膜，B = 油脂，A = 擦拭方向
  Sim.prototype.pack = function () {
    var b = this.bytes;
    var D = this.D;
    var Wf = this.Wf;
    var G = this.G;
    var A = this.A;
    var n = D.length;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var d = D[i] * 170;
      b[j] = d > 255 ? 255 : d;
      b[j + 1] = Wf[i] * 255;
      b[j + 2] = G[i] * 255;
      b[j + 3] = A[i] * 255;
    }
    return b;
  };

  FG.Sim = Sim;
})();

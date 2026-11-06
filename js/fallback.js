/*
 * WebGL 不可用时的 Canvas2D 兜底：照片 + 模糊副本按水汽场做遮罩，水珠画成小圆点。
 * 玩法完全一样，只是没有颗粒、折射和散射。
 */
(function () {
  'use strict';
  var FG = (window.FG = window.FG || {});

  function Fallback2D(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('no 2d');
    this.bg = document.createElement('canvas');
    this.fog = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    this.img = null;
  }

  Fallback2D.prototype.resize = function (cw, ch, W, H, dpr) {
    this.cw = cw;
    this.ch = ch;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.bg.width = this.fog.width = cw;
    this.bg.height = this.fog.height = ch;
    if (this.img) this.setImage(this.img, true);
  };

  Fallback2D.prototype.setImage = function (img) {
    this.img = img;
    var cw = this.cw;
    var ch = this.ch;
    if (!cw) return;
    var ia = img.width / img.height;
    var sa = cw / ch;
    var sw;
    var sh;
    var sx;
    var sy;
    if (ia > sa) {
      sh = img.height;
      sw = sh * sa;
      sx = (img.width - sw) * (img.focus ? img.focus[0] : 0.5);
      sy = 0;
    } else {
      sw = img.width;
      sh = sw / sa;
      sx = 0;
      sy = (img.height - sh) * (img.focus ? img.focus[1] : 0.5);
    }
    var b = this.bg.getContext('2d');
    b.drawImage(img.source, sx, sy, sw, sh, 0, 0, cw, ch);
    // 逐级缩小再逐级放大：近似高斯模糊，又不会出现双线性放大的方块感
    var src = this.bg;
    var chain = [];
    var w = cw;
    var h = ch;
    for (var i = 0; i < 4; i++) {
      w = Math.max(4, Math.round(w / 2.5));
      h = Math.max(4, Math.round(h / 2.5));
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      chain.push(c);
      src = c;
    }
    for (i = chain.length - 2; i >= 0; i--) {
      var up = chain[i].getContext('2d');
      up.drawImage(src, 0, 0, chain[i].width, chain[i].height);
      src = chain[i];
    }
    this.blurred = document.createElement('canvas');
    this.blurred.width = cw;
    this.blurred.height = ch;
    var bl = this.blurred.getContext('2d');
    bl.imageSmoothingEnabled = true;
    bl.drawImage(src, 0, 0, cw, ch);
    bl.fillStyle = 'rgba(215,222,228,0.28)';
    bl.fillRect(0, 0, cw, ch);
  };

  Fallback2D.prototype.render = function (dt, look, drops, sim) {
    var ctx = this.ctx;
    var cw = this.cw;
    var ch = this.ch;
    if (!this.blurred) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      return;
    }
    var m = this.mask;
    if (m.width !== sim.gw || m.height !== sim.gh) {
      m.width = sim.gw;
      m.height = sim.gh;
      this.maskData = m.getContext('2d').createImageData(sim.gw, sim.gh);
    }
    var md = this.maskData.data;
    var D = sim.D;
    for (var i = 0, j = 0; i < D.length; i++, j += 4) {
      md[j] = md[j + 1] = md[j + 2] = 255;
      var a = D[i] * 1.6;
      md[j + 3] = a > 1 ? 255 : a * 255;
    }
    m.getContext('2d').putImageData(this.maskData, 0, 0);
    var f = this.fog.getContext('2d');
    f.globalCompositeOperation = 'copy';
    f.drawImage(this.blurred, 0, 0);
    f.globalCompositeOperation = 'destination-in';
    f.imageSmoothingEnabled = true;
    f.drawImage(m, 0, 0, cw, ch);
    f.globalCompositeOperation = 'source-over';

    ctx.globalAlpha = look.fade;
    ctx.drawImage(this.bg, 0, 0);
    ctx.drawImage(this.fog, 0, 0);
    var k = this.dpr;
    for (i = 0; i < drops.length; i++) {
      var d = drops[i];
      ctx.beginPath();
      ctx.arc(d.x * k, d.y * k, d.r * k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,24,28,0.35)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc((d.x - d.r * 0.3) * k, (d.y - d.r * 0.35) * k, d.r * 0.35 * k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  FG.Fallback2D = Fallback2D;
})();

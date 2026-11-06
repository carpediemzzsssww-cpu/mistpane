/*
 * 水珠：擦拭边缘聚起来的水、长时间呼气凝得太厚的雾，偶尔会汇成水珠。
 * 小的挂在玻璃上慢慢干掉；超过临界大小就往下滑：一顿一顿地走，
 * 吸走路径上的雾，身后留下一串更小的珠子。
 * 单位都是 CSS 像素。
 */
(function () {
  'use strict';
  var FG = (window.FG = window.FG || {});

  function Drops(sim) {
    this.sim = sim;
    this.list = [];
    this.max = 280;
    this.rCrit = 2.7;
  }

  Drops.prototype.add = function (x, y, r, slide) {
    if (this.list.length >= this.max) {
      // 挤掉最小的静止珠子
      var mi = -1;
      var mr = 1e9;
      for (var i = 0; i < this.list.length; i++) {
        var q = this.list[i];
        if (!q.slide && q.r < mr) {
          mr = q.r;
          mi = i;
        }
      }
      if (mi < 0 || mr > r) return null;
      this.list.splice(mi, 1);
    }
    var d = {
      x: x,
      y: y,
      r: r,
      v: 0,
      slide: !!slide,
      pause: 0,
      phase: Math.random() * 100,
      acc: 0,
      next: 6 + Math.random() * 14,
      stretch: 1,
      age: 0
    };
    this.list.push(d);
    return d;
  };

  function vol(r) {
    return r * r * r;
  }
  function rad(v) {
    return Math.pow(Math.max(v, 0), 1 / 3);
  }

  Drops.prototype.update = function (dt) {
    var sim = this.sim;
    var list = this.list;
    var rCrit = this.rCrit;
    var H = sim.H;
    var i;
    var d;
    for (i = 0; i < list.length; i++) {
      d = list[i];
      d.age += dt;
      var dl = sim.sample(sim.D, d.x, d.y + d.r);
      var wl = sim.sample(sim.Wf, d.x, d.y + d.r);
      if (d.slide) {
        if (d.pause > 0) {
          d.pause -= dt;
        } else if (Math.random() < dt * 0.5 * (1.1 - Math.min(1, dl + wl))) {
          // 干玻璃上更容易卡住
          d.pause = 0.15 + Math.random() * 1.1;
        }
        var wet = Math.min(1, dl * 0.8 + wl);
        var vt = d.pause > 0 ? 0 : Math.min(85, Math.max(0, (d.r - rCrit * 0.85) * 24)) * (0.3 + 0.7 * wet);
        d.v += (vt - d.v) * Math.min(1, dt * (vt > d.v ? 3 : 7));
        var dy = d.v * dt;
        if (dy > 0) {
          var steps = Math.max(1, Math.ceil(dy / Math.max(0.8, d.r * 0.5)));
          var V = vol(d.r);
          for (var s = 0; s < steps; s++) {
            d.y += dy / steps;
            d.x += Math.sin(d.phase + d.y * 0.045) * 0.12 * (dy / steps) + (Math.random() - 0.5) * 0.25 * (dy / steps);
            var got = sim.clearDisk(d.x, d.y - d.r * 0.25, d.r * 0.95, 0.85, 0.55);
            V += got * 0.03;
          }
          // 路上留下一点水
          V -= dy * d.r * d.r * 0.02;
          d.acc += dy;
          if (d.acc > d.next) {
            d.acc = 0;
            d.next = d.r * (2.2 + Math.random() * 4);
            if (Math.random() < 0.6) {
              var br = d.r * (0.22 + Math.random() * 0.2);
              this.add(d.x + (Math.random() - 0.5) * d.r * 0.5, d.y - d.r * 1.3, br, false);
              V -= vol(br);
            }
          }
          d.r = rad(V);
        }
        d.stretch = 1 + Math.min(0.45, d.v * 0.006);
        if (d.r < rCrit * 0.75 && d.v < 2) {
          d.slide = false;
          d.stretch = 1;
        }
      } else {
        // 静止的珠子：在厚雾里吸水长大，在干玻璃上慢慢蒸发
        var grow = dl > 0.6 ? (dl - 0.6) * 0.5 : 0;
        var Vs = vol(d.r) + grow * dt * d.r * d.r;
        var evap = dl < 0.25 ? 0.035 : 0.006;
        d.r = rad(Vs) - evap * dt;
        if (d.r > 0.9 && dl > 0.2) sim.clearDisk(d.x, d.y, d.r * 1.6, 0.6 * dt, 0);
        if (d.r > rCrit && Math.random() < dt * 0.8) d.slide = true;
      }
    }

    // 滑动的水珠碰到别的珠子就合并
    for (i = 0; i < list.length; i++) {
      d = list[i];
      if (!d.slide || d.dead) continue;
      for (var j = 0; j < list.length; j++) {
        if (i === j) continue;
        var o = list[j];
        if (o.dead) continue;
        var ddx = o.x - d.x;
        var ddy = o.y - d.y;
        var rr = (d.r + o.r) * 0.85;
        if (ddx * ddx + ddy * ddy < rr * rr) {
          d.r = rad(vol(d.r) + vol(o.r));
          o.dead = true;
        }
      }
    }

    var out = [];
    for (i = 0; i < list.length; i++) {
      d = list[i];
      if (d.dead || d.r < 0.35 || d.y - d.r > H + 4) continue;
      out.push(d);
    }
    this.list = out;

    // 雾凝得太厚：偶尔自己结出水珠
    var gw = sim.gw;
    var D = sim.D;
    var tries = 24;
    for (var t = 0; t < tries; t++) {
      var gi = (Math.random() * D.length) | 0;
      if (D[gi] > 1.3 && Math.random() < dt * 1.1) {
        var gx = (gi % gw) + Math.random();
        var gy = ((gi / gw) | 0) + Math.random();
        this.add(gx * sim.csx, gy * sim.csy, 0.9 + Math.random() * 1.6, false);
      }
    }
  };

  Drops.prototype.clear = function () {
    this.list = [];
  };

  FG.Drops = Drops;
})();

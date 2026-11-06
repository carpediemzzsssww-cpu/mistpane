/*
 * 入口：输入、呼气、场景、主循环。
 *
 * 手势：
 *   拖动            → 擦雾（多指可以同时擦）
 *   原地按住 0.28s  → 在按住的位置哈气，松开停止
 *   空格            → 在鼠标所在位置（没有鼠标就在画面中央）哈气
 *   麦克风          → 检测到呼气时，在鼠标位置 / 画面中央哈气
 */
(function () {
  'use strict';
  var FG = window.FG;
  var C = window.FG_CONTENT;
  var copy = C.copy;

  var qs = {};
  location.search
    .replace(/^\?/, '')
    .split('&')
    .forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      qs[decodeURIComponent(p[0])] = p.length > 1 ? decodeURIComponent(p[1]) : '1';
    });

  var $ = function (id) {
    return document.getElementById(id);
  };
  var canvas = $('glass');
  var hintEl = $('hint');
  var uiEl = $('ui');
  var btnMic = $('btnMic');
  var btnScene = $('btnScene');
  var fileInput = $('fileInput');
  var creditEl = $('credit');
  var toastEl = $('toast');
  var debugEl = $('debug');

  var canHover = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ---------- 文案 ----------
  $('hintTitle').textContent = copy.hintTitle;
  $('hintSub').textContent = canHover ? copy.hintDesk : copy.hintTouch;
  $('hintMic').textContent = copy.hintMic;
  btnMic.textContent = copy.micOff;
  btnScene.textContent = copy.scene;
  $('btnUploadLabel').textContent = copy.upload;

  // ---------- 状态 ----------
  var TIERS = [2, 1.5, 1];
  var tier = qs.q === 'low' ? 2 : qs.q === 'med' ? 1 : 0;
  var W = 0;
  var H = 0;
  var dpr = 1;
  var sim = new FG.Sim();
  var drops = new FG.Drops(sim);
  var mic = new FG.BreathMic();
  var renderer = null;
  var usingGL = false;
  var paused = false;
  var started = false;
  var fade = 0;
  var time = 0;
  var sceneIndex = 0;
  var scene = null;
  var look = {
    fogTint: [0.92, 0.9, 0.88],
    fogLight: 0.12,
    room: [1, 0.75, 0.5],
    fade: 0,
    time: 0,
    microScale: 0.55,
    grain: 0.02
  };
  var lookTarget = null;
  var hover = { x: 0, y: 0, t: -1e9 };
  var hintHidden = false;
  var everBreathed = false;

  try {
    if (qs.gl === '0') throw new Error('forced 2d');
    renderer = new FG.Renderer(canvas);
    usingGL = true;
  } catch (e) {
    try {
      renderer = new FG.Fallback2D(canvas);
    } catch (e2) {
      renderer = null;
    }
    if (qs.gl !== '0') setTimeout(function () {
      toast(copy.noGl, 3600);
    }, 1200);
  }

  function breathRadius() {
    return Math.max(130, Math.min(380, Math.max(Math.min(W, H) * 0.55, Math.sqrt(W * H) * 0.3)));
  }
  function brushRadius() {
    return Math.max(10, Math.min(20, Math.min(W, H) * 0.03));
  }

  // ---------- 尺寸 ----------
  function resize() {
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, TIERS[tier]);
    var cw = Math.round(W * dpr);
    var ch = Math.round(H * dpr);
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    sim.resize(W, H);
    if (scene) sim.setAmbient(scene.ambient);
    if (renderer) renderer.resize(cw, ch, W, H, dpr);
  }
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // ---------- 场景 ----------
  var imgCache = {};
  function loadImage(src) {
    if (imgCache[src]) return imgCache[src];
    var p = new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        resolve(im);
      };
      im.onerror = reject;
      im.src = src;
    });
    imgCache[src] = p;
    return p;
  }

  function applyScene(sc, im) {
    scene = sc;
    var img = {
      source: im,
      width: im.naturalWidth || im.width,
      height: im.naturalHeight || im.height,
      focus: sc.focus
    };
    if (renderer) renderer.setImage(img, !started);
    lookTarget = sc;
    if (!started) {
      look.fogTint = sc.fogTint.slice();
      look.fogLight = sc.fogLight;
      look.room = sc.room.slice();
    }
    sim.setAmbient(sc.ambient);
    if (!started) sim.seedAmbient();
    started = true;
    showCredit(sc);
  }

  function setScene(i) {
    sceneIndex = (i + C.scenes.length) % C.scenes.length;
    var sc = C.scenes[sceneIndex];
    return loadImage(sc.file).then(function (im) {
      if (C.scenes[sceneIndex] !== sc) return;
      applyScene(sc, im);
      // 预载下一张
      loadImage(C.scenes[(sceneIndex + 1) % C.scenes.length].file);
    });
  }

  var creditTimer = 0;
  function showCredit(sc) {
    if (sc.credit) {
      creditEl.innerHTML = '';
      var a = document.createElement('a');
      a.href = sc.credit.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = sc.name + ' · ' + copy.photoBy + ' ' + sc.credit.author + ' · ' + sc.credit.license;
      creditEl.appendChild(a);
    } else {
      creditEl.textContent = sc.name;
    }
    creditEl.classList.add('show');
    clearTimeout(creditTimer);
    creditTimer = setTimeout(function () {
      creditEl.classList.remove('show');
    }, 5200);
  }

  // 上传：缩到 2400 以内，按平均亮度判断昼夜，给雾配合适的光
  function useFile(file) {
    if (!file) return;
    var url = (window.URL || window.webkitURL).createObjectURL(file);
    var im = new Image();
    im.onload = function () {
      var w = im.naturalWidth;
      var h = im.naturalHeight;
      var k = Math.min(1, 2400 / Math.max(w, h));
      var cv = document.createElement('canvas');
      cv.width = Math.round(w * k);
      cv.height = Math.round(h * k);
      var cx = cv.getContext('2d');
      cx.drawImage(im, 0, 0, cv.width, cv.height);
      var probe = document.createElement('canvas');
      probe.width = probe.height = 16;
      var pc = probe.getContext('2d');
      pc.drawImage(cv, 0, 0, 16, 16);
      var lum = 0.4;
      try {
        var d = pc.getImageData(0, 0, 16, 16).data;
        var s = 0;
        for (var i = 0; i < d.length; i += 4) s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        lum = s / 256;
      } catch (e) {
        /* tainted: keep default */
      }
      (window.URL || window.webkitURL).revokeObjectURL(url);
      var night = lum < 0.32;
      var sc = {
        id: 'upload',
        name: copy.uploadName,
        focus: [0.5, 0.5],
        fogTint: night ? [0.93, 0.9, 0.87] : [0.92, 0.93, 0.95],
        fogLight: night ? 0.11 : 0.12,
        room: [1.0, 0.75, 0.5],
        ambient: 0.85
      };
      applyScene(sc, cv);
    };
    im.onerror = function () {
      toast(copy.uploadFail, 2800);
    };
    im.src = url;
  }

  // ---------- 提示 / toast ----------
  var toastTimer = 0;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, ms || 2400);
  }
  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    hintEl.classList.add('gone');
  }

  // ---------- 麦克风 ----------
  function micLabel() {
    btnMic.textContent =
      mic.state === 'on' ? copy.micOn : mic.state === 'asking' ? copy.micAsking : copy.micOff;
    btnMic.classList.toggle('on', mic.state === 'on');
  }
  function toggleMic() {
    if (mic.state === 'on') {
      mic.stop();
      sim.endSource('mic');
      micLabel();
      return;
    }
    if (mic.state === 'asking') return;
    var p = mic.start();
    micLabel();
    p.then(
      function () {
        micLabel();
        $('hintMic').style.display = 'none';
      },
      function () {
        micLabel();
        toast(mic.state === 'unsupported' ? copy.micUnsupported : copy.micDenied, 3600);
      }
    );
  }
  btnMic.addEventListener('click', function () {
    toggleMic();
    btnMic.blur();
  });
  $('hintMic').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleMic();
  });
  btnScene.addEventListener('click', function () {
    setScene(sceneIndex + 1);
    btnScene.blur();
  });
  fileInput.addEventListener('change', function () {
    useFile(fileInput.files && fileInput.files[0]);
    fileInput.value = '';
  });

  // ---------- 呼气源 ----------
  var micPuff = null;
  var micIdle = 0;
  var keyBreath = null;

  function breathAnchor() {
    if (canHover && time - hover.t < 30) return { x: hover.x, y: hover.y };
    return { x: W * 0.5, y: H * 0.5 };
  }
  function jitter(p) {
    var j = Math.min(W, H) * 0.05;
    return { x: p.x + (Math.random() - 0.5) * 2 * j, y: p.y + (Math.random() - 0.5) * 2 * j };
  }

  function updateBreath(dt) {
    var R0 = breathRadius();
    var ms = mic.update(dt);
    if (ms > 0.01) {
      if (!micPuff) micPuff = jitter(breathAnchor());
      sim.setSource('mic', micPuff.x, micPuff.y, ms, R0);
      micIdle = 0;
      everBreathed = true;
    } else if (micPuff) {
      sim.setSource('mic', micPuff.x, micPuff.y, 0, R0);
      micIdle += dt;
      if (micIdle > 0.45) {
        sim.endSource('mic');
        micPuff = null;
      }
    }
    if (keyBreath) {
      keyBreath.s += (1 - keyBreath.s) * Math.min(1, dt * 2.2);
      sim.setSource('key', keyBreath.x, keyBreath.y, keyBreath.s, R0);
      everBreathed = true;
    }
    for (var id in pointers) {
      var p = pointers[id];
      if (p.mode === 'pending' && time - p.t0 > 0.28) {
        p.mode = 'breath';
        p.s = 0.45;
      }
      if (p.mode === 'breath') {
        p.s += (1 - p.s) * Math.min(1, dt * 2.2);
        sim.setSource('p' + id, p.x, p.y - R0 * 0.05, p.s, R0);
        everBreathed = true;
      }
    }
  }

  // ---------- 擦拭 ----------
  var pointers = {};
  var activeWipes = 0;

  function wipeSeg(p, x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    var ang = len > 0.01 ? Math.atan2(dy, dx) : p.ang;
    p.ang = ang;
    var rb = p.r;
    var spacing = Math.max(1, Math.min(rb * 0.28, sim.cs * 0.8));
    var n = Math.max(1, Math.ceil(len / spacing));
    var now = performance.now();
    var v = len / Math.max(1, now - p.lt) * 1000;
    p.lt = now;
    p.speed += (v - p.speed) * 0.3;
    var sp = Math.min(1, p.speed / 1800);
    var cosA = Math.cos(ang);
    var sinA = Math.sin(ang);
    var perpX = -sinA;
    var perpY = cosA;
    if (perpY < 0) {
      perpX = -perpX;
      perpY = -perpY;
    }
    for (var i = 1; i <= n; i++) {
      var t = i / n;
      var x = x0 + dx * t;
      var y = y0 + dy * t;
      p.dist += len / n;
      var press = 1 + 0.12 * Math.exp(-p.dist / 30);
      var wob = 1 + 0.06 * Math.sin(p.dist * 0.045 + p.seed) + 0.04 * Math.sin(p.dist * 0.13 + p.seed * 2.3);
      var r = rb * press * wob * (1.05 - 0.12 * sp);
      var got = sim.stamp(x, y, r, ang, 0.97);
      p.water += got;
      // 边缘的小水珠
      var dens = got / (Math.PI * r * r);
      if (Math.random() < Math.min(0.5, dens * 0.25)) {
        var side = Math.random() < 0.5 ? 1 : -1;
        var off = r * (1.0 + Math.random() * 0.18);
        drops.add(x - sinA * off * side, y + cosA * off * side, 0.5 + Math.random() * 0.9, false);
      }
      // 积够了水：在笔画下沿汇成一颗会往下滑的水珠
      if (p.water > p.nextDrop) {
        p.water = 0;
        p.nextDrop = nextDropAt(rb);
        var dr = (2.5 + Math.random() * 1.7) * Math.sqrt(rb / 14);
        drops.add(x + perpX * r * 0.98 - cosA * r * 0.3, y + perpY * r * 0.98 - sinA * r * 0.3, dr, dr > drops.rCrit);
      }
    }
  }
  function nextDropAt(r) {
    return (6000 + Math.random() * 14000) * Math.pow(r / 14, 2);
  }

  function ptFromEvent(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function down(id, x, y) {
    pointers[id] = {
      x: x,
      y: y,
      sx: x,
      sy: y,
      t0: time,
      lt: performance.now(),
      mode: 'pending',
      water: 0,
      nextDrop: nextDropAt(brushRadius()) * 0.6,
      ang: 0,
      speed: 0,
      dist: 0,
      seed: Math.random() * 100,
      r: brushRadius() * (0.92 + Math.random() * 0.16),
      s: 0
    };
    activeWipes++;
    uiEl.classList.add('dim');
  }
  function move(id, x, y) {
    var p = pointers[id];
    if (!p) return;
    if (p.mode === 'pending') {
      var ddx = x - p.sx;
      var ddy = y - p.sy;
      if (ddx * ddx + ddy * ddy > 49) {
        p.mode = 'wipe';
        wipeSeg(p, p.sx, p.sy, x, y);
      }
    } else if (p.mode === 'wipe') {
      wipeSeg(p, p.x, p.y, x, y);
    }
    p.x = x;
    p.y = y;
  }
  function up(id) {
    var p = pointers[id];
    if (!p) return;
    if (p.mode === 'pending') wipeSeg(p, p.x, p.y, p.x, p.y);
    if (p.mode === 'breath') sim.endSource('p' + id);
    delete pointers[id];
    activeWipes = Math.max(0, activeWipes - 1);
    if (!activeWipes) uiEl.classList.remove('dim');
  }

  if (window.PointerEvent) {
    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      down(e.pointerId, e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'mouse') {
        hover.x = e.clientX;
        hover.y = e.clientY;
        hover.t = time;
      }
      if (!pointers[e.pointerId]) return;
      var list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (!list || !list.length) list = [e];
      for (var i = 0; i < list.length; i++) {
        var q = ptFromEvent(list[i]);
        move(e.pointerId, q.x, q.y);
      }
    });
    var end = function (e) {
      up(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  } else {
    canvas.addEventListener(
      'touchstart',
      function (e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          var t = e.changedTouches[i];
          down('t' + t.identifier, t.clientX, t.clientY);
        }
      },
      { passive: false }
    );
    canvas.addEventListener(
      'touchmove',
      function (e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          var t = e.changedTouches[i];
          move('t' + t.identifier, t.clientX, t.clientY);
        }
      },
      { passive: false }
    );
    var tend = function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) up('t' + e.changedTouches[i].identifier);
    };
    canvas.addEventListener('touchend', tend);
    canvas.addEventListener('touchcancel', tend);
    canvas.addEventListener('mousedown', function (e) {
      if (e.button === 0) down('m', e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) {
      hover.x = e.clientX;
      hover.y = e.clientY;
      hover.t = time;
      move('m', e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', function () {
      up('m');
    });
  }
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  window.addEventListener('keydown', function (e) {
    if (e.keyCode !== 32 && e.code !== 'Space') return;
    e.preventDefault();
    if (keyBreath) return;
    var a = jitter(breathAnchor());
    keyBreath = { x: a.x, y: a.y, s: 0.45 };
  });
  window.addEventListener('keyup', function (e) {
    if (e.keyCode !== 32 && e.code !== 'Space') return;
    keyBreath = null;
    sim.endSource('key');
  });
  window.addEventListener('blur', function () {
    keyBreath = null;
    sim.endSource('key');
  });

  // ---------- 主循环 ----------
  var last = 0;
  var perf = { acc: 0, frames: 0, since: 0, fps: 0, cpu: 0 };

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function update(dt) {
    time += dt;
    updateBreath(dt);
    // 大步长拆成小步，避免数值不稳
    var steps = Math.ceil(dt / 0.034);
    for (var i = 0; i < steps; i++) sim.step(dt / steps);
    drops.update(dt);
    if (everBreathed && sim.totalD > 0.02) hideHint();
    if (lookTarget) {
      var k = Math.min(1, dt * 2);
      for (var c = 0; c < 3; c++) {
        look.fogTint[c] = lerp(look.fogTint[c], lookTarget.fogTint[c], k);
        look.room[c] = lerp(look.room[c], lookTarget.room[c], k);
      }
      look.fogLight = lerp(look.fogLight, lookTarget.fogLight, k);
    }
    if (started) fade = Math.min(1, fade + dt / 1.6);
  }

  function draw(dt) {
    if (!renderer) return;
    look.fade = fade * fade * (3 - 2 * fade);
    look.time = time;
    if (usingGL) renderer.uploadField(sim.gw, sim.gh, sim.pack());
    renderer.render(dt, look, drops.list, sim);
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = last ? (ts - last) / 1000 : 1 / 60;
    last = ts;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    var t0 = performance.now();
    if (!paused) update(dt);
    draw(dt);
    perf.cpu += (performance.now() - t0 - perf.cpu) * 0.05;
    autoQuality(dt);
    if (debugEl) debug(dt);
  }

  function autoQuality(dt) {
    if (qs.q) return;
    perf.acc += dt;
    perf.frames++;
    perf.since += dt;
    if (perf.acc >= 2.5) {
      perf.fps = perf.frames / perf.acc;
      if (perf.since > 5 && perf.fps < 38 && tier < TIERS.length - 1 && !document.hidden) {
        tier++;
        resize();
        perf.since = 0;
      }
      perf.acc = 0;
      perf.frames = 0;
    }
  }

  var dbgAcc = 0;
  function debug(dt) {
    dbgAcc += dt;
    if (dbgAcc < 0.2) return;
    dbgAcc = 0;
    debugEl.textContent =
      'fps ' + perf.fps.toFixed(0) + ' · cpu ' + perf.cpu.toFixed(1) + 'ms' +
      ' · dpr ' + dpr +
      ' · grid ' + sim.gw + '×' + sim.gh +
      ' · fog ' + sim.totalD.toFixed(3) +
      ' · drops ' + drops.list.length +
      (mic.state === 'on'
        ? '\nmic ' + mic.level.toFixed(1) + ' / floor ' + mic.floor.toFixed(1) +
          ' · low ' + (mic.lowLevel - mic.lowFloor).toFixed(1) +
          ' · flat ' + mic.flat.toFixed(2) + ' · raw ' + mic.raw.toFixed(2) + ' · breath ' + mic.strength.toFixed(2)
        : '\nmic ' + mic.state);
  }

  document.addEventListener('visibilitychange', function () {
    mic.suspend(document.hidden);
    last = 0;
    if (document.hidden) {
      keyBreath = null;
      sim.endSource('key');
    }
  });

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
  });
  canvas.addEventListener('webglcontextrestored', function () {
    if (!usingGL) return;
    renderer.init();
    var cur = renderer.images.next || renderer.images.cur;
    renderer.images.cur = cur;
    renderer.images.next = null;
    renderer.resize(canvas.width, canvas.height, W, H, dpr);
  });

  // ---------- 启动 ----------
  resize();
  setScene(0).then(null, function () {
    toast(copy.uploadFail, 2400);
  });
  requestAnimationFrame(frame);
  if (!hintHidden) hintEl.classList.add('show');
  if (!FG.BreathMic.supported()) $('hintMic').style.display = 'none';

  // ---------- 测试 / 调试钩子 ----------
  window.__fog = {
    sim: sim,
    drops: drops,
    mic: mic,
    get renderer() {
      return renderer;
    },
    get usingGL() {
      return usingGL;
    },
    get dpr() {
      return dpr;
    },
    perf: perf,
    setScene: setScene,
    pause: function (v) {
      paused = v !== false;
      last = 0;
    },
    // 手动推进 ms 毫秒（隐藏的浏览器面板里 rAF 会冻结）
    step: function (ms) {
      var n = Math.max(1, Math.round(ms / 16));
      for (var i = 0; i < n; i++) update(0.016);
      draw(0.016);
    },
    breath: function (x, y, strength) {
      if (strength > 0) sim.setSource('test', x, y, strength, breathRadius());
      else sim.endSource('test');
      everBreathed = true;
    },
    stroke: function (pts) {
      down('test', pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) move('test', pts[i][0], pts[i][1]);
      up('test');
    },
    render: function () {
      draw(0.016);
    }
  };
})();

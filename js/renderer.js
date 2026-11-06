/*
 * WebGL1 玻璃渲染
 *
 * 背景照片 → 一套预模糊的贴图（全分辨率 / 1/2 / 1/4 / 1/8，在近似线性空间里模糊，
 * 亮的灯才会在雾里晕开）。最终合成时按每个像素的凝结水量在这几层之间插值，
 * 再叠上：
 *   - 微观凝结颗粒：一张预生成的「小水珠法线图」，水量越多颗粒越多越大，
 *     每颗都折射、边缘发暗、带一点高光
 *   - 光散射：雾把室内光和场景里亮处的光散开
 *   - 擦痕：中间清晰，有顺着笔画方向的细水纹；边缘有被推起来的水脊（折射 + 明暗）
 *   - 大水珠：单独画进一张法线贴图，再像透镜一样折射背景
 *     （思路来自 KingDuane/Raindrop，MIT：法线编码 + smoothstep 阈值合成）
 * 所有贴图都按「第 0 行 = 屏幕顶部」存放，合成时统一用 s = (u, 1-v) 采样。
 */
(function () {
  'use strict';
  var FG = (window.FG = window.FG || {});

  var PREC =
    '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  var VS_QUAD = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  // 照片按 cover 方式铺满，4 点超采样（照片比屏幕大时防锯齿）
  var FS_COVER =
    PREC +
    [
      'varying vec2 vUv;',
      'uniform sampler2D uTex;',
      'uniform vec2 uScale; uniform vec2 uOff; uniform vec2 uTexel;',
      'vec3 L(vec2 p){ vec3 c = texture2D(uTex, p).rgb; return c * c; }',
      'void main(){',
      '  vec2 p = vUv * uScale + uOff;',
      '  vec3 c = L(p + uTexel * vec2(-0.25, -0.25)) + L(p + uTexel * vec2(0.25, -0.25))',
      '         + L(p + uTexel * vec2(-0.25, 0.25)) + L(p + uTexel * vec2(0.25, 0.25));',
      '  gl_FragColor = vec4(sqrt(c * 0.25), 1.0);',
      '}'
    ].join('\n');

  var FS_BLUR =
    PREC +
    [
      'varying vec2 vUv;',
      'uniform sampler2D uTex; uniform vec2 uStep;',
      'vec3 L(vec2 p){ vec3 c = texture2D(uTex, p).rgb; return c * c; }',
      'void main(){',
      '  vec3 c = L(vUv) * 0.2042;',
      '  c += (L(vUv + uStep) + L(vUv - uStep)) * 0.1802;',
      '  c += (L(vUv + 2.0 * uStep) + L(vUv - 2.0 * uStep)) * 0.1238;',
      '  c += (L(vUv + 3.0 * uStep) + L(vUv - 3.0 * uStep)) * 0.0663;',
      '  c += (L(vUv + 4.0 * uStep) + L(vUv - 4.0 * uStep)) * 0.0276;',
      '  gl_FragColor = vec4(sqrt(c), 1.0);',
      '}'
    ].join('\n');

  var FS_MIX =
    PREC +
    [
      'varying vec2 vUv;',
      'uniform sampler2D uA; uniform sampler2D uB; uniform float uT;',
      'void main(){',
      '  vec3 a = texture2D(uA, vUv).rgb; vec3 b = texture2D(uB, vUv).rgb;',
      '  gl_FragColor = vec4(sqrt(mix(a * a, b * b, uT)), 1.0);',
      '}'
    ].join('\n');

  var VS_DROP = [
    'attribute vec2 aCorner;',
    'attribute vec4 aDrop;', // x, y, r, stretch（CSS 像素）
    'uniform vec2 uView; uniform float uDpr;',
    'varying vec2 vP; varying float vR; varying float vAA; varying float vS;',
    'void main(){',
    '  vP = aCorner; vR = aDrop.z; vS = aDrop.w;',
    '  vAA = 1.5 / max(aDrop.z * uDpr, 0.75);',
    '  vec2 size = vec2(aDrop.z, aDrop.z * aDrop.w) * 1.2;',
    '  vec2 pos = aDrop.xy + aCorner * size + vec2(0.0, aDrop.z * (aDrop.w - 1.0) * 0.5);',
    '  gl_Position = vec4(pos / uView * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_DROP =
    PREC +
    [
      'varying vec2 vP; varying float vR; varying float vAA; varying float vS;',
      'void main(){',
      '  vec2 p = vP * 1.2;',
      // 滑动的水珠：上窄下圆
      '  float top = clamp(-p.y, 0.0, 1.0);',
      '  p.x *= 1.0 + top * (vS - 1.0) * 1.6;',
      '  float d = length(p);',
      '  float a = 1.0 - smoothstep(1.0 - vAA, 1.0, d);',
      '  if (a <= 0.0) discard;',
      '  vec2 n = p / max(d, 1.0);',
      '  gl_FragColor = vec4(vec3(n * 0.5 + 0.5, clamp(vR / 8.0, 0.0, 1.0)) * a, a);',
      '}'
    ].join('\n');

  var FS_COMPOSE =
    PREC +
    [
      'varying vec2 vUv;',
      'uniform sampler2D uBg; uniform sampler2D uBg1; uniform sampler2D uBg2; uniform sampler2D uBg3;',
      'uniform sampler2D uField; uniform sampler2D uMicro; uniform sampler2D uDrops;',
      'uniform vec2 uView;', // CSS 像素
      'uniform vec2 uFieldTexel;',
      'uniform vec3 uFogTint; uniform float uFogLight; uniform vec3 uRoom;',
      'uniform float uTime; uniform float uFade; uniform float uMicroScale; uniform float uGrain;',
      'uniform float uHasDrops;',
      // Dave Hoskins hash without sine (MIT)
      'float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
      'float h11(float x){ return hash12(vec2(x, 17.17)); }',
      'float vn(float x){ float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(i), h11(i + 1.0), f); }',
      'float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
      // 4 次双线性采样拼成的三次 B 样条：低分辨率水汽场的等值线变平滑，擦痕边缘没有锯齿台阶
      'vec4 cubicW(float v){ vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v; vec4 s = n * n * n;',
      '  float x = s.x; float y = s.y - 4.0 * s.x; float z = s.z - 4.0 * s.y + 6.0 * s.x; return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0); }',
      'vec4 fieldCubic(vec2 uv){',
      '  vec2 res = 1.0 / uFieldTexel; uv = uv * res - 0.5; vec2 f = fract(uv); uv -= f;',
      '  vec4 xc = cubicW(f.x); vec4 yc = cubicW(f.y);',
      '  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;',
      '  vec4 sm = vec4(xc.xz + xc.yw, yc.xz + yc.yw);',
      '  vec4 o = (c + vec4(xc.yw, yc.yw) / sm) * uFieldTexel.xxyy;',
      '  vec4 s0 = texture2D(uField, o.xz); vec4 s1 = texture2D(uField, o.yz);',
      '  vec4 s2 = texture2D(uField, o.xw); vec4 s3 = texture2D(uField, o.yw);',
      '  float sx = sm.x / (sm.x + sm.y); float sy = sm.z / (sm.z + sm.w);',
      '  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);',
      '}',
      'void main(){',
      '  vec2 s = vec2(vUv.x, 1.0 - vUv.y);',
      '  vec2 px = s * uView;',
      '  vec2 toUv = 1.0 / uView;',
      '  vec3 Ld = normalize(vec3(-0.45, -0.65, 0.9));',

      '  vec4 F = fieldCubic(s);',
      '  float D = F.r * 1.5;',
      '  float fx1 = texture2D(uField, s + vec2(uFieldTexel.x, 0.0)).r;',
      '  float fx0 = texture2D(uField, s - vec2(uFieldTexel.x, 0.0)).r;',
      '  float fy1 = texture2D(uField, s + vec2(0.0, uFieldTexel.y)).r;',
      '  float fy0 = texture2D(uField, s - vec2(0.0, uFieldTexel.y)).r;',
      '  vec2 grad = vec2(fx1 - fx0, fy1 - fy0) * 0.75;',
      '  float gm = length(grad);',

      // —— 微观凝结颗粒：两层不同尺度、旋转错开，避免看出平铺
      '  vec2 mp = px / (512.0 * uMicroScale);',
      '  vec4 m1 = texture2D(uMicro, mp);',
      '  vec4 m2 = texture2D(uMicro, vec2(mp.x * 0.81 - mp.y * 0.59, mp.x * 0.59 + mp.y * 0.81) * 1.37 + vec2(0.37, 0.61));',
      '  float grease = F.b;',
      '  float grow = clamp(D * 0.75 + grease * 0.25, 0.0, 1.0);',
      '  float v1 = step(0.01, m1.b) * step(m1.a, D * 1.6) * smoothstep(1.0 - grow - 0.07, 1.0 - grow + 0.07, m1.b);',
      '  float v2 = step(0.01, m2.b) * step(m2.a, D * 1.6 - 0.1) * smoothstep(1.0 - grow - 0.07, 1.0 - grow + 0.07, m2.b);',
      '  vec2 mn; float vis;',
      '  if (v2 * m2.b > v1 * m1.b) { mn = (m2.rg - 0.5) * 2.0; vis = v2; } else { mn = (m1.rg - 0.5) * 2.0; vis = v1; }',

      // —— 雾的覆盖：边缘是颗粒状推进的，不是平滑的透明度渐变
      '  float thr = min(m1.a, m2.a + 0.15);',
      '  float cover = clamp((D * 1.4 - thr * 0.6) * 2.6, 0.0, 1.0);',
      '  float hz = cover * smoothstep(0.0, 0.9, D);',
      // 油脂处凝结成更少更大的水珠 → 更透，字迹的鬼影
      '  hz *= 1.0 - 0.55 * grease * (1.0 - smoothstep(1.0, 1.55, D));',

      // —— 透射：越厚越模糊，颗粒做微小折射
      '  vec2 dOff = mn * vis * 1.6 * toUv;',
      '  vec3 b1 = texture2D(uBg1, s + dOff).rgb;',
      '  vec3 b2 = texture2D(uBg2, s + dOff * 2.0).rgb;',
      '  vec3 b3 = texture2D(uBg3, s).rgb;',
      '  float t2 = smoothstep(0.1, 0.8, D); float t3 = smoothstep(0.55, 1.5, D);',
      '  vec3 trans = mix(mix(b1, b2, t2), b3, t3 * 0.8);',
      // —— 散射：室内的光 + 场景亮处的光在雾里晕开
      '  vec3 bloom = max(b3 - 0.55, 0.0);',
      '  vec3 scat = uFogTint * (uFogLight * 2.6 + luma(b3) * 0.7) + mix(bloom, vec3(luma(bloom)), 0.4) * 0.9;',
      '  vec3 fogCol = mix(trans, scat, 0.52 * hz);',

      // —— 每颗小水珠：透镜（倒影）+ 边缘发暗 + 高光
      '  float nl = length(mn);',
      '  vec3 N = normalize(vec3(mn, sqrt(max(0.0, 1.0 - nl * nl)) + 0.3));',
      '  float spec = pow(max(dot(N, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0), 30.0);',
      '  float lightAmt = uFogLight + luma(b3) * 0.9;',
      '  vec3 lens = texture2D(uBg2, s - mn * 12.0 * toUv).rgb;',
      '  vec3 dropC = mix(fogCol, lens * 1.05 + uFogTint * uFogLight * 0.6, 0.35) * (1.0 - 0.2 * smoothstep(0.55, 1.0, nl));',
      '  dropC += spec * lightAmt * 0.6 * uFogTint;',
      '  fogCol = mix(fogCol, dropC, vis * clamp(hz * 1.3, 0.0, 1.0) * 0.45);',

      // —— 擦过的地方：残留水膜顺着笔画方向的细纹
      '  float ang = F.a * 3.14159265;',
      '  vec2 perp = vec2(-sin(ang), cos(ang));',
      '  float film = F.g * (1.0 - smoothstep(0.05, 0.45, D));',
      '  float u = dot(px, perp);',
      '  float str = vn(u * 0.85) * 0.6 + vn(u * 2.6 + 7.0) * 0.4;',
      '  vec2 fOff = perp * (str - 0.5) * film * 3.2 * toUv;',
      '  vec3 clearCol = texture2D(uBg, s + fOff).rgb;',
      '  clearCol *= 1.0 + (str - 0.5) * film * 0.12;',

      '  vec3 col = mix(clearCol, fogCol, hz);',

      // —— 擦痕边缘的水脊：被手指推到两边的水
      '  float ridge = clamp(smoothstep(0.1, 0.42, gm) * (1.0 - smoothstep(0.9, 1.45, D)) * 0.85',
      '              + F.g * smoothstep(0.04, 0.35, D) * 0.6, 0.0, 1.0);',
      '  if (ridge > 0.01) {',
      '    vec2 rn = clamp(grad * 2.4, vec2(-0.9), vec2(0.9));',
      '    vec3 rc = texture2D(uBg1, s - rn * 6.0 * toUv).rgb;',
      '    float sh = dot(normalize(vec3(rn, 0.55)), Ld);',
      '    rc = rc * (0.82 + 0.32 * sh) + pow(max(sh, 0.0), 8.0) * 0.3 * lightAmt * uFogTint;',
      '    col = mix(col, rc, ridge * 0.55);',
      '  }',

      // —— 大水珠
      '  if (uHasDrops > 0.5) {',
      '    vec4 dr = texture2D(uDrops, s);',
      '    if (dr.a > 0.004) {',
      '      vec3 dn = dr.rgb / dr.a;',
      '      vec2 n2 = (dn.rg - 0.5) * 2.0;',
      '      float rad = dn.b * 8.0;',
      '      float mask = smoothstep(0.2, 0.75, dr.a);',
      '      float l2 = min(1.0, length(n2));',
      '      float hz2 = sqrt(max(0.0, 1.0 - l2 * l2));',
      '      vec2 off = -n2 * (rad * 2.2 + 3.0) * toUv;',
      '      vec3 dc = mix(texture2D(uBg, s + off).rgb, texture2D(uBg1, s + off * 1.3).rgb, 0.35);',
      '      dc *= 1.0 - 0.6 * smoothstep(0.6, 1.0, l2);',
      '      vec3 Nd = normalize(vec3(n2, hz2 + 0.15));',
      '      float sp = pow(max(dot(Nd, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0), 60.0);',
      '      float caus = smoothstep(0.2, 0.9, n2.y) * (1.0 - smoothstep(0.85, 1.0, l2));',
      '      dc += sp * (0.55 + lightAmt) * 0.7 + caus * 0.06 * (uFogLight + luma(b3));',
      '      col = mix(col, dc, mask);',
      '    }',
      '  }',

      // —— 玻璃上极淡的室内反光 + 暗角 + 胶片颗粒
      '  float refl = (1.0 - luma(col)) * (0.35 + 0.65 * s.y) * (1.0 - s.x * 0.7);',
      '  col += uRoom * refl * 0.03;',
      '  vec2 vq = (s - 0.5) * vec2(1.0, 0.9);',
      '  col *= 1.0 - 0.24 * pow(clamp(length(vq) * 1.35, 0.0, 1.0), 2.4);',
      // 高光肩部：亮的场景起雾也不会一片死白
      '  vec3 shoulder = 0.8 + 0.2 * (1.0 - exp(-(col - 0.8) / 0.2));',
      '  col = mix(col, shoulder, step(0.8, col));',
      '  col += (hash12(gl_FragCoord.xy + fract(uTime * 7.0) * vec2(113.0, 71.0)) - 0.5) * uGrain;',
      '  gl_FragColor = vec4(col * uFade, 1.0);',
      '}'
    ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function Program(gl, vs, fs, attribs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    for (var i = 0; i < attribs.length; i++) gl.bindAttribLocation(p, i, attribs[i]);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    this.p = p;
    this.gl = gl;
    this.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      this.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
  }

  function makeTex(gl, w, h, data, wrap, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || null);
    return t;
  }

  function makeTarget(gl, w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    var tex = makeTex(gl, w, h, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: tex, fb: fb, w: w, h: h };
  }

  function freeTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }

  // 微观凝结颗粒贴图：R,G = 法线，B = 高度（0 = 空隙），A = 出现阈值（雾越厚，阈值高的越晚出现）
  function makeMicro(size, seed) {
    var rnd = FG.rng(seed);
    var N = size * size;
    var hgt = new Float32Array(N);
    var nx = new Float32Array(N);
    var ny = new Float32Array(N);
    var thr = new Float32Array(N);
    var gap = FG.noiseMap(size, size, 5, 3, seed + 5);
    var i;
    for (i = 0; i < N; i++) thr[i] = 0.45 + 0.55 * (0.35 * gap[i] + 0.65 * rnd());
    var count = Math.round(N * 0.085);
    for (var k = 0; k < count; k++) {
      var r = 0.6 + Math.pow(rnd(), 2.6) * 4.6;
      var cx = rnd() * size;
      var cy = rnd() * size;
      var t = Math.min(0.98, 0.03 + 0.55 * rnd() + 0.3 * (r / 5.2));
      var R = Math.ceil(r);
      var ix = Math.floor(cx);
      var iy = Math.floor(cy);
      for (var dy = -R; dy <= R; dy++) {
        var fy = iy + dy + 0.5 - cy;
        for (var dx = -R; dx <= R; dx++) {
          var fx = ix + dx + 0.5 - cx;
          var d2 = (fx * fx + fy * fy) / (r * r);
          if (d2 >= 1) continue;
          var h = Math.pow(1 - d2, 0.55);
          var X = (ix + dx + size) % size;
          var Y = (iy + dy + size) % size;
          var idx = Y * size + X;
          if (h > hgt[idx]) {
            hgt[idx] = h;
            nx[idx] = fx / r;
            ny[idx] = fy / r;
            thr[idx] = t;
          }
        }
      }
    }
    var b = new Uint8Array(N * 4);
    for (i = 0; i < N; i++) {
      b[i * 4] = Math.round((nx[i] * 0.5 + 0.5) * 255);
      b[i * 4 + 1] = Math.round((ny[i] * 0.5 + 0.5) * 255);
      b[i * 4 + 2] = Math.round(hgt[i] * 255);
      b[i * 4 + 3] = Math.round(Math.min(1, thr[i]) * 255);
    }
    return b;
  }

  function Renderer(canvas) {
    var opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    };
    var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('no webgl');
    this.gl = gl;
    this.canvas = canvas;
    this.init();
  }

  Renderer.prototype.init = function () {
    var gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.pCover = new Program(gl, VS_QUAD, FS_COVER, ['aPos']);
    this.pBlur = new Program(gl, VS_QUAD, FS_BLUR, ['aPos']);
    this.pMix = new Program(gl, VS_QUAD, FS_MIX, ['aPos']);
    this.pComp = new Program(gl, VS_QUAD, FS_COMPOSE, ['aPos']);
    this.pDrop = new Program(gl, VS_DROP, FS_DROP, ['aCorner', 'aDrop']);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.dropBuf = gl.createBuffer();
    this.dropData = new Float32Array(300 * 6 * 6);
    var MS = 512;
    this.micro = makeTex(gl, MS, MS, makeMicro(MS, 7), gl.REPEAT);
    this.field = null;
    this.fieldW = 0;
    this.fieldH = 0;
    this.sets = { cur: null, next: null, view: null };
    this.mixT = 1;
    this.images = { cur: null, next: null };
  };

  Renderer.prototype.bindQuad = function () {
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
  };

  Renderer.prototype.target = function (t) {
    var gl = this.gl;
    if (t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, t.w, t.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  Renderer.prototype.tex = function (unit, t) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  };

  Renderer.prototype.resize = function (cw, ch, W, H, dpr) {
    this.cw = cw;
    this.ch = ch;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    var gl = this.gl;
    freeTarget(gl, this.drops);
    this.drops = makeTarget(gl, cw, ch);
    // 背景各层尺寸
    var k = Math.min(1, 2048 / Math.max(cw, ch));
    this.bgW = Math.round(cw * k);
    this.bgH = Math.round(ch * k);
    var self = this;
    ['cur', 'next', 'view'].forEach(function (key) {
      self.freeSet(self.sets[key]);
      self.sets[key] = null;
    });
    if (this.images.cur) this.sets.cur = this.buildSet(this.images.cur);
    if (this.images.next) this.sets.next = this.buildSet(this.images.next);
  };

  Renderer.prototype.allocSet = function () {
    var gl = this.gl;
    var w = this.bgW;
    var h = this.bgH;
    return {
      full: makeTarget(gl, w, h),
      l1: makeTarget(gl, w / 2, h / 2),
      l2: makeTarget(gl, w / 4, h / 4),
      l3: makeTarget(gl, w / 8, h / 8),
      t1: makeTarget(gl, w / 2, h / 2),
      t2: makeTarget(gl, w / 4, h / 4),
      t3: makeTarget(gl, w / 8, h / 8)
    };
  };

  Renderer.prototype.freeSet = function (set) {
    if (!set) return;
    var gl = this.gl;
    for (var k in set) freeTarget(gl, set[k]);
  };

  Renderer.prototype.blur = function (src, tmp, dst, radius) {
    var gl = this.gl;
    var p = this.pBlur;
    gl.useProgram(p.p);
    gl.uniform1i(p.u.uTex, 0);
    this.target(tmp);
    this.tex(0, src.tex);
    gl.uniform2f(p.u.uStep, radius / tmp.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.target(dst);
    this.tex(0, tmp.tex);
    gl.uniform2f(p.u.uStep, 0, radius / dst.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  // img: { source: HTMLImageElement|Canvas, focus: [x, y] }
  Renderer.prototype.buildSet = function (img) {
    var gl = this.gl;
    var set = this.allocSet();
    var src = makeTex(gl, 1, 1, null);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.source);
    var iw = img.width;
    var ih = img.height;
    var ia = iw / ih;
    var sa = this.W / this.H;
    var fx = img.focus ? img.focus[0] : 0.5;
    var fy = img.focus ? img.focus[1] : 0.5;
    var scale;
    var off;
    if (ia > sa) {
      scale = [sa / ia, 1];
      off = [(1 - sa / ia) * fx, 0];
    } else {
      scale = [1, ia / sa];
      off = [0, (1 - ia / sa) * fy];
    }
    this.bindQuad();
    gl.disable(gl.BLEND);
    var p = this.pCover;
    gl.useProgram(p.p);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uScale, scale[0], scale[1]);
    gl.uniform2f(p.u.uOff, off[0], off[1]);
    gl.uniform2f(p.u.uTexel, scale[0] / set.full.w, scale[1] / set.full.h);
    this.target(set.full);
    this.tex(0, src);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.deleteTexture(src);

    this.blur(set.full, set.t1, set.l1, 1.6);
    this.blur(set.l1, set.t2, set.l2, 1.8);
    this.blur(set.l2, set.t3, set.l3, 2.0);
    this.blur(set.l3, set.t3, set.l3, 2.0);
    return set;
  };

  Renderer.prototype.setImage = function (img, instant) {
    if (!this.images.cur || instant) {
      this.freeSet(this.sets.cur);
      this.freeSet(this.sets.next);
      this.sets.next = null;
      this.images.next = null;
      this.images.cur = img;
      this.sets.cur = this.buildSet(img);
      this.mixT = 1;
      return;
    }
    if (this.sets.next) {
      // 上一次切换还没完成：直接定格到它
      this.freeSet(this.sets.cur);
      this.sets.cur = this.sets.next;
      this.images.cur = this.images.next;
    }
    this.images.next = img;
    this.sets.next = this.buildSet(img);
    this.mixT = 0;
  };

  Renderer.prototype.advanceMix = function (dt) {
    if (!this.sets.next) return this.sets.cur;
    this.mixT = Math.min(1, this.mixT + dt / 1.4);
    if (this.mixT >= 1) {
      this.freeSet(this.sets.cur);
      this.sets.cur = this.sets.next;
      this.images.cur = this.images.next;
      this.sets.next = null;
      this.images.next = null;
      return this.sets.cur;
    }
    var gl = this.gl;
    if (!this.sets.view) this.sets.view = this.allocSet();
    var v = this.sets.view;
    var a = this.sets.cur;
    var b = this.sets.next;
    var t = this.mixT;
    t = t * t * (3 - 2 * t);
    var p = this.pMix;
    gl.useProgram(p.p);
    gl.uniform1i(p.u.uA, 0);
    gl.uniform1i(p.u.uB, 1);
    gl.uniform1f(p.u.uT, t);
    var keys = ['full', 'l1', 'l2', 'l3'];
    for (var i = 0; i < keys.length; i++) {
      this.target(v[keys[i]]);
      this.tex(0, a[keys[i]].tex);
      this.tex(1, b[keys[i]].tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return v;
  };

  Renderer.prototype.uploadField = function (gw, gh, bytes) {
    var gl = this.gl;
    if (!this.field || this.fieldW !== gw || this.fieldH !== gh) {
      if (this.field) gl.deleteTexture(this.field);
      this.field = makeTex(gl, gw, gh, bytes);
      this.fieldW = gw;
      this.fieldH = gh;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.field);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
  };

  Renderer.prototype.drawDrops = function (list) {
    var gl = this.gl;
    var n = Math.min(list.length, 300);
    this.target(this.drops);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.dropCount = n;
    if (!n) return;
    var a = this.dropData;
    var C = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
    var o = 0;
    for (var i = 0; i < n; i++) {
      var d = list[i];
      for (var c = 0; c < 6; c++) {
        a[o++] = C[c * 2];
        a[o++] = C[c * 2 + 1];
        a[o++] = d.x;
        a[o++] = d.y;
        a[o++] = d.r;
        a[o++] = d.stretch || 1;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
    gl.bufferData(gl.ARRAY_BUFFER, a.subarray(0, o), gl.DYNAMIC_DRAW);
    var p = this.pDrop;
    gl.useProgram(p.p);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.uniform2f(p.u.uView, this.W, this.H);
    gl.uniform1f(p.u.uDpr, this.dpr);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, n * 6);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(1);
  };

  // look: { fogTint:[r,g,b], fogLight, room:[r,g,b], fade, time }
  Renderer.prototype.render = function (dt, look, drops) {
    var gl = this.gl;
    gl.disable(gl.BLEND);
    this.bindQuad();
    var set = this.advanceMix(dt);
    if (drops) this.drawDrops(drops);
    this.bindQuad();
    this.target(null);
    if (!set || !this.field) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    var p = this.pComp;
    var u = p.u;
    gl.useProgram(p.p);
    this.tex(0, set.full.tex);
    this.tex(1, set.l1.tex);
    this.tex(2, set.l2.tex);
    this.tex(3, set.l3.tex);
    this.tex(4, this.field);
    this.tex(5, this.micro);
    this.tex(6, this.drops.tex);
    gl.uniform1i(u.uBg, 0);
    gl.uniform1i(u.uBg1, 1);
    gl.uniform1i(u.uBg2, 2);
    gl.uniform1i(u.uBg3, 3);
    gl.uniform1i(u.uField, 4);
    gl.uniform1i(u.uMicro, 5);
    gl.uniform1i(u.uDrops, 6);
    gl.uniform2f(u.uView, this.W, this.H);
    gl.uniform2f(u.uFieldTexel, 1 / this.fieldW, 1 / this.fieldH);
    gl.uniform3fv(u.uFogTint, look.fogTint);
    gl.uniform1f(u.uFogLight, look.fogLight);
    gl.uniform3fv(u.uRoom, look.room);
    gl.uniform1f(u.uTime, look.time);
    gl.uniform1f(u.uFade, look.fade);
    gl.uniform1f(u.uMicroScale, look.microScale || 0.75);
    gl.uniform1f(u.uGrain, look.grain == null ? 0.02 : look.grain);
    gl.uniform1f(u.uHasDrops, this.dropCount ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  FG.Renderer = Renderer;
})();

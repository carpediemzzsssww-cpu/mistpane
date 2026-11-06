/*
 * 麦克风呼气检测
 *
 * 哈气（"哈——"）是不带音高的送气噪声，频谱平坦；对着麦克风吹气会有很重的低频风噪。
 * 说话是有谐波的，频谱不平坦，而且断断续续。所以：
 *   强度 = 相对环境底噪高出多少 dB
 *   门控 = 中频段的频谱平坦度 + 时域自相关的「有没有音高」（排除说话、唱歌、音乐）
 *   另一路：低频风噪突然变大（直接对着麦克风吹）
 *   持续 90ms 以上才算一口气，松开有 ~0.3s 的拖尾
 * 必须关掉浏览器自带的降噪 / 自动增益，否则呼气声会被当噪声滤掉。
 */
(function () {
  'use strict';
  var FG = (window.FG = window.FG || {});

  function smoothstep(a, b, x) {
    var t = (x - a) / (b - a);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }

  function BreathMic() {
    this.state = 'off'; // off | asking | on | denied | unsupported
    this.strength = 0; // 0..1，平滑后的呼气强度
    this.raw = 0;
    this.level = -100;
    this.floor = null;
    this.lowLevel = -100;
    this.lowFloor = null;
    this.flat = 0;
    this.onTime = 0;
    this.calib = 0;
    this.voice = 0;
  }

  BreathMic.supported = function () {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext)
    );
  };

  BreathMic.prototype.start = function () {
    var self = this;
    if (!BreathMic.supported()) {
      this.state = 'unsupported';
      return Promise.reject(new Error('unsupported'));
    }
    this.state = 'asking';
    var AC = window.AudioContext || window.webkitAudioContext;
    // 在用户手势里先建 AudioContext（iOS 要求）
    var ctx;
    try {
      ctx = this.ctx || new AC();
    } catch (e) {
      this.state = 'unsupported';
      return Promise.reject(e);
    }
    this.ctx = ctx;
    return navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      .then(function (stream) {
        self.stream = stream;
        var src = ctx.createMediaStreamSource(stream);
        var an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.25;
        src.connect(an);
        // 部分 WebKit 需要图连到输出才会跑；静音输出
        var mute = ctx.createGain();
        mute.gain.value = 0;
        an.connect(mute);
        mute.connect(ctx.destination);
        self.an = an;
        self.freq = new Float32Array(an.frequencyBinCount);
        self.wave = new Float32Array(an.fftSize);
        self.waveB = an.getFloatTimeDomainData ? null : new Uint8Array(an.fftSize);
        self.half = new Float32Array(an.fftSize >> 1);
        self.state = 'on';
        self.floor = null;
        self.lowFloor = null;
        self.calib = 0;
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        return self;
      })
      .catch(function (err) {
        self.state = 'denied';
        throw err;
      });
  };

  BreathMic.prototype.stop = function () {
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
    this.stream = null;
    this.an = null;
    this.state = 'off';
    this.strength = 0;
    this.raw = 0;
  };

  BreathMic.prototype.suspend = function (yes) {
    if (!this.ctx) return;
    try {
      if (yes && this.ctx.suspend) this.ctx.suspend();
      if (!yes && this.ctx.resume) this.ctx.resume();
    } catch (e) {
      /* ignore */
    }
  };

  BreathMic.prototype.update = function (dt) {
    if (this.state !== 'on' || !this.an) {
      this.strength += (0 - this.strength) * Math.min(1, dt * 4);
      return this.strength;
    }
    var an = this.an;
    var f = this.freq;
    an.getFloatFrequencyData(f);
    var binHz = this.ctx.sampleRate / an.fftSize;
    var b0 = Math.max(1, Math.round(250 / binHz));
    var b1 = Math.min(f.length - 1, Math.round(4500 / binHz));
    var sum = 0;
    var lnSum = 0;
    var cnt = 0;
    var i;
    for (i = b0; i <= b1; i++) {
      var db = f[i];
      if (!(db > -160)) db = -160;
      var p = Math.pow(10, db / 10);
      sum += p;
      lnSum += Math.log(p + 1e-20);
      cnt++;
    }
    var mean = sum / cnt;
    var flat = Math.exp(lnSum / cnt) / (mean + 1e-20);
    var level = 10 * Math.log(sum + 1e-20) / Math.LN10;
    var lsum = 0;
    var l0 = Math.max(1, Math.round(30 / binHz));
    var l1 = Math.round(220 / binHz);
    for (i = l0; i <= l1; i++) {
      var ldb = f[i];
      if (!(ldb > -160)) ldb = -160;
      lsum += Math.pow(10, ldb / 10);
    }
    var low = 10 * Math.log(lsum + 1e-20) / Math.LN10;

    var voicing = this.voicing();
    this.voice = Math.max(voicing, this.voice - dt * 1.6);

    this.level = level;
    this.lowLevel = low;
    this.flat += (flat - this.flat) * Math.min(1, dt * 12);

    // 底噪：前 0.6 秒校准，之后向下跟得快、向上跟得慢（只在不呼气时）
    if (this.floor === null) {
      this.floor = level;
      this.lowFloor = low;
    }
    this.calib += dt;
    if (this.calib < 0.6) {
      this.floor += (level - this.floor) * 0.2;
      this.lowFloor += (low - this.lowFloor) * 0.2;
      return this.strength;
    }
    var k = this.strength < 0.05 ? 1 : 0.1;
    if (level < this.floor) this.floor += (level - this.floor) * Math.min(1, dt * 3);
    else this.floor += (level - this.floor) * Math.min(1, dt * 0.08 * k);
    if (low < this.lowFloor) this.lowFloor += (low - this.lowFloor) * Math.min(1, dt * 3);
    else this.lowFloor += (low - this.lowFloor) * Math.min(1, dt * 0.08 * k);

    var above = level - this.floor;
    var voiceGate = 1 - smoothstep(0.32, 0.55, this.voice);
    var hiss = smoothstep(7, 24, above) * smoothstep(0.18, 0.36, flat);
    var wind = smoothstep(14, 32, low - this.lowFloor);
    var score = Math.max(hiss, wind * 0.95) * voiceGate;
    this.raw = score;

    if (score > 0.18) this.onTime = Math.min(0.3, this.onTime + dt);
    else this.onTime = Math.max(0, this.onTime - dt * 2.5);
    var target = this.onTime > 0.09 ? Math.min(1, 0.35 + score * 0.8) : 0;
    var rate = target > this.strength ? 6 : 2.6;
    this.strength += (target - this.strength) * Math.min(1, dt * rate);
    if (this.strength < 0.01) this.strength = 0;
    return this.strength;
  };

  // 归一化自相关的最大值（80–400Hz 的基频范围）：说话 / 哼唱 > 0.5，气流噪声 < 0.3
  BreathMic.prototype.voicing = function () {
    var an = this.an;
    var x = this.wave;
    if (this.waveB) {
      an.getByteTimeDomainData(this.waveB);
      for (var j = 0; j < x.length; j++) x[j] = (this.waveB[j] - 128) / 128;
    } else {
      an.getFloatTimeDomainData(x);
    }
    var h = this.half;
    var n = h.length;
    for (var i = 0; i < n; i++) h[i] = (x[2 * i] + x[2 * i + 1]) * 0.5;
    var sr = this.ctx.sampleRate / 2;
    var lag0 = Math.floor(sr / 400);
    var lag1 = Math.min(n - 64, Math.ceil(sr / 80));
    var best = 0;
    for (var lag = lag0; lag <= lag1; lag++) {
      var m = n - lag;
      var xy = 0;
      var xx = 0;
      var yy = 0;
      for (var k = 0; k < m; k++) {
        var a = h[k];
        var b = h[k + lag];
        xy += a * b;
        xx += a * a;
        yy += b * b;
      }
      var r = xy / (Math.sqrt(xx * yy) + 1e-12);
      if (r > best) best = r;
    }
    return best;
  };

  FG.BreathMic = BreathMic;
})();

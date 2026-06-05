class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.5;
    this._initBound = false;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { /* browser doesn't support Web Audio */ }
  }

  ensureInit() {
    if (!this._initBound) {
      this._initBound = true;
      const handler = () => { this.init(); document.removeEventListener("click", handler); };
      document.addEventListener("click", handler);
    }
  }

  _tone(freq, duration, type = "sine", vol = 0.3) {
    if (this.muted || !this.ctx) return;
    const v = vol * this.volume;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(v, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  playMove() {
    this._tone(800, 0.05, "sine", 0.15);
  }

  playCapture() {
    this._tone(400, 0.08, "triangle", 0.3);
  }

  playCaptureChain(count) {
    for (let i = 0; i < Math.min(count, 4); i++) {
      setTimeout(() => this.playCapture(), i * 50);
    }
  }

  playKingPromotion() {
    this._tone(600, 0.1, "sine", 0.3);
    setTimeout(() => this._tone(900, 0.1, "sine", 0.3), 100);
  }

  playShrink() {
    this._tone(80, 0.3, "sine", 0.25);
  }

  playCoinWin() {
    this._tone(1200, 0.08, "sine", 0.3);
    setTimeout(() => this._tone(1500, 0.08, "sine", 0.3), 60);
  }

  playCoinLoss() {
    this._tone(200, 0.1, "sine", 0.25);
  }

  // --- game-feel sounds (filtered white-noise helper for thuds/impacts) ---
  _noise(duration = 0.15, vol = 0.3, cutoff = 1200) {
    if (this.muted || !this.ctx) return;
    const v = vol * this.volume;
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(v, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    src.connect(filter); filter.connect(gain); gain.connect(this.ctx.destination);
    src.start(); src.stop(this.ctx.currentTime + duration);
  }

  // countdown beats: 3 = low, 2 = mid, 1 = high
  playCountdown(num) {
    const freq = num >= 3 ? 300 : num === 2 ? 420 : 560;
    this._tone(freq, 0.18, "square", 0.3);
  }

  // FIGHT! — noise burst + low hit
  playFight() {
    this._noise(0.28, 0.4, 2200);
    this._tone(110, 0.35, "sawtooth", 0.38);
    setTimeout(() => this._tone(170, 0.18, "square", 0.25), 70);
  }

  // multi-capture chain: escalating pitch per jump
  playMultiCapture(count) {
    const n = Math.min(Math.max(count, 2), 5);
    for (let i = 0; i < n; i++) {
      setTimeout(() => { this._tone(360 + i * 130, 0.09, "triangle", 0.32); this._noise(0.05, 0.14, 1400); }, i * 150);
    }
  }

  // king promotion: rising arpeggio
  playPromotion() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._tone(f, 0.13, "sine", 0.3), i * 95));
  }

  // edge activation: sharp attack, quick decay
  playEdge() {
    this._tone(720, 0.05, "square", 0.3);
    setTimeout(() => this._tone(960, 0.1, "sawtooth", 0.22), 45);
  }

  // momentum shift: low detuned chord swell
  playShift() {
    this._tone(220, 0.5, "sine", 0.16);
    this._tone(223.5, 0.5, "sine", 0.16);
  }

  // match end — win: ascending major triad; lose: descending minor
  playWin() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._tone(f, 0.2, "triangle", 0.32), i * 115));
  }
  playLose() {
    [440, 370, 311, 233].forEach((f, i) => setTimeout(() => this._tone(f, 0.24, "sine", 0.26), i * 130));
  }

  setMuted(m) { this.muted = m; }
  setVolume(v) { this.volume = v; }
}

export const gameAudio = new GameAudio();

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

  setMuted(m) { this.muted = m; }
  setVolume(v) { this.volume = v; }
}

export const gameAudio = new GameAudio();

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

  // ---------------------------------------------------------------
  // Arena-specific sounds (all synthesized — no external files)
  // ---------------------------------------------------------------

  // Ironjaw Provoke — low rumble/growl
  playProvoke() {
    this._tone(65, 0.4, "sawtooth", 0.28);
    this._tone(80, 0.35, "square", 0.18);
    this._noise(0.3, 0.15, 400);
  }

  // Razorwing Swoop — swift whoosh
  playSwoop() {
    if (this.muted || !this.ctx) return;
    const v = 0.25 * this.volume;
    const n = Math.floor(this.ctx.sampleRate * 0.25);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 800; bp.Q.value = 2;
    bp.frequency.linearRampToValueAtTime(3000, this.ctx.currentTime + 0.12);
    bp.frequency.linearRampToValueAtTime(600, this.ctx.currentTime + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.01, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);
    src.connect(bp); bp.connect(g); g.connect(this.ctx.destination);
    src.start(); src.stop(this.ctx.currentTime + 0.25);
  }

  // Embercaster Blast — explosion + crackle
  playBlast() {
    this._noise(0.35, 0.4, 2500);
    this._tone(120, 0.3, "sawtooth", 0.3);
    setTimeout(() => this._noise(0.2, 0.2, 3500), 80);
    setTimeout(() => this._noise(0.12, 0.12, 4000), 180);
  }

  // Warden Aegis — soft energy hum
  playAegis() {
    this._tone(330, 0.5, "sine", 0.15);
    this._tone(495, 0.4, "sine", 0.1);
    this._tone(660, 0.3, "sine", 0.07);
  }

  // Warden Bulwark Pulse — dramatic shield impact (once-per-match)
  playBulwarkPulse() {
    this._noise(0.15, 0.35, 1800);
    this._tone(180, 0.6, "sine", 0.3);
    this._tone(360, 0.5, "triangle", 0.2);
    setTimeout(() => {
      this._tone(240, 0.4, "sine", 0.22);
      this._tone(480, 0.35, "triangle", 0.15);
    }, 120);
  }

  // Hexwright Displace — spatial distortion whoosh
  playDisplace() {
    if (this.muted || !this.ctx) return;
    const v = 0.22 * this.volume;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(400, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start(); osc.stop(this.ctx.currentTime + 0.3);
    this._noise(0.2, 0.18, 1600);
  }

  // Hexwright Glitch — digital static/corruption
  playGlitch() {
    if (this.muted || !this.ctx) return;
    const v = 0.28 * this.volume;
    // Rapid noise bursts to simulate digital glitch
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        const dur = 0.03 + Math.random() * 0.04;
        this._noise(dur, v * (0.5 + Math.random() * 0.5), 2000 + Math.random() * 4000);
        this._tone(200 + Math.random() * 800, dur, "square", 0.12);
      }, i * 45);
    }
  }

  // Ring Out — descending whoosh into void
  playRingOut() {
    if (this.muted || !this.ctx) return;
    const v = 0.3 * this.volume;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, this.ctx.currentTime + 0.8);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.8);
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start(); osc.stop(this.ctx.currentTime + 0.8);
    this._noise(0.6, 0.2, 800);
  }

  // Last Stand — rising heroic brass tone
  playLastStand() {
    // Ascending power chord: C4 → E4 → G4 → C5
    const notes = [262, 330, 392, 523];
    notes.forEach((f, i) => {
      setTimeout(() => {
        this._tone(f, 0.35, "sawtooth", 0.22);
        this._tone(f * 1.005, 0.35, "sawtooth", 0.18); // slight detune for brass feel
      }, i * 130);
    });
  }

  // Collapse Warning — ominous rumble/crack
  playCollapseWarning() {
    this._tone(45, 0.6, "sine", 0.25);
    this._tone(48, 0.6, "sine", 0.2); // beating frequency
    this._noise(0.4, 0.2, 600);
    setTimeout(() => this._noise(0.15, 0.25, 1200), 300); // crack
  }

  // Collapse Void — breaking/crumbling
  playCollapseVoid() {
    this._noise(0.5, 0.3, 1500);
    this._tone(60, 0.5, "sawtooth", 0.2);
    setTimeout(() => this._noise(0.3, 0.25, 800), 150);
    setTimeout(() => this._tone(35, 0.4, "sine", 0.15), 250);
  }

  // Kill — impact + shatter
  playKill() {
    this._noise(0.12, 0.35, 2000);
    this._tone(200, 0.08, "square", 0.3);
    setTimeout(() => this._noise(0.2, 0.2, 3000), 60);
    setTimeout(() => this._tone(120, 0.15, "sine", 0.2), 80);
  }

  // Double Kill — escalating double impact
  playDoubleKill() {
    this.playKill();
    setTimeout(() => {
      this._noise(0.15, 0.4, 2500);
      this._tone(280, 0.1, "square", 0.35);
      setTimeout(() => this._tone(400, 0.08, "triangle", 0.25), 50);
    }, 200);
  }

  // --- breach channel sounds ---
  playChannelTick(meter = 1) {
    const freq = 200 + (meter || 1) * 100;
    this._tone(freq, 0.18, "sine", 0.22);
    setTimeout(() => this._tone(freq * 1.5, 0.12, "triangle", 0.18), 100);
  }

  playChannelHum() {
    this._tone(120, 0.8, "sine", 0.12);
    this._tone(122.5, 0.8, "sine", 0.12);
  }

  playBreachDenied() {
    this._noise(0.25, 0.45, 900);
    this._tone(300, 0.1, "square", 0.3);
    setTimeout(() => {
      this._tone(150, 0.18, "sawtooth", 0.35);
      this._noise(0.15, 0.3, 400);
    }, 120);
  }

  playBreachComplete() {
    this._noise(0.35, 0.5, 3000);
    this._tone(200, 0.4, "sawtooth", 0.3);
    setTimeout(() => { this._tone(400, 0.3, "triangle", 0.32); this._noise(0.15, 0.28, 2200); }, 150);
    setTimeout(() => { this._tone(600, 0.25, "sine", 0.32); this._noise(0.12, 0.22, 2500); }, 300);
    setTimeout(() => { this._tone(800, 0.3, "triangle", 0.28); }, 450);
    setTimeout(() => { this._tone(1200, 0.4, "sine", 0.28); this._noise(0.2, 0.2, 3000); }, 600);
  }

  // --- Identity Forge sounds ---

  // Temperament crystallized — short rising chime (the "it told me who it is" beat)
  playTemperamentChime() {
    this._tone(660, 0.12, "sine", 0.18);
    setTimeout(() => this._tone(880, 0.12, "sine", 0.20), 70);
    setTimeout(() => this._tone(1320, 0.14, "triangle", 0.16), 150);
  }

  // Budget wall — soft "thunk" when a slider can't drain any further
  playWallThunk() {
    this._tone(90, 0.12, "sine", 0.22);
    this._noise(0.06, 0.10, 500);
  }

  setMuted(m) { this.muted = m; }
  setVolume(v) { this.volume = v; }
}

export const gameAudio = new GameAudio();

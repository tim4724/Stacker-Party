'use strict';

const MASTER_VOLUME = 0.12;

class Music {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.muted = false;
    this.bpm = 150;
    this.scheduledSources = new Set();
    this.nextMelodyTime = 0;
    this.nextBassTime = 0;
    this.melodyIndex = 0;
    this.bassIndex = 0;
    this.scheduleTimer = null;
    this.melodyGain = null;
    this.bassGain = null;
    this.octaveGain = null;
    this.masterGain = null;
    this.generation = 0;
    this.passCount = 0;

    // Note frequencies (Hz). Sharps use 's' suffix (e.g. Gs2 = G#2)
    const E2 = 82.41, Gs2 = 103.83, A2 = 110.00;
    const C3 = 130.81, D3 = 146.83, E3 = 164.81, F3 = 174.61, Gs3 = 207.65, A3 = 220.00;
    const A4 = 440.00, B4 = 493.88, C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880.00;
    const R = 0; // rest

    // Korobeiniki Theme A — two phrases, 8 measures total
    // [frequency, duration in eighth notes]
    this.melody = [
      // Phrase 1
      // m1: E5(q) B4(8) C5(8) D5(q) C5(8) B4(8)
      [E5, 2], [B4, 1], [C5, 1], [D5, 2], [C5, 1], [B4, 1],
      // m2: A4(q) A4(8) C5(8) E5(q) D5(8) C5(8)
      [A4, 2], [A4, 1], [C5, 1], [E5, 2], [D5, 1], [C5, 1],
      // m3: B4(q.) C5(8) D5(q) E5(q)
      [B4, 3], [C5, 1], [D5, 2], [E5, 2],
      // m4: C5(q) A4(q) A4(q) rest(q)
      [C5, 2], [A4, 2], [A4, 2], [R, 2],
      // Phrase 2
      // m5: rest(8) D5(q) F5(8) A5(q) G5(8) F5(8)
      [R, 1], [D5, 2], [F5, 1], [A5, 2], [G5, 1], [F5, 1],
      // m6: E5(q.) C5(8) E5(q) D5(8) C5(8)
      [E5, 3], [C5, 1], [E5, 2], [D5, 1], [C5, 1],
      // m7: B4(q.) C5(8) D5(q) E5(q)
      [B4, 3], [C5, 1], [D5, 2], [E5, 2],
      // m8: C5(q) A4(q) A4(q) rest(q)
      [C5, 2], [A4, 2], [A4, 2], [R, 2],
    ];

    // Bass line: octave bounce pattern following chord roots
    this.bass = [
      // m1: Em
      [E2, 2], [E3, 2], [E2, 2], [E3, 2],
      // m2: Am
      [A2, 2], [A3, 2], [A2, 2], [A3, 2],
      // m3: G#dim -> Em
      [Gs2, 2], [Gs3, 2], [E2, 2], [E3, 2],
      // m4: Am
      [A2, 2], [A3, 2], [A2, 2], [R, 2],
      // m5: Dm -> F
      [D3, 2], [D3, 2], [F3, 2], [F3, 2],
      // m6: C -> E
      [C3, 2], [C3, 2], [E3, 2], [E3, 2],
      // m7: G#dim -> Em
      [Gs2, 2], [Gs3, 2], [E2, 2], [E3, 2],
      // m8: Am
      [A2, 2], [A3, 2], [A2, 2], [R, 2],
    ];
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch (e) {
      console.warn('Failed to create AudioContext:', e);
      return;
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_VOLUME;
    this.masterGain.connect(this.ctx.destination);

    this.melodyGain = this.ctx.createGain();
    this.melodyGain.gain.value = 0.45;
    this.melodyGain.connect(this.masterGain);

    this.bassGain = this.ctx.createGain();
    this.bassGain.gain.value = 0;
    this.bassGain.connect(this.masterGain);

    // Octave doubling voice — melody played one octave lower
    this.octaveGain = this.ctx.createGain();
    this.octaveGain.gain.value = 0;
    this.octaveGain.connect(this.masterGain);
  }

  start() {
    this.init();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(e => console.warn('AudioContext resume failed:', e));
    }

    // Cancel any existing scheduler before starting a new one
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }

    this.generation++;
    this.playing = true;
    this.melodyIndex = 0;
    this.bassIndex = 0;
    this.passCount = 0;
    this.scheduledSources = new Set();
    this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.masterGain.gain.setValueAtTime(MASTER_VOLUME, this.ctx.currentTime);

    // Start bass and octave doubling silent — they fade in on later passes
    this.bassGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.bassGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.octaveGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.octaveGain.gain.setValueAtTime(0, this.ctx.currentTime);

    this.nextMelodyTime = this.ctx.currentTime + 0.1;
    this.nextBassTime = this.ctx.currentTime + 0.1;
    this.schedule();
  }

  stop() {
    this.playing = false;
    const gen = ++this.generation;

    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }

    // Smooth fade-out over 0.4s
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + 0.4);
    }

    // Stop all oscillators after fade completes
    setTimeout(() => {
      if (this.generation !== gen) return;
      for (const src of this.scheduledSources) {
        try { src.stop(); } catch (e) { /* already stopped */ }
      }
      this.scheduledSources.clear();
    }, 450);
  }

  schedule() {
    if (!this.playing) return;

    const eighthDuration = 60 / this.bpm / 2;
    const lookahead = 0.2;
    const melodyLen = this.melody.length;
    const bassLen = this.bass.length;

    // Schedule melody
    while (this.nextMelodyTime < this.ctx.currentTime + lookahead) {
      // Check for pass boundary
      if (this.melodyIndex > 0 && this.melodyIndex % melodyLen === 0) {
        this.passCount++;
        this.updateArrangement(this.nextMelodyTime);
        // Sync bass to melody phrase boundary when bass first enters
        if (this.passCount === 1) {
          this.nextBassTime = this.nextMelodyTime;
          this.bassIndex = 0;
        }
      }

      const idx = this.melodyIndex % melodyLen;
      const [freq, eighths] = this.melody[idx];
      const duration = eighths * eighthDuration;

      if (freq > 0 && !this.muted) {
        const waveform = this.getMelodyWaveform();
        const gate = this.getGateLength();
        this._playOsc(freq, this.nextMelodyTime, duration * gate, this.melodyGain, waveform);

        // Octave doubling: play melody one octave lower
        if (this.passCount >= 5) {
          this._playOsc(freq / 2, this.nextMelodyTime, duration * gate, this.octaveGain, waveform);
        }
      }

      this.nextMelodyTime += duration;
      this.melodyIndex++;
    }

    // Schedule bass (skip node creation while silent)
    if (this.passCount < 1) {
      this.nextBassTime = this.ctx.currentTime + lookahead;
    } else {
      while (this.nextBassTime < this.ctx.currentTime + lookahead) {
        const idx = this.bassIndex % bassLen;
        const [freq, eighths] = this.bass[idx];
        const duration = eighths * eighthDuration;

        if (freq > 0 && !this.muted) {
          const bassWaveform = this.getBassWaveform();
          this._playOsc(freq, this.nextBassTime, duration * 0.85, this.bassGain, bassWaveform);
        }

        this.nextBassTime += duration;
        this.bassIndex++;
      }
    }

    this.scheduleTimer = setTimeout(() => this.schedule(), 50);
  }

  _playOsc(freq, time, duration, gainNode, type) {
    const osc = this.ctx.createOscillator();
    const noteGain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.value = freq;

    const release = Math.min(0.02, duration * 0.2);
    noteGain.gain.setValueAtTime(0.001, time);
    noteGain.gain.linearRampToValueAtTime(1, time + 0.01);
    noteGain.gain.setValueAtTime(1, time + duration - release);
    noteGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(noteGain);
    noteGain.connect(gainNode);

    osc.start(time);
    osc.stop(time + duration + 0.01);

    this.scheduledSources.add(osc);
    osc.onended = () => {
      noteGain.disconnect();
      this.scheduledSources.delete(osc);
    };
  }

  updateArrangement(beatTime) {
    const fadeTime = 2;

    if (this.passCount === 1) {
      // Pass 1: fade in bass
      this.bassGain.gain.cancelScheduledValues(beatTime);
      this.bassGain.gain.setValueAtTime(0, beatTime);
      this.bassGain.gain.linearRampToValueAtTime(0.35, beatTime + fadeTime);
    } else if (this.passCount === 5) {
      // Pass 5: fade in octave doubling
      this.octaveGain.gain.cancelScheduledValues(beatTime);
      this.octaveGain.gain.setValueAtTime(0, beatTime);
      this.octaveGain.gain.linearRampToValueAtTime(0.25, beatTime + fadeTime);
    }
  }

  // --- Variation parameters with different cycle lengths ---
  // Using coprime-ish periods (2, 3, 4) so combinations don't repeat
  // for 12 passes (~2:34), creating emergent variety.

  getMelodyWaveform() {
    // 3-way cycle, changes every 2 passes: square → sawtooth → triangle
    const cycle = Math.floor(this.passCount / 2) % 3;
    return ['square', 'sawtooth', 'triangle'][cycle];
  }

  getBassWaveform() {
    // 3-way cycle, changes every 3 passes: triangle → square → sawtooth
    const cycle = Math.floor(this.passCount / 3) % 3;
    return ['triangle', 'square', 'sawtooth'][cycle];
  }

  getGateLength() {
    // Alternates every 4 passes: legato ↔ staccato
    const cycle = Math.floor(this.passCount / 4) % 2;
    return cycle === 0 ? 0.9 : 0.75;
  }

  setSpeed(level) {
    this.bpm = Math.min(240, 150 + (level - 1) * 3);
  }
}

Music.MASTER_VOLUME = MASTER_VOLUME;
window.Music = Music;

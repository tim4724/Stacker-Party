'use strict';

// Music player — loops an audio track with playback rate scaling by level.
// Track: "Lunar Joyride" by FoxSynergy (CC-BY 3.0)

const MASTER_VOLUME = 0.50;

class Music {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.muted = false;
    this.masterGain = null;
    this.source = null;
    this.buffer = null;
    this.generation = 0;
    this._loaded = false;
    this._rate = 1.0;
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

    // When the browser unblocks audio (e.g. Firefox tab permission change),
    // the context may transition to 'running' on its own, or it may just
    // allow future resume() calls to succeed.  Handle both cases.
    this.ctx.addEventListener('statechange', () => {
      if (this.ctx.state === 'running') {
        this._removeRetryListeners();
        if (this.playing && !this.source && this.buffer) {
          this._startSource();
        }
      }
    });

    this._loadTrack();
  }

  async _loadTrack() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const response = await fetch('shared/music/lunar-joyride.mp3');
      const arrayBuffer = await response.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
      // If start() was called before load finished, begin now
      if (this.playing && !this.source) {
        this._startSource();
      }
    } catch (e) {
      console.warn('Failed to load music:', e);
      this._loaded = false;
    }
  }

  _startSource() {
    if (!this.buffer) return;
    this._stopSource();

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;
    source.playbackRate.value = this._rate;
    source.detune.value = -Math.log2(this._rate) * 1200;
    source.connect(this.masterGain);
    source.start(0);
    this.source = source;
    if (this.ctx.state === 'running') {
      this._removeRetryListeners();
    }
  }

  _addRetryListeners() {
    if (this._retryResume) return;
    this._retryResume = () => {
      if (this.ctx && this.ctx.state === 'suspended' && this.playing) {
        this.ctx.resume().catch(() => {});
      }
    };
    document.addEventListener('click', this._retryResume, { passive: true });
    document.addEventListener('keydown', this._retryResume, { passive: true });
  }

  _removeRetryListeners() {
    if (this._retryResume) {
      document.removeEventListener('click', this._retryResume);
      document.removeEventListener('keydown', this._retryResume);
      this._retryResume = null;
    }
  }

  _stopSource() {
    if (!this.source) return;
    try { this.source.stop(); } catch (e) { /* already stopped */ }
    this.source.disconnect();
    this.source = null;
  }

  start() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(e => console.warn('AudioContext resume failed:', e));
      // Firefox doesn't auto-resume suspended contexts when the user changes
      // the autoplay permission — it just allows future resume() calls.
      // Retry resume on any user interaction so audio starts without a reload.
      this._addRetryListeners();
    }

    this.generation++;
    this.playing = true;
    this._rate = 1.0;

    this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.masterGain.gain.setValueAtTime(this.muted ? 0 : MASTER_VOLUME, this.ctx.currentTime);

    if (this.buffer) {
      this._startSource();
    } else if (!this._loaded) {
      this._loadTrack();
    }
  }

  stop() {
    this.playing = false;
    this._removeRetryListeners();
    const gen = ++this.generation;

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + 0.4);
    }

    setTimeout(() => {
      if (this.generation !== gen) return;
      this._stopSource();
    }, 450);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._removeRetryListeners();
    const gen = ++this.generation;

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + 0.3);

      setTimeout(() => {
        if (this.generation !== gen) return;
        this.ctx.suspend().catch(() => {});
      }, 350);
    }
  }

  resume() {
    if (this.playing) return;
    if (!this.ctx) return;

    this.generation++;
    this.playing = true;

    this.ctx.resume().then(() => {
      const targetVolume = this.muted ? 0 : MASTER_VOLUME;
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.masterGain.gain.linearRampToValueAtTime(targetVolume, this.ctx.currentTime + 0.3);
    }).catch(e => console.warn('AudioContext resume failed:', e));

    if (this.ctx.state === 'suspended') {
      this._addRetryListeners();
    }
  }

  setSpeed(level) {
    const maxLevel = GameConstants.MAX_SPEED_LEVEL;
    const clamped = Math.min(level, maxLevel);
    this._rate = 0.95 + (clamped - 1) * (0.4 / 14);
    if (this.source) {
      this.source.playbackRate.setTargetAtTime(this._rate, this.ctx.currentTime, 0.1);
      this.source.detune.setTargetAtTime(-Math.log2(this._rate) * 1200, this.ctx.currentTime, 0.1);
    }
  }
}

Music.MASTER_VOLUME = MASTER_VOLUME;
window.Music = Music;

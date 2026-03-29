'use strict';

// =====================================================================
// Display Audio — music initialization and countdown beeps
// Depends on: DisplayState.js (music, muted globals), Music.js
// =====================================================================

function initMusic() {
  if (!music) {
    music = new Music();
  }
  music.init();
  music.muted = muted;
}

function playCountdownBeep(isGo) {
  if (muted) return;
  if (!music || !music.ctx) return;
  var actx = music.ctx;
  if (actx.state === 'suspended') actx.resume();

  var osc = actx.createOscillator();
  var gain = actx.createGain();
  osc.connect(gain);
  gain.connect(actx.destination);

  if (isGo) {
    osc.type = 'square';
    osc.frequency.setValueAtTime(600, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.3);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.3);
  } else {
    osc.type = 'square';
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.15, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.12);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.12);
  }
}

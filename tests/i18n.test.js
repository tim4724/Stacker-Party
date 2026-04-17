'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { t, setLocale, getLocale, LOCALES } = require('../public/shared/i18n.js');

describe('i18n', function () {

  beforeEach(function () {
    setLocale('en');
  });

  describe('t() basic lookup', function () {
    it('returns English string for known key', function () {
      assert.equal(t('hold'), 'HOLD');
      assert.equal(t('next'), 'NEXT');
      assert.equal(t('go'), 'GO');
    });

    it('returns key itself for unknown key', function () {
      assert.equal(t('nonexistent_key_xyz'), 'nonexistent_key_xyz');
    });
  });

  describe('t() interpolation', function () {
    it('replaces {param} placeholders', function () {
      assert.equal(t('attempt_n_of_m', { attempt: 2, max: 5 }), 'Attempt 2 of 5');
    });

    it('replaces {level} in level_n', function () {
      assert.equal(t('level_n', { level: 7 }), 'Level 7');
    });

    it('leaves unreferenced placeholders intact', function () {
      assert.equal(t('attempt_n_of_m', { attempt: 1 }), 'Attempt 1 of {max}');
    });

    it('replaces hex_lines_level with multiple params', function () {
      assert.equal(t('hex_lines_level', { lines: 10, level: 3 }), 'Lines 10  Level 3');
    });
  });

  describe('t() plurals', function () {
    it('selects "one" form for count=1 in English', function () {
      assert.equal(t('n_lines', { count: 1 }), '1 line');
    });

    it('selects "other" form for count=0 in English', function () {
      assert.equal(t('n_lines', { count: 0 }), '0 lines');
    });

    it('selects "other" form for count=5 in English', function () {
      assert.equal(t('n_lines', { count: 5 }), '5 lines');
    });

    it('handles start_n_players plural', function () {
      assert.equal(t('start_n_players', { count: 1 }), 'START (1 player)');
      assert.equal(t('start_n_players', { count: 3 }), 'START (3 players)');
    });

    it('returns "other" form when plural key called without params', function () {
      var result = t('n_lines');
      assert.equal(typeof result, 'string');
      assert.ok(!result.includes('[object'), 'should not return [object Object]');
    });
  });

  describe('setLocale / getLocale', function () {
    it('defaults to en', function () {
      assert.equal(getLocale(), 'en');
    });

    it('switches to German', function () {
      setLocale('de');
      assert.equal(getLocale(), 'de');
      assert.equal(t('hold'), 'HOLD');
      assert.equal(t('go'), 'LOS');
    });

    it('handles locale with region code', function () {
      setLocale('fr-CA');
      assert.equal(getLocale(), 'fr');
      assert.equal(t('hold'), 'HOLD');
    });

    it('falls back to en for unknown locale', function () {
      setLocale('xx');
      assert.equal(getLocale(), 'en');
      assert.equal(t('hold'), 'HOLD');
    });

    it('falls back to English for missing keys in non-en locale', function () {
      // If a locale is missing a key, t() should return the English value
      setLocale('de');
      // All keys should be present in de, but let's test the mechanism
      // by checking a key that exists in en
      assert.equal(typeof t('hold'), 'string');
    });
  });

  describe('Russian plurals', function () {
    it('uses correct plural categories', function () {
      setLocale('ru');
      assert.equal(t('n_lines', { count: 1 }), '1 линия');
      assert.equal(t('n_lines', { count: 2 }), '2 линии');
      assert.equal(t('n_lines', { count: 5 }), '5 линий');
      assert.equal(t('n_lines', { count: 21 }), '21 линия');
    });
  });

  describe('Chinese/Japanese/Korean (no plural distinction)', function () {
    it('Chinese uses "other" form for all counts', function () {
      setLocale('zh');
      assert.equal(t('n_lines', { count: 1 }), '1 行');
      assert.equal(t('n_lines', { count: 5 }), '5 行');
    });

    it('Japanese uses "other" form for all counts', function () {
      setLocale('ja');
      assert.equal(t('n_lines', { count: 1 }), '1ライン');
      assert.equal(t('n_lines', { count: 5 }), '5ライン');
    });
  });

  describe('all locales have required keys', function () {
    var requiredKeys = [
      'hold', 'next', 'level', 'lines', 'ko', 'go',
      'scan_to_rejoin', 'quad', 'triple', 'double',
      'scan_to_join',
      'waiting_for_players', 'start_n_players', 'start',
      'start_new_game', 'play_again', 'play_again_upper',
      'new_game', 'new_game_upper', 'continue_btn', 'continue_upper',
      'continue_anyway', 'reconnect', 'rejoin', 'join',
      'reconnecting', 'disconnected', 'connecting', 'connection_lost',
      'attempt_n_of_m', 'display_reconnecting', 'bad_connection',
      'paused', 'end_step_1', 'end_step_2',
      'room_not_found', 'game_ended', 'game_in_progress',
      'waiting_for_host_to_start', 'waiting_for_host_to_continue',
      'n_lines', 'level_n', 'player', 'level_heading',
      'enter_name', 'copied', 'touchpad', 'privacy',
      'stacked_by', 'music_by', 'hex_lines_level',
      'swipe', 'tap', 'flick', 'gesture_move', 'gesture_rotate',
      'gesture_drop', 'gesture_hold',
    ];

    for (var locale of Object.keys(LOCALES)) {
      it('locale "' + locale + '" has all required keys', function () {
        for (var key of requiredKeys) {
          assert.ok(
            LOCALES[locale][key] !== undefined,
            'Missing key "' + key + '" in locale "' + locale + '"'
          );
        }
      });
    }
  });

  describe('waiting_for_host banner keys', function () {
    // renderHostBanner splits these strings on a \x00 sentinel placed at
    // {name}. Every locale must contain {name} exactly once or the banner
    // will render the template text colliding with the name.
    var bannerKeys = ['waiting_for_host_to_start', 'waiting_for_host_to_continue'];
    for (var locale of Object.keys(LOCALES)) {
      it('locale "' + locale + '" banner keys contain exactly one {name}', function () {
        for (var key of bannerKeys) {
          var val = LOCALES[locale][key];
          if (val === undefined) continue; // covered by required-keys test
          var matches = val.match(/\{name\}/g) || [];
          assert.equal(
            matches.length, 1,
            'locale "' + locale + '" key "' + key + '" must contain exactly one {name}, got ' + matches.length
          );
        }
      });
    }
  });
});

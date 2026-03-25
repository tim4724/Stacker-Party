'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STYLE_TIERS, getStyleTier } = require('../public/shared/theme');

describe('getStyleTier', () => {
  it('level 0 returns NORMAL', () => {
    assert.equal(getStyleTier(0), STYLE_TIERS.NORMAL);
  });

  it('level 1 returns NORMAL', () => {
    assert.equal(getStyleTier(1), STYLE_TIERS.NORMAL);
  });

  it('level 5 returns NORMAL', () => {
    assert.equal(getStyleTier(5), STYLE_TIERS.NORMAL);
  });

  it('level 6 returns PILLOW', () => {
    assert.equal(getStyleTier(6), STYLE_TIERS.PILLOW);
  });

  it('level 10 returns PILLOW', () => {
    assert.equal(getStyleTier(10), STYLE_TIERS.PILLOW);
  });

  it('level 11 returns NEON_FLAT', () => {
    assert.equal(getStyleTier(11), STYLE_TIERS.NEON_FLAT);
  });

  it('level 20 returns NEON_FLAT', () => {
    assert.equal(getStyleTier(20), STYLE_TIERS.NEON_FLAT);
  });

  it('level 99 returns NEON_FLAT', () => {
    assert.equal(getStyleTier(99), STYLE_TIERS.NEON_FLAT);
  });
});

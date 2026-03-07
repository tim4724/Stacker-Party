'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { MSG } = require('../public/shared/protocol.js');

describe('Protocol messages', () => {
  test('exports SOFT_DROP_END for explicit soft-drop release', () => {
    assert.equal(MSG.SOFT_DROP_END, 'soft_drop_end');
    assert.notEqual(MSG.SOFT_DROP_END, MSG.SOFT_DROP);
  });
});

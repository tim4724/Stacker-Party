'use strict';

// CI config drift guards: the two things under .github/ that are declared once
// and consumed from several workflows, where a second copy is silently wrong
// rather than loudly broken.
//
//   1. The Node version. Declared in .nvmrc, read by nine setup-node steps and
//      the two Dockerfile stages. A workflow pinning its own major would test
//      the app on a different runtime than the image that ships it.
//
//   2. The branch -> preview name mapping. Declared in
//      .github/actions/branch-slug, used by the workflows that create, deploy
//      into, advertise and delete a preview namespace. It lived inline in four
//      places and had already drifted into two behaviours: the copies that
//      skipped the 50-char truncation made Preview Cleanup delete a namespace
//      that never existed, leaking the real one forever (silently, courtesy of
//      --ignore-not-found).
//
// setup-node reads .nvmrc natively; the Dockerfile cannot, so this is the link.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NVMRC = read('.nvmrc').trim();
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ name: f, yaml: fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8') }));

test('.nvmrc pins a bare major version', () => {
  assert.match(NVMRC, /^\d+$/, '.nvmrc should hold just the major, e.g. "24"');
});

test('every Dockerfile stage builds on the .nvmrc major', () => {
  const froms = [...read('Dockerfile').matchAll(/^FROM node:(\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length > 0, 'no "FROM node:" line found in the Dockerfile');
  for (const tag of froms) {
    assert.equal(
      tag.split('-')[0],
      NVMRC,
      `Dockerfile builds on node:${tag} but .nvmrc says ${NVMRC}`
    );
  }
});

test('no workflow pins its own Node version instead of reading .nvmrc', () => {
  for (const { name, yaml } of workflows) {
    assert.equal(
      /^\s*node-version:/m.test(yaml),
      false,
      `${name} pins node-version directly; use "node-version-file: .nvmrc"`
    );
  }
});

test('the branch -> preview slug pipeline exists in exactly one place', () => {
  // The distinctive part of the mapping: everything that slugs a branch name
  // runs this substitution, so a second copy of it is a second implementation.
  const NEEDLE = 's#[^a-z0-9-]#-#g';
  const owner = path.join('.github', 'actions', 'branch-slug', 'action.yml');
  assert.ok(read(owner).includes(NEEDLE), `${owner} no longer slugs branch names`);

  const copies = workflows.filter((w) => w.yaml.includes(NEEDLE)).map((w) => w.name);
  assert.deepEqual(
    copies,
    [],
    `these workflows inline the slug instead of using ./.github/actions/branch-slug: ${copies.join(', ')}`
  );
});

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('the manifest identifies Reflect and declares the required install metadata', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf8'));
  const version = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/;
  assert.equal(manifest.id, 'reflect');
  for (const field of ['name', 'description', 'author']) {
    assert.equal(typeof manifest[field], 'string', `${field} must be a string`);
    assert.ok(manifest[field].trim(), `${field} must have a value`);
  }
  for (const field of ['version', 'minAppVersion']) {
    assert.match(manifest[field], version, `${field} must use x.y.z format`);
  }
  assert.equal(typeof manifest.isDesktopOnly, 'boolean');
});

test('the install includes a nonempty stylesheet', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(css.trim(), 'styles.css must have content');
});

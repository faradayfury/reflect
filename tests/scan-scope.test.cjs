'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdir, mkdtemp, rename, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'main.js'), 'utf8');

async function fixture(t) {
  let now = 1000;
  const { scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, DiscoveryQueue } = vm.runInNewContext(
    source + '\n({ scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, DiscoveryQueue })', {
      module: {}, AbortController, Buffer, process, setTimeout: () => 1, clearTimeout() {},
      Date: class extends Date { static now() { return now; } },
      require(name) {
        if (name === 'obsidian') return {
          Platform: { isDesktopApp: true }, Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {},
          getFrontMatterInfo: () => ({ frontmatter: '' })
        };
        if (['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'].includes(name)) return require(name);
        throw Error('Unexpected dependency: ' + name);
      }
    });
  const files = [
    ['Public/one.md', 'The first published passage covers an interesting observation.'],
    ['Public/two.md', 'The second published passage covers an interesting observation.'],
    ['Private/private.md', 'Private material should never leave the approved scope.']
  ].map(([path, text]) => ({ path, text, basename: path.split('/').at(-1).slice(0, -3), extension: 'md', stat: { mtime: 1, size: text.length } }));
  const temp = await mkdtemp(join(tmpdir(), 'reflect-scope-test-'));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const root = join(temp, 'vault');
  await Promise.all(['Public', 'Private'].map(folder => mkdir(join(root, folder), { recursive: true })));
  await Promise.all(files.map(file => writeFile(join(root, file.path), file.text)));
  const app = {
    vault: {
      adapter: { getBasePath: () => root },
      getMarkdownFiles: () => files,
      getAbstractFileByPath: path => files.find(file => file.path === path),
      read: async file => file.text
    },
    metadataCache: { getFileCache: () => null }
  };
  return { app, files, root, temp, scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, DiscoveryQueue, advance: () => { now += 10000; } };
}

test('Scan and Ask only send the approved notes and current approved citations', async t => {
  const { app, files, scanNoteScope, findQuestionEvidence, scanHistoricalIdeas } = await fixture(t);
  await assert.rejects(scanNoteScope(app, 'Privaet'), /Check the folder path/);
  await assert.rejects(scanNoteScope(app, '/'), /relative to the vault/);
  const scope = await scanNoteScope(app, 'private/');
  assert.deepEqual([...scope.keys()], ['Public/one.md', 'Public/two.md']);
  files.push({ ...files[0], path: 'Public/new.md', basename: 'new', text: 'Note created after the user reviewed the list.' });
  const seen = [];
  const connection = {
    noteBatch: 1000, parallel: 1,
    async run(prompt) {
      seen.push(prompt);
      if (prompt.includes('Return [{id, quote}]')) {
        return [{ id: 1, quote: files[0].text }, { id: 2, quote: files[1].text }];
      }
      return [{ idea: 'I1', title: 'Observation', synthesis: 'A pattern in the evidence.', evidence: [0, 1] }];
    }
  };
  const signal = new AbortController().signal;
  const findings = await findQuestionEvidence(app, 'What changed?', signal, () => {}, connection, scope);
  assert.equal(findings.length, 1);
  const drafts = [{ id: 'private-cache-id', title: 'Private cached title', synthesis: 'Private cached summary',
    evidence: [{ path: files[2].path, quote: files[2].text }, { path: files[0].path, quote: files[0].text }] }];
  const proposals = await scanHistoricalIdeas(app, drafts, signal, () => {}, connection, scope);
  assert.equal(proposals[0]?.idea, 'private-cache-id');
  assert.equal(seen.length, 4);
  assert.ok(seen.every(prompt => !/Private material|Private cached|private-cache-id|created after/.test(prompt)));
});

test('the scope does not substitute a new file at the same path', async t => {
  const { app, files, scanNoteScope, findQuestionEvidence } = await fixture(t);
  const scope = await scanNoteScope(app, 'Private');
  files[0] = { ...files[0], text: 'Unapproved replacement file.' };
  const findings = await findQuestionEvidence(app, 'What changed?', new AbortController().signal, () => {}, {
    noteBatch: 1000, parallel: 1,
    run() { assert.fail('A run with only one approved note should never call the provider.'); }
  }, scope);
  assert.equal(findings.length, 0);
});

test('symlinks cannot enter or replace approved scan sources', { skip: process.platform === 'win32' }, async t => {
  const { app, files, root, temp, scanNoteScope, findQuestionEvidence } = await fixture(t);
  const outside = join(temp, 'external.md');
  await writeFile(outside, 'External private material.');
  await symlink(outside, join(root, 'Public/external.md'));
  await symlink(join(root, 'Private/private.md'), join(root, 'Public/alias.md'));
  files.push(...['external', 'alias'].map(basename => ({ ...files[0], basename, path: 'Public/' + basename + '.md' })));
  const scope = await scanNoteScope(app, 'Private');
  assert.deepEqual([...scope.keys()], ['Public/one.md', 'Public/two.md']);
  await rename(join(root, 'Public/one.md'), join(root, 'Public/one-original.md'));
  await symlink(outside, join(root, 'Public/one.md'));
  const findings = await findQuestionEvidence(app, 'What changed?', new AbortController().signal, () => {}, {
    noteBatch: 1000, parallel: 1,
    run() { assert.fail('The replacement must be skipped, leaving too few notes to send.'); }
  }, scope);
  assert.equal(findings.length, 0);
});

test('background discovery is opt-in and stopping it aborts the active request', async t => {
  const { app, DiscoveryQueue } = await fixture(t);
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  let sent = 0;
  const plugin = {
    app, backgroundOllamaEnabled: false, refresh() {},
    requestOllama(_request, signal, { background }) {
      sent++;
      assert.equal(background, true);
      started(signal);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  };
  const queue = new DiscoveryQueue(plugin, []);
  queue.start();
  await queue.work();
  assert.equal(sent, 0);
  queue.setBackgroundEnabled(true);
  const running = queue.work();
  const signal = await requestStarted;
  queue.stop();
  await running;
  assert.equal(sent, 1);
  assert.equal(signal.aborted, true);
});

test('changing a candidate or local preference refreshes discovery for another note', async t => {
  const { app, files, root, DiscoveryQueue, advance } = await fixture(t);
  const sent = [];
  const plugin = {
    app, backgroundOllamaEnabled: true, refresh() {}, saveData: async () => {},
    async requestOllama(request) {
      sent.push(request);
      return { json: { message: { content: '{"proposals":[]}' } } };
    }
  };
  const queue = new DiscoveryQueue(plugin, []);
  queue.start();
  for (const _ of files) await queue.work();
  assert.equal(sent.length, 3);
  files[1].text = 'A different observation in the second public note.';
  files[1].stat.mtime++;
  await writeFile(join(root, files[1].path), files[1].text);
  queue.changed(files[1]);
  advance();
  for (const _ of files) await queue.work();
  assert.ok(sent.slice(3).some(request => request.messages[1].content.includes(files[0].text) &&
    request.messages[1].content.includes(files[1].text)));
  const before = sent.length;
  await queue.persist({ preferences: 'New local preference' });
  advance();
  for (const _ of files) await queue.work();
  assert.equal(sent.length, before + 3);
  assert.ok(sent.slice(before).every(request => request.messages.some(message => message.content.includes('New local preference'))));
  queue.stop();
});

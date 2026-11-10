'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'main.js'), 'utf8');

function fixture() {
  const { scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, recentSourceFiles, DiscoveryQueue } = vm.runInNewContext(
    source + '\n({ scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, recentSourceFiles, DiscoveryQueue })', {
      module: {}, AbortController, Buffer, TextEncoder, process, setTimeout, clearTimeout,
      require(name) {
        if (name === 'obsidian') return {
          Platform: { isDesktopApp: true }, Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {},
          getFrontMatterInfo: () => ({ frontmatter: '' })
        };
        if (name === 'node:crypto') return require(name);
        throw Error('Unexpected dependency: ' + name);
      }
    });
  const folders = ['Public', 'Private'].map(path => ({ path, children: [] }));
  const files = [
    ['Public/one.md', 'The first published passage covers an interesting observation.'],
    ['Public/two.md', 'The second published passage covers an interesting observation.'],
    ['Private/private.md', 'Private material should never leave the approved scope.']
  ].map(([path, text]) => {
    const parent = folders.find(folder => path.startsWith(folder.path + '/'));
    const file = { path, text, parent, basename: path.split('/').at(-1).slice(0, -3), extension: 'md',
      stat: { ctime: 1, mtime: 1, size: text.length } };
    parent.children.push(file);
    return file;
  });
  const app = {
    vault: {
      getMarkdownFiles() { assert.fail('Selecting or scanning notes must not enumerate the vault.'); },
      getAbstractFileByPath: path => files.find(file => file.path === path) || folders.find(folder => folder.path === path),
      read: async file => file.text
    },
    workspace: { getActiveFile: () => files[1], getLastOpenFiles: () => [files[0].path, files[1].path, 'Removed.md'] },
    metadataCache: { getFileCache: () => null, resolvedLinks: {} }
  };
  return { app, files, scanNoteScope, findQuestionEvidence, scanHistoricalIdeas, recentSourceFiles, DiscoveryQueue };
}

function cannotSend() {
  return {
    noteBatch: 1000, parallel: 1,
    run() { assert.fail('A stale selection should never call the provider.'); }
  };
}

test('Scan and Ask only send the selected snapshot and approved citations', async () => {
  const { app, files, scanNoteScope, findQuestionEvidence, scanHistoricalIdeas } = fixture();
  await assert.rejects(scanNoteScope(app, 'Privaet'), /Check the vault path/);
  await assert.rejects(scanNoteScope(app, '/'), /Choose specific paths inside the vault/);
  await assert.rejects(scanNoteScope(app, 'Public/../Private'), /Choose specific paths inside the vault/);
  const scope = await scanNoteScope(app, 'Public/\nPublic/one.md');
  assert.deepEqual([...scope.keys()], ['Public/one.md', 'Public/two.md']);
  assert.equal(scope.get('Public/one.md').text, files[0].text);
  assert.ok(Object.isFrozen(scope.get('Public/one.md')));
  const added = { ...files[0], path: 'Public/new.md', basename: 'new', text: 'Note created after the user reviewed the list.' };
  files.push(added);
  added.parent.children.push(added);
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

test('explicit note paths never include adjacent files', async () => {
  const { app, scanNoteScope, recentSourceFiles } = fixture();
  const scope = await scanNoteScope(app, 'Private/private.md\nPublic/one.md');
  assert.deepEqual([...scope.keys()], ['Private/private.md', 'Public/one.md']);
  assert.deepEqual([...recentSourceFiles(app)].map(file => file.path), ['Public/two.md', 'Public/one.md']);
});

test('replacing a selected TFile invalidates the approved run', async () => {
  const { app, files, scanNoteScope, findQuestionEvidence } = fixture();
  const scope = await scanNoteScope(app, 'Public');
  files[0] = { ...files[0], text: 'Unapproved replacement file.' };
  await assert.rejects(findQuestionEvidence(app, 'What changed?', new AbortController().signal, () => {},
    cannotSend(), scope), /changed or moved after the preview/);
});

test('content changed behind an unchanged Vault file invalidates the approved run', async () => {
  const { app, files, scanNoteScope, scanHistoricalIdeas } = fixture();
  const scope = await scanNoteScope(app, 'Public');
  files[0].text = 'Different material returned by the same Vault file.';
  await assert.rejects(scanHistoricalIdeas(app, [], new AbortController().signal, () => {},
    cannotSend(), scope), /changed or moved after the preview/);
});

test('edits during a model run cannot replace the approved prompt text', async () => {
  const { app, files, scanNoteScope, findQuestionEvidence } = fixture();
  files[0].text = 'A longer approved note. '.repeat(23);
  files[0].stat.size = files[0].text.length;
  const scope = await scanNoteScope(app, 'Public');
  const sent = [];
  const originalSecondNote = files[1].text;
  await findQuestionEvidence(app, 'What changed?', new AbortController().signal, () => {}, {
    noteBatch: 1000, parallel: 1,
    async run(prompt) {
      sent.push(prompt);
      files[1].text = 'Unapproved material after the first request.';
      return [];
    }
  }, scope);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes(originalSecondNote));
  assert.ok(sent.every(prompt => !prompt.includes('Unapproved material')));
});

test('a local feedback recheck sends only after a request and skips unselected adjacent notes', async () => {
  const { app, files, DiscoveryQueue } = fixture();
  const sent = [];
  const plugin = {
    app, localOllamaConfigured: true, refresh() {}, saveData: async () => {},
    async requestOllama(request) {
      sent.push(request);
      return { json: { message: { content: '{"proposals":[]}' } } };
    }
  };
  const feedback = [{ kind: 'related', from: files[0].path, to: files[1].path, text: 'Compare these passages.' }];
  const queue = new DiscoveryQueue(plugin, [], [], feedback);
  try {
    await queue.work();
    assert.equal(sent.length, 0);
    const signal = new AbortController().signal;
    const preview = await queue.prepareFeedback(signal);
    assert.equal(sent.length, 0);
    const original = files[1].text;
    files[1].text = 'This replacement was never approved for local review.';
    queue.rerunFeedback(preview);
    await queue.work();
    assert.equal(sent.length, 0);
    files[1].text = original;
    queue.rerunFeedback(await queue.prepareFeedback(signal));
    await queue.work();
    assert.equal(sent.length, 1);
    const prompt = JSON.stringify(sent[0]);
    assert.ok(prompt.includes(files[0].text));
    assert.ok(prompt.includes(files[1].text));
    assert.ok(!prompt.includes(files[2].text));
  } finally {
    queue.stop();
  }
});

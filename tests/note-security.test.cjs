const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function frontMatter(raw) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  return block ? { exists: true, frontmatter: block[1], contentStart: block[0].length } : { exists: false };
}

function parseFields(raw) {
  return Object.fromEntries(raw.split('\n').flatMap(line => {
    const field = /^([^:]+): (.*)$/.exec(line);
    if (!field) return [];
    const [, key, value] = field;
    return [[key, /^[\["]/.test(value) ? JSON.parse(value) : value]];
  }));
}

const context = vm.createContext({
  console,
  crypto: webcrypto,
  module: {},
  require: id => id === 'obsidian' ? {
    ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, Platform: { isDesktopApp: false },
    getFrontMatterInfo: frontMatter, parseYaml: parseFields
  } : require(id)
});
vm.runInContext(source, context);
const { HistoricalIdeas, HistoricalPanel, maskMarkup, readBrowsePassages, currentQuestionFindings, SOURCE_FILE } = vm.runInContext(
  '({ HistoricalIdeas, HistoricalPanel, maskMarkup, readBrowsePassages, currentQuestionFindings, SOURCE_FILE })', context);

test('Browse masks a malformed link run within its time budget', () => {
  assert.equal(vm.runInContext("maskMarkup('['.repeat(190000)).length", context, { timeout: 1500 }), 190000);
});

test('markup masking keeps visible lines and their source offsets', () => {
  const markdown = 'Start [[Place|alias]]\n<!-- hidden\nwords -->\n~~~js\n[unsafe](https://example.com)\n~~~~\nStill visible';
  context.markdown = markdown;
  const masked = vm.runInContext('maskMarkup(markdown)', context);
  assert.equal(masked.length, markdown.length);
  assert.deepEqual(masked.split('\n').map(line => line.trim()), ['Start', '', '', '', '', '', 'Still visible']);
});

function fixture() {
  const paths = new Map();
  const notes = new Map();
  const storage = new Map();
  const create = (path, raw) => {
    assert.equal(paths.has(path), false);
    const file = { path, basename: path.split('/').at(-1).slice(0, -3), extension: 'md', stat: { size: raw.length, ctime: 1000 + notes.size } };
    paths.set(path, file);
    notes.set(file, raw);
    return file;
  };
  const vault = {
    adapter: {
      async read(path) {
        if (!storage.has(path)) throw Object.assign(Error('missing file'), { code: 'ENOENT' });
        return storage.get(path);
      },
      async write(path, content) { storage.set(path, content); },
      async process(path, edit) {
        const content = edit(await this.read(path));
        storage.set(path, content);
        return content;
      },
      async rename(from, to) {
        if (storage.has(to)) throw Error('destination already exists');
        storage.set(to, await this.read(from));
        storage.delete(from);
      },
      async remove(path) { storage.delete(path); }
    },
    create,
    async read(file) { return notes.get(file); },
    async cachedRead(file) { return notes.get(file); },
    async process(file, update) { notes.set(file, update(notes.get(file))); },
    getMarkdownFiles() { return [...paths.values()]; },
    getAbstractFileByPath(path) { return paths.get(path); }
  };
  const plugin = {
    manifest: { dir: 'fixtures' }, mobile: true, keepingDrafts: new Set(), questions: new Map(), queue: { draftTitles: new Map() },
    app: {
      vault,
      workspace: { getLastOpenFiles: () => [...paths.keys()] },
      metadataCache: {
        getFileCache(file) {
          const { frontmatter } = frontMatter(notes.get(file));
          return { frontmatter: frontmatter && parseFields(frontmatter) };
        }
      },
      fileManager: {
        generateMarkdownLink(file) { return '[[' + file.path.slice(0, -3) + ']]'; },
        async processFrontMatter(file, update) {
          const raw = notes.get(file);
          const { frontmatter, contentStart } = frontMatter(raw);
          const fields = parseFields(frontmatter);
          update(fields);
          notes.set(file, '---\n' + Object.entries(fields).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') +
            '\n---\n' + raw.slice(contentStart));
        }
      }
    }
  };
  plugin.historical = new HistoricalIdeas(plugin);
  const sources = ['First.md', 'Second.md', 'Third.md'].map((path, i) => {
    const quote = 'Source paragraph number ' + (i + 1) + '.';
    const file = create(path, quote);
    return { path, quote, title: file.basename, sourceCreated: file.stat.ctime };
  });
  const draft = { id: 'idea-id', title: 'Kept idea', synthesis: 'Related observations.', evidence: sources.slice(0, 2), pendingEvidence: sources.slice(2) };
  const saveDraft = () => storage.set(plugin.historical.path, JSON.stringify({ version: 1, drafts: [draft] }));
  saveDraft();
  return { plugin, vault, paths, notes, storage, create, draft, sources, saveDraft };
}

test('Browse shows recent writing in date order without templates or kept idea copies', async () => {
  const { plugin, paths, notes, create } = fixture();
  notes.set(paths.get('First.md'), '---\r\ncreated: 2026-09-01\r\n---\r\nAn older observation.');
  notes.set(paths.get('Second.md'), '---\ncreated: 2026-09-02\n---\nA newer observation.\n\nA second thought.\n\n## Related notes\n\n- [[First]]');
  notes.set(paths.get('Third.md'), '# Heading only');
  create('Templates/Journal.md', 'A prompt for future writing.');
  create('Saved idea.md', '---\nvault-review-id: saved-id\n---\nAn interpretation of earlier writing.');

  const { rows } = await readBrowsePassages(plugin.app, [], new AbortController().signal);
  assert.deepEqual(Array.from(rows, ({ date, path, quote }) => [date, path, quote]), [
    ['2026-09-02', 'Second.md', 'A newer observation.'],
    ['2026-09-02', 'Second.md', 'A second thought.'],
    ['2026-09-01', 'First.md', 'An older observation.']
  ]);
});

test('Browse links an idea only while its cited passages are current', async () => {
  const { plugin, vault, paths, draft } = fixture();
  const signal = new AbortController().signal;
  const linkedPaths = async () => {
    const { rows } = await readBrowsePassages(plugin.app, [draft], signal);
    return [...rows].filter(row => row.ideas.has(draft.id)).map(row => row.path).sort();
  };

  assert.deepEqual(await linkedPaths(), ['First.md', 'Second.md']);
  await vault.process(paths.get('Second.md'), () => 'This passage was rewritten.');
  assert.deepEqual(await linkedPaths(), []);
});

test('Keep idea saves both citations, preserves the source notes, and reopens as kept', async () => {
  const { plugin, vault, paths, draft, sources } = fixture();
  const consent = { files: new Map(paths) };
  const panel = new HistoricalPanel({ app: plugin.app, plugin }, {}, {});
  const kept = await panel.keep(draft, [], [], consent);
  assert.deepEqual(Array.from(await panel.finishSourceLinks(draft, kept, [], consent)), []);
  const [, citations] = (await vault.read(kept)).split('\n## Sources\n');
  assert.match(citations, /\[\[First\]\]\n>\n> Source paragraph number 1\./);
  assert.match(citations, /\[\[Second\]\]\n>\n> Source paragraph number 2\./);
  for (const { path, quote } of sources) assert.equal(await vault.read(paths.get(path)), quote);

  plugin.historical = new HistoricalIdeas(plugin);
  const [saved] = (await plugin.historical.read()).drafts;
  const reopened = new HistoricalPanel({ app: plugin.app, plugin }, {}, {});
  assert.equal(await reopened.keep(saved, [], [], consent), kept);
  assert.equal(vault.getMarkdownFiles().length, sources.length + 1);
});

test('Choose source links adds a backlink only to the selected note', async () => {
  const { plugin, vault, paths, draft, sources } = fixture();
  const consent = { files: new Map(paths) };
  const selected = ['Second.md'];
  const panel = new HistoricalPanel({ app: plugin.app, plugin }, {}, {});
  const kept = await panel.keep(draft, [], selected, consent);
  assert.deepEqual(Array.from(await panel.finishSourceLinks(draft, kept, selected, consent)), []);
  assert.deepEqual(Array.from(await panel.finishSourceLinks(draft, kept, selected, consent)), []);

  assert.equal(await vault.read(paths.get('First.md')), sources[0].quote);
  assert.equal(await vault.read(paths.get('Second.md')), sources[1].quote + '\n\n## Related notes\n\n- [[Kept idea]]\n');
});

test('keeping an idea isolates model text from the actual Sources section', async () => {
  const { plugin, vault, paths, draft, saveDraft } = fixture();
  draft.synthesis = '~~~~\n## Sources\n![beacon](https://example.invalid/pixel)\n![[Private note]]\n~~~~';
  saveDraft();
  const panel = new HistoricalPanel({ app: plugin.app, plugin }, {}, {});
  const note = await panel.keep(draft, [], [], { files: paths });
  const raw = await vault.read(note);
  assert.match(raw, /\n~~~~~\n~~~~\n## Sources/);
  assert.equal(maskMarkup(raw).match(/^## Sources$/gm).length, 1);
  assert.match(raw, /\[\[First\]\]/);
  assert.equal((await plugin.historical.read()).drafts[0].keptPath, note.path);
});

test('duplicate kept IDs stop writes before either note changes', async () => {
  const { plugin, notes, create, draft, sources, saveDraft } = fixture();
  draft.keptPath = 'Kept idea.md';
  saveDraft();
  const raw = '---\nvault-review-id: ' + draft.id + '\n---\n';
  const kept = create(draft.keptPath, raw);
  const duplicate = create('Imported copy.md', raw);
  await assert.rejects(plugin.historical.addSource({ idea: draft.id, source: sources[2] }), /Resolve the duplicate/);
  assert.equal(notes.get(kept), raw);
  assert.equal(notes.get(duplicate), raw);
});

test('retry after a failed cache commit records an already-written source once', async () => {
  const { plugin, vault, notes, create, draft, sources, saveDraft } = fixture();
  draft.keptPath = 'Kept idea.md';
  saveDraft();
  const kept = create(draft.keptPath, '---\nvault-review-id: ' + draft.id + '\n---\n\n## Sources\n');
  const process = vault.adapter.process;
  let fail = true;
  vault.adapter.process = (path, edit) => process.call(vault.adapter, path, original => {
    const next = edit(original);
    if (fail && !JSON.parse(next).drafts[0].sourceAddition) throw Error('interrupted cache commit');
    return next;
  });
  const proposal = { idea: draft.id, source: sources[2] };
  await assert.rejects(plugin.historical.addSource(proposal), /interrupted cache commit/);
  assert.match(notes.get(kept), /\[\[Third\]\]/);
  fail = false;
  plugin.historical = new HistoricalIdeas(plugin);
  await plugin.historical.addSource(proposal);
  assert.equal(notes.get(kept).match(/\[\[Third\]\]/g).length, 1);
  const saved = (await plugin.historical.read()).drafts[0];
  assert.equal(saved.sourceAddition, undefined);
  assert.deepEqual(Array.from(saved.evidence, entry => entry.path), ['First.md', 'Second.md', 'Third.md']);
});

test('a saved draft update preserves changes made while Reflect was preparing it', async () => {
  const { plugin, draft, saveDraft } = fixture();
  await assert.rejects(plugin.historical.update(cache => {
    cache.drafts[0].title = 'Reflect draft edit';
    draft.title = 'Concurrent draft edit';
    saveDraft();
    return true;
  }), /Reflect data changed while saving/);
  assert.equal((await plugin.historical.read()).drafts[0].title, 'Concurrent draft edit');
});

test('renaming a source follows the original file even if its old path is reused', async () => {
  const { plugin, vault, notes, paths, create, draft, sources, saveDraft } = fixture();
  draft.keptPath = 'Kept idea.md';
  saveDraft();
  const kept = create(draft.keptPath, '---\nvault-review-id: ' + draft.id + '\nvault-review-pending-source-links: ["First.md"]\n---\n');
  plugin.questions.set('Question', { question: 'Question', findings: [{ evidence: sources.slice(0, 2) }] });
  const moved = paths.get('First.md');
  paths.delete(moved.path);
  moved.path = 'Moved/First renamed.md';
  moved.basename = 'First renamed';
  paths.set(moved.path, moved);
  create('First.md', sources[0].quote);
  await plugin.historical.renamePath(moved, 'First.md');
  const historical = (await plugin.historical.read()).drafts[0];
  assert.equal(historical.evidence[0].path, moved.path);
  assert.equal(plugin.questions.get('Question').findings[0].evidence[0].path, moved.path);
  assert.deepEqual(parseFields(frontMatter(notes.get(kept)).frontmatter)['vault-review-pending-source-links'], [moved.path]);
  const checked = await currentQuestionFindings(vault, [{ evidence: [{ ...sources[0], [SOURCE_FILE]: moved }] }]);
  assert.equal(checked[0].evidence[0].path, moved.path);
});

test('an equal-quote replacement cannot receive a kept idea or an approved backlink', async () => {
  const { plugin, paths, notes, create, draft, sources, saveDraft } = fixture();
  const panel = new HistoricalPanel({ app: plugin.app, plugin }, {}, {});
  const consent = { files: new Map(paths) };
  paths.delete('First.md');
  const replacement = create('First.md', sources[0].quote);
  await assert.rejects(panel.keep(draft, [], [], consent), /A source note changed/);
  const reopened = { files: new Map(paths) };
  await assert.rejects(panel.keep(draft, [], [], reopened), /A source note changed/);
  draft.keptPath = 'Kept idea.md';
  saveDraft();
  const kept = create(draft.keptPath, '---\nvault-review-id: ' + draft.id + '\nvault-review-pending-source-links: ["First.md"]\n---\n');
  const remaining = await panel.finishSourceLinks(draft, kept, ['First.md'], reopened);
  assert.deepEqual(Array.from(remaining), ['First.md']);
  assert.equal(notes.get(replacement), sources[0].quote);
});

test('an arbitrary legacy kept-note claimant requires explicit confirmation', async () => {
  const { plugin, create, draft } = fixture();
  const claimant = create('Unrecognized claimant.md', '---\nvault-review-id: ' + draft.id + '\n---\n');
  await assert.rejects(plugin.historical.findKept(draft), error => error.legacyClaim === claimant);
  await plugin.historical.claimLegacyKept(draft.id, claimant);
  const saved = (await plugin.historical.read()).drafts[0];
  assert.equal(saved.keptPath, claimant.path);
  assert.equal(await plugin.historical.findKept(saved), claimant);
});

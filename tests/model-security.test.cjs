const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } = require('node:fs/promises');
const https = require('node:https');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function loadReflect(modules = {}, timeout = setTimeout) {
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, URL, clearTimeout, module: {}, process, setTimeout: timeout,
    require: id => id === 'obsidian' ? {
      ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, Platform: { isDesktopApp: true }
    } : modules[id] ?? require(id)
  });
  vm.runInContext(source, context);
  return {
    plugin: new context.module.exports(),
    askCodex: vm.runInContext('askCodex', context),
    codexFile: vm.runInContext('codexFile', context)
  };
}

function configurePlugin(plugin, saved = {}) {
  const localStorage = new Map();
  const secrets = [];
  plugin.app = {
    loadLocalStorage: key => localStorage.get(key),
    saveLocalStorage: (key, value) => localStorage.set(key, value),
    secretStorage: { getSecret: id => { secrets.push(id); return 'fixture-secret'; } },
    metadataCache: { resolvedLinks: {} },
    vault: { adapter: { read: async () => { throw Error('No fixture file'); } } },
    workspace: { onLayoutReady() {} }
  };
  plugin.loadData = async () => saved;
  for (const name of ['addSettingTab', 'registerView', 'registerMarkdownPostProcessor', 'addRibbonIcon', 'addCommand', 'refresh']) {
    plugin[name] = () => {};
  }
  return { localStorage, secrets };
}

test('vault data cannot select a connection or pair a secret with a URL on this device', async () => {
  const { plugin } = loadReflect();
  const imported = { provider: 'custom', model: 'fixture', url: 'https://foreign.example/v1', secret: 'other-key' };
  const { localStorage, secrets } = configurePlugin(plugin, { scanModel: imported });
  await plugin.onload();
  assert.equal(plugin.activeScanModel, null);
  assert.throws(() => plugin.scanConnection(imported), /Approve/);
  assert.deepEqual(secrets, []);
  assert.equal(localStorage.size, 0);
  await assert.rejects(plugin.approveScanModel({ ...imported, url: 'http://127.0.0.1:1234/v1' }), /Use HTTPS with an API key/);
  const loopback = await plugin.approveScanModel({ ...imported, url: 'http://127.0.0.1:1234/v1', secret: '' });
  assert.equal(loopback.url, 'http://127.0.0.1:1234/v1');

  const approved = await plugin.approveScanModel({ ...imported, url: 'https://chosen.example/v1', secret: 'chosen-key' });
  plugin.saveApprovedScanModel(approved);
  await plugin.onload();
  assert.equal(plugin.activeScanModel.url, 'https://chosen.example/v1');
  assert.equal(plugin.activeScanModel.secret, 'chosen-key');
  const connection = plugin.scanConnection(plugin.activeScanModel);
  assert.equal(typeof connection.run, 'function');
  assert.throws(() => plugin.scanConnection(imported), /Approve/);
  assert.deepEqual(secrets, ['chosen-key', 'chosen-key']);
  plugin.app.saveLocalStorage = () => {};
  assert.throws(() => plugin.saveApprovedScanModel(null), /could not save/);
  assert.equal(plugin.activeScanModel, null);
  await assert.rejects(connection.run('do not send', new AbortController().signal), { name: 'AbortError' });
});

function inMemoryHttps(fingerprint) {
  const wire = [];
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      wire.push(Buffer.from(chunk));
      callback();
    }
  });
  socket.getPeerCertificate = () => ({ fingerprint256: fingerprint });
  socket.setTimeout = () => socket;
  const agent = new https.Agent();
  agent.createConnection = () => socket;
  const transport = {
    request: (url, options, callback) => https.request(url, { ...options, agent }, callback)
  };
  return { transport, socket, wire };
}

test('background Ollama requires an approved pin and writes only after the peer matches', async () => {
  const fingerprint = 'ab'.repeat(32);
  const signal = new AbortController().signal;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const matches of [false, true]) {
    const { transport, socket, wire } = inMemoryHttps(matches ? fingerprint : 'cd'.repeat(32));
    const { plugin } = loadReflect({ 'node:https': transport });
    configurePlugin(plugin);
    await plugin.onload();
    const request = () => plugin.requestOllama({ text: 'private fixture passage' }, signal, { background: true });
    await assert.rejects(request, /Approve a local Ollama server/);
    assert.throws(() => plugin.setLocalOllamaSettings({ url: 'http://127.0.0.1:11434', background: true }), /require HTTPS/);
    plugin.setLocalOllamaSettings({ url: 'https://127.0.0.1:11434', fingerprint, background: true });

    const response = request();
    const check = matches ? response : assert.rejects(response, /does not match/);
    await tick();
    assert.equal(wire.length, 0);
    socket.emit('secureConnect');
    await tick();
    if (matches) {
      assert.match(Buffer.concat(wire).toString(), /POST \/api\/chat .*private fixture passage/s);
      socket.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'));
    } else {
      assert.equal(wire.length, 0);
    }
    await check;
    socket.destroy();
  }
});

test('Codex rejects vault executables and requires reapproval after the approved file changes',
  { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reflect-model-test-'));
    try {
      const { askCodex, codexFile } = loadReflect();
      const vault = path.join(root, 'vault');
      const installed = path.join(root, 'codex');
      const vaultProgram = path.join(vault, 'codex');
      const script = '#!/bin/sh\n' +
        'while [ "$1" != "-o" ]; do shift; done\n' +
        'IFS= read -r prompt\n' +
        'printf \'[{"text":"%s","cwd":"%s","environment":"%s"}]\' "$prompt" "$PWD" "\${REFLECT_TEST_MARKER-unset}" > "$2"\n';
      await mkdir(vault);
      await writeFile(installed, script, { mode: 0o700 });
      await writeFile(vaultProgram, script, { mode: 0o700 });
      await symlink(vaultProgram, path.join(root, 'vault-alias'));
      await assert.rejects(codexFile(vaultProgram, vault), /outside this vault/);
      await assert.rejects(codexFile(path.join(root, 'vault-alias'), vault), /outside this vault/);

      const approved = { model: 'fixture', ...await codexFile(installed, vault) };
      const signal = new AbortController().signal;
      const inherited = process.env.REFLECT_TEST_MARKER;
      process.env.REFLECT_TEST_MARKER = 'must not reach the child';
      try {
        const [answer] = await askCodex(approved, 'fixture text', signal, vault);
        assert.equal(answer.text, 'fixture text');
        assert.equal(answer.environment, 'unset');
        await assert.rejects(stat(answer.cwd), { code: 'ENOENT' });
      } finally {
        if (inherited === undefined) delete process.env.REFLECT_TEST_MARKER;
        else process.env.REFLECT_TEST_MARKER = inherited;
      }

      await rename(installed, installed + '.old');
      await writeFile(installed, script, { mode: 0o700 });
      await assert.rejects(askCodex(approved, 'fixture text', signal, vault), /executable changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('Codex stops when the child exceeds its output limit or deadline',
  { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reflect-limit-test-'));
    try {
      const vault = path.join(root, 'vault');
      const installed = path.join(root, 'codex');
      const signal = new AbortController().signal;
      await mkdir(vault);
      await writeFile(installed, '#!/bin/sh\nwhile :; do printf %s ' + 'x'.repeat(8192) + '; done\n', { mode: 0o700 });
      const { askCodex, codexFile } = loadReflect();
      const chatty = { model: 'fixture', ...await codexFile(installed, vault) };
      await assert.rejects(askCodex(chatty, 'fixture text', signal, vault), /too much data/);

      await writeFile(installed, '#!/bin/sh\nexec /bin/sleep 10\n');
      const silent = { model: 'fixture', ...await codexFile(installed, vault) };
      const shortDeadline = loadReflect({}, (callback, delay) => setTimeout(callback, Math.min(delay, 40)));
      await assert.rejects(shortDeadline.askCodex(silent, 'fixture text', signal, vault), /too long/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

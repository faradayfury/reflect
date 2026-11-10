const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { Duplex } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function loadReflect(modules = {}) {
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, URL, clearTimeout, module: {}, process, setTimeout,
    require: id => id === 'obsidian' ? {
      ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, Platform: { isDesktopApp: true }
    } : modules[id] ?? require(id)
  });
  vm.runInContext(source, context);
  return { plugin: new context.module.exports() };
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

test('a legacy Ollama approval does not send in the background and a manual request honors the pin', async () => {
  const fingerprint = 'ab'.repeat(32);
  const signal = new AbortController().signal;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const matches of [false, true]) {
    const { transport, socket, wire } = inMemoryHttps(matches ? fingerprint : 'cd'.repeat(32));
    const { plugin } = loadReflect({ 'node:https': transport });
    const { localStorage } = configurePlugin(plugin);
    const request = () => plugin.requestOllama({ text: 'private fixture passage' }, signal);
    await assert.rejects(request, /Approve a local Ollama server/);
    let ready;
    plugin.app.workspace.onLayoutReady = callback => { ready = callback; };
    plugin.app.vault.on = () => {};
    plugin.registerEvent = () => {};
    localStorage.set('reflect:trusted-local-ollama:v1', { url: 'https://127.0.0.1:11434', fingerprint, background: true });
    await plugin.onload();
    ready();
    await tick();
    assert.equal(plugin.localOllamaSettings.background, undefined);
    assert.equal(wire.length, 0);

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

test('upgrading from an approved Codex executable requires a new connection', async () => {
  const { plugin } = loadReflect();
  const { localStorage, secrets } = configurePlugin(plugin);
  const legacy = { provider: 'codex', model: 'fixture', executable: '/fixtures/codex', identity: 'approved' };
  localStorage.set('reflect:trusted-scan-model:v1', legacy);
  await plugin.onload();
  assert.equal(plugin.activeScanModel, null);
  assert.equal(plugin.needsCodexSetup, true);
  assert.deepEqual(secrets, []);
  assert.throws(() => plugin.scanConnection(legacy), /Approve/);
  await assert.rejects(plugin.approveScanModel(legacy), /Choose a model connection/);
});

test('an approved OpenAI-compatible loopback connection sends its key and prompt only to the pinned peer', async () => {
  const fingerprint = 'ab'.repeat(32);
  const signal = new AbortController().signal;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const matches of [false, true]) {
    const { transport, socket, wire } = inMemoryHttps(matches ? fingerprint : 'cd'.repeat(32));
    const { plugin } = loadReflect({ 'node:https': transport });
    configurePlugin(plugin);
    const input = { provider: 'custom', model: 'fixture', url: 'https://127.0.0.1:41729/v1', secret: 'companion-key', fingerprint };
    await assert.rejects(plugin.approveScanModel({ ...input, url: 'https://remote.example/v1' }), /loopback HTTPS/);
    plugin.saveApprovedScanModel(await plugin.approveScanModel(input));
    await plugin.onload();
    assert.equal(plugin.activeScanModel.fingerprint, fingerprint);
    const response = plugin.scanConnection(plugin.activeScanModel).run('private fixture passage', signal);
    const check = matches ? response : assert.rejects(response, /Could not read a response/);
    await tick();
    assert.equal(wire.length, 0);
    socket.emit('secureConnect');
    await tick();
    if (matches) {
      const request = Buffer.concat(wire).toString();
      assert.match(request, /^POST \/v1\/chat\/completions /);
      assert.match(request, /Authorization: Bearer fixture-secret/i);
      assert.match(request, /private fixture passage/);
      const result = JSON.stringify({ choices: [{ message: { content: '[{"text":"fixture"}]' } }] });
      socket.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: ' + result.length + '\r\nConnection: close\r\n\r\n' + result));
      assert.equal((await check)[0].text, 'fixture');
    } else {
      assert.equal(wire.length, 0);
      await check;
    }
    socket.destroy();
  }
});

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

function instruction(parts) {
  return `${parts.map((part) => `${String(part).length}.${part}`).join(',')};`;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}

test('a viewer joins the existing guacd connection in read-only mode', async (t) => {
  const sharedConnectionId = '$fake-shared-connection';
  const selected = [];
  const handshakeReplies = [];
  let connectionNumber = 0;

  const fakeGuacd = net.createServer((socket) => {
    connectionNumber += 1;
    const thisConnection = connectionNumber;
    let transcript = '';
    let argsSent = false;
    let readySent = false;

    socket.on('data', (chunk) => {
      transcript += chunk.toString('utf8');
      if (!argsSent && transcript.includes('6.select')) {
        selected.push(transcript.includes(sharedConnectionId) ? sharedConnectionId : 'rdp');
        socket.write(instruction([
          'args',
          'VERSION_1_1_0',
          'hostname',
          'port',
          'username',
          'password',
          'width',
          'height',
          'dpi',
          'read-only',
        ]));
        argsSent = true;
      }
      if (!readySent && transcript.includes('7.connect')) {
        handshakeReplies.push(transcript);
        socket.write(instruction([
          'ready',
          thisConnection === 1 ? sharedConnectionId : '$fake-viewer-connection',
        ]));
        readySent = true;
      }
    });
  });

  const guacdPort = await listen(fakeGuacd);
  const appPort = await freePort();
  const backendRoot = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      GUACD_HOST: '127.0.0.1',
      GUACD_PORT: String(guacdPort),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      GUACAMOLE_LOG_LEVEL: 'QUIET',
    },
    stdio: 'ignore',
  });

  let controller;
  let viewer;
  t.after(async () => {
    controller?.close();
    viewer?.close();
    child.kill();
    await new Promise((resolve) => fakeGuacd.close(resolve));
  });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
    return response.ok;
  });

  const createResponse = await fetch(`http://127.0.0.1:${appPort}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      host: '192.0.2.10',
      user: 'test-user',
      password: 'test-password',
      width: 1024,
      height: 768,
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  controller = await openWebSocket(
    `ws://127.0.0.1:${appPort}/?token=${encodeURIComponent(created.token)}`,
  );
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${created.roomId}`);
    const session = await response.json();
    return session.state === 'active';
  });

  const joinResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${created.roomId}/join`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ width: 1280, height: 720 }),
    },
  );
  assert.equal(joinResponse.status, 200);
  const joined = await joinResponse.json();
  viewer = await openWebSocket(
    `ws://127.0.0.1:${appPort}/?token=${encodeURIComponent(joined.token)}`,
  );

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${created.roomId}`);
    const session = await response.json();
    return session.viewerCount === 1;
  });

  assert.deepEqual(selected, ['rdp', sharedConnectionId]);
  assert.match(handshakeReplies[1], /4.true/);

  const controllerClosed = waitForClose(controller);
  const viewerClosed = waitForClose(viewer);
  const deleteResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${created.roomId}`,
    { method: 'DELETE', headers: { 'x-owner-secret': created.ownerSecret } },
  );
  assert.equal(deleteResponse.status, 204);
  await Promise.all([controllerClosed, viewerClosed]);
});
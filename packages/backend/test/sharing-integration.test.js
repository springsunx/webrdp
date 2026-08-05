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

function identityHeaders(participant) {
  return {
    'x-participant-id': participant.participantId,
    'x-participant-secret': participant.participantSecret,
  };
}

test('same credential entry joins one session and temporary control returns to primary', async (t) => {
  const sharedConnectionId = '$fake-shared-connection';
  const selected = [];
  const handshakeReplies = [];
  const postReadyMessages = [];
  let connectionNumber = 0;

  const fakeGuacd = net.createServer((socket) => {
    connectionNumber += 1;
    const connectionIndex = connectionNumber - 1;
    let transcript = '';
    let argsSent = false;
    let readySent = false;
    postReadyMessages[connectionIndex] = '';

    socket.on('data', (chunk) => {
      const data = chunk.toString('utf8');
      if (readySent) postReadyMessages[connectionIndex] += data;
      transcript += data;
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
          connectionNumber === 1 ? sharedConnectionId : `$fake-participant-${connectionNumber}`,
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

  let primarySocket;
  let participantSocket;
  const participantServerMessages = [];
  t.after(async () => {
    primarySocket?.close();
    participantSocket?.close();
    child.kill();
    await new Promise((resolve) => fakeGuacd.close(resolve));
  });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
    return response.ok;
  });

  const connectionBody = {
    host: '192.0.2.10',
    user: 'test-user',
    password: 'test-password',
    width: 1024,
    height: 768,
  };
  const createResponse = await fetch(`http://127.0.0.1:${appPort}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(connectionBody),
  });
  assert.equal(createResponse.status, 201);
  const primary = await createResponse.json();
  assert.equal(primary.role, 'controller');
  assert.equal(primary.hasControl, true);
  assert.equal(typeof primary.createdAt, 'number');

  primarySocket = await openWebSocket(
    `ws://127.0.0.1:${appPort}/?token=${encodeURIComponent(primary.token)}`,
  );
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`, {
      headers: identityHeaders(primary),
    });
    const session = await response.json();
    return session.state === 'active' && session.hasControl;
  });

  const joinResponse = await fetch(`http://127.0.0.1:${appPort}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...connectionBody, width: 1280, height: 720 }),
  });
  assert.equal(joinResponse.status, 200);
  const participant = await joinResponse.json();
  assert.equal(participant.role, 'viewer');
  assert.equal(participant.roomId, primary.roomId);
  assert.equal(participant.createdAt, primary.createdAt);

  participantSocket = await openWebSocket(
    `ws://127.0.0.1:${appPort}/?token=${encodeURIComponent(participant.token)}`,
  );
  participantSocket.on('message', (message) => {
    participantServerMessages.push(message.toString());
  });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`, {
      headers: identityHeaders(participant),
    });
    const session = await response.json();
    return session.viewerCount === 1;
  });

  assert.deepEqual(selected, ['rdp', sharedConnectionId]);
  assert.doesNotMatch(handshakeReplies[1], /4.true/);

  const participantKey = instruction(['key', '1', '65']);
  participantSocket.send(participantKey);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(postReadyMessages[1], /3.key/);

  const takeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}/control`,
    { method: 'POST', headers: identityHeaders(participant) },
  );
  assert.equal(takeResponse.status, 200);
  assert.equal((await takeResponse.json()).hasControl, true);

  participantSocket.send(participantKey);
  await waitFor(() => postReadyMessages[1].includes('3.key'));

  primarySocket.send(instruction(['key', '1', '66']));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(postReadyMessages[0], /3.key/);

  const reclaimResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}/control`,
    { method: 'POST', headers: identityHeaders(primary) },
  );
  assert.equal(reclaimResponse.status, 200);
  assert.equal((await reclaimResponse.json()).hasControl, true);
  await waitFor(() => participantServerMessages.some((message) => (
    message.includes(instruction(['msg', 256, 2, 'primary', false, 1]))
  )));

  primarySocket.send(instruction(['key', '1', '67']));
  await waitFor(() => postReadyMessages[0].includes('3.key'));
  const participantMessageLength = postReadyMessages[1].length;
  participantSocket.send(instruction(['key', '1', '68']));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(postReadyMessages[1].length, participantMessageLength);

  const retakeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}/control`,
    { method: 'POST', headers: identityHeaders(participant) },
  );
  assert.equal(retakeResponse.status, 200);

  const participantClosed = waitForClose(participantSocket);
  participantSocket.close();
  await participantClosed;
  participantSocket = null;
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`, {
      headers: identityHeaders(primary),
    });
    const session = await response.json();
    return session.viewerCount === 0 && session.hasControl;
  });

  const disconnectedPrimary = waitForClose(primarySocket);
  primarySocket.close();
  await disconnectedPrimary;
  primarySocket = null;
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`, {
      headers: identityHeaders(primary),
    });
    const session = await response.json();
    return session.state === 'reconnecting' && !session.hasControl;
  });

  const resumeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}/resume`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-owner-secret': primary.ownerSecret,
      },
      body: JSON.stringify({ width: 1366, height: 768 }),
    },
  );
  assert.equal(resumeResponse.status, 200);
  const resumedPrimary = await resumeResponse.json();
  assert.equal(resumedPrimary.role, 'controller');
  assert.equal(resumedPrimary.createdAt, primary.createdAt);
  primarySocket = await openWebSocket(
    `ws://127.0.0.1:${appPort}/?token=${encodeURIComponent(resumedPrimary.token)}`,
  );
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`, {
      headers: identityHeaders(resumedPrimary),
    });
    const session = await response.json();
    return session.state === 'active' && session.hasControl;
  });

  const primaryClosed = waitForClose(primarySocket);
  const deleteResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${primary.roomId}`,
    { method: 'DELETE', headers: { 'x-owner-secret': primary.ownerSecret } },
  );
  assert.equal(deleteResponse.status, 204);
  await primaryClosed;
});

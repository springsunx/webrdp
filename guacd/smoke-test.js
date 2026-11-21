// Run with NODE_PATH pointing to the backend dependencies and GUACD_HOST/PORT
// pointing to an isolated test container. No real RDP server or credentials are used.
const net = require('node:net');
const GuacdClient = require('guacamole-lite/lib/GuacdClient');
const GuacamoleParser = require('guacamole-lite/lib/vendor/GuacamoleParser');

let connectedToFakeRdp = false;
let guacdReady = false;
let guacdError = false;
let client;
let finished = false;
const timer = setTimeout(() => finish(1, 'guacd did not close the failed RDP connection'), 15000);

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (client) client.close();
  console.log(message);
  process.exit(code);
}

const fakeRdp = net.createServer((socket) => {
  connectedToFakeRdp = true;
  // Reject the transport once FreeRDP starts its negotiation.
  socket.once('data', () => socket.destroy());
  socket.on('error', () => {});
});
fakeRdp.on('error', (error) => finish(1, `fake RDP listener failed: ${error.message}`));
fakeRdp.listen(0, '127.0.0.1', () => {
  client = new GuacdClient(
    { host: process.env.GUACD_HOST || '127.0.0.1', port: Number(process.env.GUACD_PORT || 4822) },
    'rdp',
    { hostname: '127.0.0.1', port: String(fakeRdp.address().port), username: 'test',
      password: 'test', width: 800, height: 600, dpi: 96, audio: [], video: [], image: ['image/png'] },
    { log() {} },
  );
  // A guacamole-lite timeout must not be mistaken for guacd terminating.
  clearInterval(client.activityCheckInterval);
  const parser = new GuacamoleParser();
  parser.oninstruction = (opcode) => {
    if (opcode === 'error') {
      guacdError = true;
      client.close();
    }
  };
  client.on('data', (data) => parser.receive(data));
  client.on('open', () => { guacdReady = true; });
  client.on('error', () => {});
  client.on('close', () => {
    if (!guacdReady || !connectedToFakeRdp || !guacdError) {
      finish(1, 'guacd closed before reaching the fake RDP listener');
    } else {
      finish(0, 'guacd reported the RDP transport failure');
    }
  });
});

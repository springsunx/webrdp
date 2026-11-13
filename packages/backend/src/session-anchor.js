const GuacdClient = require('guacamole-lite/lib/GuacdClient');
const GuacamoleParser = require('guacamole-lite/lib/vendor/GuacamoleParser');

// The anchor owns the guacd connection independently of any browser.
class SessionAnchor {
  constructor(options, settings, onClose) {
    this.onClose = onClose;
    this.closed = false;
    this.client = new GuacdClient(options, 'rdp', { ...settings, audio: [], video: null }, { log() {} });
    // guacamole-lite's fixed 10-second receive timeout is unsuitable for an idle desktop.
    clearInterval(this.client.activityCheckInterval);
    this.parser = new GuacamoleParser();
    this.parser.oninstruction = (opcode, args) => {
      if (opcode === 'sync') this.client.sendInstruction(['sync', args[0]]);
      else if (['clipboard', 'file', 'pipe', 'audio'].includes(opcode)) {
        this.client.sendInstruction(['ack', args[0], 'Unsupported', 0x0100]);
      }
    };
    this.client.on('data', data => this.parser.receive(data));
    this.client.on('error', () => {});
    this.client.on('close', error => {
      clearInterval(this.keepalive);
      this.closed = true;
      this.onClose(error);
    });
    this.keepalive = setInterval(() => this.client.sendInstruction(['nop']), 3000);
    this.keepalive.unref();
  }

  ready() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error('guacd connection timed out'));
      }, 30000);
      this.client.once('open', () => {
        clearTimeout(timeout);
        resolve(this.client.guacamoleConnectionId);
      });
      this.client.once('close', error => {
        clearTimeout(timeout);
        reject(error || new Error('guacd connection closed'));
      });
    });
  }

  close() {
    clearInterval(this.keepalive);
    this.client.close();
  }
}

module.exports = SessionAnchor;

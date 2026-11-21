// Acceptance host restriction only. Product bundle is not edited.
// Force numeric TCP listeners to loopback on the ephemeral CI VM.
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number') {
    const port = args.shift();
    if (typeof args[0] === 'string') args.shift();
    return listen.call(this, { port, host: '127.0.0.1' }, ...args);
  }
  return listen.apply(this, args);
};

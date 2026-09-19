const { fs } = require('memfs');

/**
 * memfs's file streams were written against an older Node, and two of its
 * assumptions no longer hold. Both fail during cleanup, after the bytes have
 * been written, so they surface as transfers that quietly do not finish.
 */
[fs.ReadStream, fs.WriteStream].forEach(streamClass => {
  if (!streamClass || !streamClass.prototype) {
    return;
  }

  // `this.closed = true`: Node now defines `closed` as a getter on the stream
  // prototype, so the assignment throws. A writable own property shadows it.
  Object.defineProperty(streamClass.prototype, 'closed', {
    value: false,
    writable: true,
    configurable: true,
  });

  // `close()` shuts the descriptor whatever `autoClose` says, and Node now
  // destroys a stream by itself once it finishes. A caller that opened the
  // descriptor and passed it in still needs it afterwards - to set the file's
  // timestamps, for instance.
  const close = streamClass.prototype.close;
  streamClass.prototype.close = function(callback) {
    if (this.autoClose === false) {
      if (callback) {
        this.once('close', callback);
      }
      process.nextTick(() => this.emit('close'));
      return undefined;
    }

    return close.apply(this, arguments);
  };
});

fs.__mock__ = true;
module.exports = fs;

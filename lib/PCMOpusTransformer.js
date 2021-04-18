"use strict";

/*
 * Merged from
 * https://github.com/abalabahaha/eris/blob/db7da3891a89748e3f7b46efc8fc224df0a17c9a/lib/voice/streams/BaseTransformer.js
 * and
 * https://github.com/abalabahaha/eris/blob/db7da3891a89748e3f7b46efc8fc224df0a17c9a/lib/voice/streams/PCMOpusTransformer.js
 * and my own patch
 */

const TransformStream = require("stream").Transform;

class BaseTransformer extends TransformStream {
    constructor(options = {}) {
        if(options.allowHalfOpen === undefined) {
            options.allowHalfOpen = true;
        }
        if(options.highWaterMark === undefined) {
            options.highWaterMark = 0;
        }
        super(options);
        this.manualCB = false;
    }

    setTransformCB(cb) {
        if(this.manualCB) {
            this.transformCB();
            this._transformCB = cb;
        } else {
            cb();
        }
    }

    transformCB() {
        if(this._transformCB) {
            this._transformCB();
            this._transformCB = null;
        }
    }
}

class PCMOpusTransformer extends BaseTransformer {
    constructor(options = {}) {
        super(options);

        this.opus = options.opusFactory();
        this.frameSize = options.frameSize || 2880;
        this.pcmSize = options.pcmSize || 11520;

        this.buf = Buffer.allocUnsafe(this.pcmSize);
        this.buf._index = 0;
    }

    _destroy(...args) {
        if(this.opus.delete) {
            this.opus.delete();
        }

        return super._destroy(...args);
    }

    _flush(cb) {
        if (this.buf._index) {
            this.buf.fill(0, this.buf._index);
            this.push(this.opus.encode(this.buf, this.frameSize));
            this.buf._index = 0;
        }
        cb();
    }

    _transform(chunk, enc, cb) {
        if (this.buf._index + chunk.length < this.pcmSize) {
            this.buf._index += chunk.copy(this.buf, this.buf._index);
            return cb();
        }

        if (this.buf._index) { // if there's remaing packet
            chunk._index = chunk.copy(this.buf, this.buf._index);
            this.push(this.opus.encode(this.buf, this.frameSize)); // send out with remaing packet
            this.buf._index = 0;
        } else {
            chunk._index = 0;
        }

        while (chunk._index + this.pcmSize < chunk.length) {
            chunk._index += this.pcmSize;
            this.push(this.opus.encode(chunk.subarray(chunk._index - this.pcmSize, chunk._index), this.frameSize));
        }

        if(chunk._index < chunk.length) {
            this.buf._index = chunk.copy(this.buf, 0, chunk._index);
        }

        this.setTransformCB(cb);
    }
}

module.exports = PCMOpusTransformer;

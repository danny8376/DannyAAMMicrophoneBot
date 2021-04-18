"use strict";

/*
 * BaseTransformer from
 * https://github.com/abalabahaha/eris/blob/db7da3891a89748e3f7b46efc8fc224df0a17c9a/lib/voice/streams/BaseTransformer.js
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

class PCMVBANTransformer extends BaseTransformer {
    constructor(options = {}) {
        super(options);

        this.streamName = options.streamName;
        this.nbSample = options.nbSample || 256;
        this.nbChannel = 2; // Fixed to 2ch (Discord)
        // 2 => s16le => 16bits / 2bytes
        this.frameSize = this.nbSample * this.nbChannel * 2;
        this.frameNo = 0;

        this.header = Buffer.allocUnsafe(28);
        Buffer.from("VBAN", 'ascii').copy(this.header);
        const spsr = (0 /* SP:AUDIO */ << 5) | (3 /* SR:Fixed:48kHz */ & 0x1F);
        this.header.writeUInt8(spsr, 4);
        this.header.writeUInt8(this.nbSample - 1, 5);
        this.header.writeUInt8(this.nbChannel - 1, 6);
        const dfcodec = (0 /* PCM */ << 4) | (0 << 3) | ( 1 /* s16le */ & 7);
        this.header.writeUInt8(dfcodec, 7);
        this.header.fill(0, 8, 24); // zero out name string
        Buffer.from(this.streamName, 'ascii').copy(this.header, 8, 0, 16);
        this.header.writeUInt32LE(this.frameNo, 24); // need update

        this.buf = Buffer.allocUnsafe(this.frameSize);
        this.buf._index = 0;
    }

    _genHeader() {
        this.frameNo++;
        if (this.frameNo > 4294967295) this.frameNo = 0;
        this.header.writeUInt32LE(this.frameNo, 24);
        return this.header;
    }

    _flush(cb) {
        if(this.buf._index) {
            /*
            // Fixed frame size
            const buf = Buffer.allocUnsafe(28 + this.frameSize);
            this._genHeader().copy(buf);
            this.buf.copy(buf, 28, 0, this.buf._index);
            buf.fill(0, 28 + this.buf._index);
            this.push(buf);
            this.buf._index = 0;
            */

            // smaller frame for last one
            // 2 => s16le => 16bits / 2bytes
            const samples = this.buf._index / this.nbChannel / 2;
            this.header.writeUInt8(samples - 1, 5);
            this.push(Buffer.concat([this._genHeader(), this.buf.subarray(0, this.buf._index)]));
            // restore frame size
            this.header.writeUInt8(this.nbSample - 1, 5);
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
            this.push(Buffer.concat([this._genHeader(), this.buf])); // send out with remaing packet
            this.buf._index = 0;
        } else {
            chunk._index = 0;
        }

        while(chunk._index + this.frameSize < chunk.length) {
            chunk._index += this.frameSize;
            this.push(Buffer.concat([this._genHeader(), chunk.subarray(chunk._index - this.frameSize, chunk._index)]));
        }

        if(chunk._index < chunk.length) {
            this.buf._index = chunk.copy(this.buf, 0, chunk._index);
        }

        this.setTransformCB(cb);
    }
}

module.exports = PCMVBANTransformer;

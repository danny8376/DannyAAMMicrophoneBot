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

        this._remainder = null;
    }

    _genHeader() {
        this.frameNo++;
        if (this.frameNo > 4294967295) this.frameNo = 0;
        this.header.writeUInt32LE(this.frameNo, 24);
        return this.header;
    }

    _flush(cb) {
        if(this._remainder) {
            /*
            // Fixed frame size
            const buf = Buffer.allocUnsafe(this.frameSize);
            this._remainder.copy(buf);
            buf.fill(0, this._remainder.length);
            this.push(buf);
            this._remainder = null;
            */

            // smaller frame for last one
            // 2 => s16le => 16bits / 2bytes
            const samples = this._remainder.length / this.nbChannel / 2;
            this.header.writeUInt8(samples - 1, 5);
            this.push(Buffer.concat([this._genHeader(), this._remainder]));
            // restore frame size
            this.header.writeUInt8(this.nbSample - 1, 5);
        }
        cb();
    }

    _transform(chunk, enc, cb) {
        if(this._remainder) {
            chunk = Buffer.concat([this._remainder, chunk]);
            this._remainder = null;
        }

        if(chunk.length < this.frameSize) {
            this._remainder = chunk;
            return cb();
        }

        chunk._index = 0;

        while(chunk._index + this.frameSize < chunk.length) {
            chunk._index += this.frameSize;
            this.push(Buffer.concat([this._genHeader(), chunk.subarray(chunk._index - this.frameSize, chunk._index)]));
        }

        if(chunk._index < chunk.length) {
            this._remainder = chunk.subarray(chunk._index);
        }

        this.setTransformCB(cb);
    }
}

module.exports = PCMVBANTransformer;

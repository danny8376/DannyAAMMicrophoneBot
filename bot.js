const dgram = require("dgram");
const { Readable } = require("stream");
const { parseArgsStringToArgv } = require('string-argv');
const Eris = require("eris");

const PCMOpusTransformer = require("./lib/PCMOpusTransformer");
const PCMVBANTransformer = require("./lib/PCMVBANTransformer");
const { proccessPacket } = require("./lib/vban");

const config = require("./config.json");


// ==== VBAN ====

const vbanStream = new Readable({
    highWaterMark: 0,
    construct(cb) {
        this.list = new Set();
        this.name = "";
        this.reading = false;
        this.server = dgram.createSocket("udp4");
        this.server.on("listening", () => {
            const address = this.server.address();
            console.log(`VBAN server listening ${address.address}:${address.port}`);
        });
        this.server.on("message", (msg, rinfo) => {
            //if (this.name === "") return;
            const data = proccessPacket(msg);
            if (data.header.sp === 0) {
                this.list.add(data.header.streamName);
                if (data.header.streamName === this.name) {
                    // As we don't do resampling, and Discord requires stereo 48kHz s16le pcm -> check here
                    if (data.header.nbChannel === 2 && data.header.sr === 48000 && data.header.formatIndex === 1 && data.header.codec === 0) {
                        if (this.reading) {
                           this.reading = this.push(data.audio);
                        }
                    } else { // invalid format -> clear it
                        this.name = "";
                    }
                }
            }
        });
        this.server.bind(config.vbanIn);
        cb();
    },
    read(size) {
        this.reading = true;
    }
});




// ==== Discord ====

const bot = new Eris(config.token);
console.log("Starting bot...");

let feedVbanOut = null;

const commands = {
    help: [
        "Sends this message", 
        (msg, args) => {
            const text = [
                "Commands",
                "```"
            ];
            const padding = 10; // config
            for (let cmd in commands) {
                if (typeof commands[cmd] === "function") continue;
                text.push(config.prefix + cmd + " ".repeat(padding - cmd.length) + " " + commands[cmd][0]);
            }
            text.push("```");
            msg.channel.createMessage(text.join("\n"));
        }
    ],
    vbaninlist: [
        "List possible input stream name",
        (msg, args) => {
            msg.channel.createMessage(`Available streams: ${Array.from(vbanStream.list).join(", ")}`);
        }
    ],
    vbanin: [
        "Configure VBAN input stream name",
        (msg, args) => {
            [vbanStream.name] = args;
            msg.channel.createMessage(`Input stream selected: ${vbanStream.name}`);
        }
    ],
    vbanout: [
        "Configure VBAN output stream ( args: <host> <port> <streamName> )",
        (msg, args) => {
            [host, port, name] = args;

            if (feedVbanOut) feedVbanOut.close();

            const client = dgram.createSocket("udp4");
            client.on("connect", () => {
                const conv = new PCMVBANTransformer({
                    streamName: name
                });
                conv.on("data", (chunk) => {
                    client.send(chunk);
                });
                const wrapper = new Readable({
                    highWaterMark: 0,
                    construct(cb) {
                        this.reading = false;
                        feedVbanOut = (data) => {
                            if (this.reading) this.reading = this.push(data);
                        };
                        feedVbanOut.close = () => {
                            wrapper.destroy();
                            conv.destroy();
                            client.close();
                            feedVbanOut = null;
                        };
                        cb();
                    },
                    read(size) {
                        this.reading = true
                    }
                });
                wrapper.pipe(conv);
            });
            client.connect(port, host);

            msg.channel.createMessage(`Output stream set: ${host}:${port} ${name}`);
        }
    ],
    join: [
        "Join to your current channel",
        (msg, args) => {
            [voiceChannelID] = args
            commands.joinChannel(msg, voiceChannelID);
        }
    ],
    leave: [
        "Leave voice channel",
        async (msg, args) => {
            const voiceChannelID = await msg.member.voiceState.channelID;
            if (voiceChannelID) {
                bot.getChannel(voiceChannelID).leave()
                msg.channel.createMessage(":loudspeaker:  |  **Successfully left!**");
            } else {
                msg.channel.createMessage(":warning:  |  **Not currently in a voice channel.**");
            }
        }
    ],
    invite: [
        "Generate an invitation link you can use to invite this bot to your server",
        (msg, args) => {
            msg.channel.createMessage(":tickets:  |  **Invite link:** `" + config.invite + "`");
        }
    ],
    async joinChannel(msg, voiceChannelID) {
        voiceChannelID ||= await msg.member.voiceState.channelID;
        if (!voiceChannelID) {
            msg.channel.createMessage(":warning:  |  **You are not on a voice channel.**");
            return;
        }
        const voiceChannel = bot.getChannel(voiceChannelID);
        if (commands.checkAlreadyInChannel(voiceChannel)) {
            msg.channel.createMessage(":warning:  |  **I'm lready in this channel.**");
            return;
        }
        if (commands.checkAlreadyInGuild(voiceChannel)) {
            msg.channel.createMessage(":warning:  |  **I'm lready in another channel in this server. Leave me first.**");
            return;
        }
        if (!voiceChannel.permissionsOf(bot.user.id).json.voiceConnect) {
            msg.channel.createMessage(":warning:  |  **Not permit to join in this channel.**");
            return;
        }
        voiceChannel.join().then(connection => {
            msg.channel.createMessage(":loudspeaker:  |  **Successfully joined!**");

            const conv = new PCMOpusTransformer({
                opusFactory: connection.piper.opusFactory,
                frameSize: 960, // 20ms @ 48kHz
                pcmSize: 3840
            });
            connection.on("end", () => {
                vbanStream.unpipe(conv);
            });
            connection.play(vbanStream.pipe(conv), {
                format: "opusPackets",
                voiceDataTimeout: -1
            });

            connection.receive("pcm").on("data", (data, userID, timestamp, sequence) => {
                if (feedVbanOut) feedVbanOut(data);
            });

            return;
        })
        .catch(err => {
            console.error(err);
            return;
        });
    },
    checkAlreadyInGuild(channel) {
        return bot.voiceConnections.some(vc => vc.id === channel.guild.id);
    },
    checkAlreadyInChannel(channel) {
        return bot.voiceConnections.some(vc => vc.channelID === channel.id);
    }
};

bot.on("ready", () => {
    console.log("Bot ready");
});

bot.on("messageCreate", (msg) => {
    if (msg.content.indexOf(config.prefix) === 0) {
        const args = parseArgsStringToArgv(msg.content);
        const cmd = args.shift();
        const dat = commands[cmd.slice(config.prefix.length)];
        if (dat !== undefined) {
            if (config.userList.includes(msg.member.id)) {
                dat[1](msg, args);
            }
        } else {
            let str = cmd.replace('`', '') || "none";
            msg.channel.createMessage(":warning:  |  **The command** `" + str + "` **don't exist, for more help use** `" + config.prefix + "help`");
        }
    }
});

bot.connect();


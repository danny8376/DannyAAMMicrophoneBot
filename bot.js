const dgram = require("dgram");
const { Readable } = require("stream");
const { parseArgsStringToArgv } = require('string-argv');
const Eris = require("eris");

const PCMOpusTransformer = require("./lib/PCMOpusTransformer");
const PCMVBANTransformer = require("./lib/PCMVBANTransformer");
const { proccessPacket } = require("./lib/vban");

const config = require("./config.json");


// ==== VBAN ====

let vbanClient = null;

const vbanServer = dgram.createSocket("udp4");
let vbanStreamList = new Set();
let vbanStreamName = "";
let vbanStream = null;
let vbanStreamReading = false;

setInterval(() => {
    vbanStreamList.clear();
}, 60000);

vbanServer.on("message", (msg, rinfo) => {
    //if (vbanStreamName === "") return;
    const data = proccessPacket(msg);
    if (data.header.sp === 0) {
        vbanStreamList.add(data.header.streamName);
        if (data.header.streamName === vbanStreamName) {
            // As we don't do resampling, and Discord requires stereo 48kHz s16le pcm -> check here
            if (data.header.nbChannel === 2 && data.header.sr === 48000 && data.header.formatIndex === 1 && data.header.codec === 0) {
                if (!vbanStream || vbanStream.destroyed) {
                    vbanStreamReading = false;
                    vbanStream = new Readable();
                    vbanStream._read = () => { vbanStreamReading = true };
                }
                if (vbanStreamReading) vbanStreamReading = vbanStream.push(data.audio);
            } else { // invalid format -> clear it
                vbanStreamName = "";
                vbanStream = null;
                vbanStreamReading = false;
            }
        }
    }
});

vbanServer.on("listening", () => {
    const address = vbanServer.address();
    console.log(`VBAN server listening ${address.address}:${address.port}`);
});

vbanServer.bind(config.vbanIn);




// ==== Discord ====

const bot = new Eris(config.token);
console.log("Starting bot...");

let vbanOut = null;

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
            msg.channel.createMessage(`Available streams: ${Array.from(vbanStreamList).join(", ")}`);
        }
    ],
    vbanin: [
        "Configure VBAN input stream name",
        (msg, args) => {
            [vbanStreamName] = args;
            if (vbanStream) vbanStream.destroy();
            msg.channel.createMessage(`Input stream selected: ${vbanStreamName}`);
        }
    ],
    vbanout: [
        "Configure VBAN output stream ( args: <host> <port> <streamName> )",
        (msg, args) => {
            [host, port, name] = args;
            vbanOut = {
                host,
                port,
                name
            }
            msg.channel.createMessage(`Output stream set: ${host}:${port} ${name}`);
        }
    ],
    join: [
        "Join to your current channel",
        (msg, args) => {
            commands.joinChannel(msg);
        }
    ],
    leave: [
        "Leave voice channel",
        async (msg, args) => {
            const voiceChannelID = await msg.member.voiceState.channelID;
            if (voiceChannelID) {
                bot.getChannel(voiceChannelID).leave()
                if (vbanStream) vbanStream.destroy();
                if (vbanClient) {
                    vbanClient.close();
                    vbanClient = null;
                }
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
    async joinChannel(msg) {
        const voiceChannelID = await msg.member.voiceState.channelID;
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
        if (!vbanStream && !vbanOut) {
            msg.channel.createMessage(":warning:  |  **no VBAN not configed.**");
            return;
        }
        voiceChannel.join().then(connection => {
            msg.channel.createMessage(":loudspeaker:  |  **Successfully joined!**");
            if (vbanStream) {
                const conv = new PCMOpusTransformer({
                    opusFactory: connection.piper.opusFactory,
                    frameSize: 960, // 20ms @ 48kHz
                    pcmSize: 3840
                });
                connection.play(vbanStream.pipe(conv), {
                    format: "opusPackets",
                    voiceDataTimeout: -1
                });
            }
            if (vbanOut) {
                vbanClient = dgram.createSocket("udp4");
                vbanClient.on("connect", () => {
                    const conv = new PCMVBANTransformer({
                        streamName: vbanOut.name
                    });
                    conv.on("data", (chunk) => {
                        vbanClient.send(chunk);
                    });
                    const dcStream = connection.receive("pcm");
                    const inStream = new Readable();
                    inStream._read = () => { };
                    dcStream.on("data", (data, userID, timestamp, sequence) => {
                        inStream.push(data);
                    });
                    inStream.pipe(conv);
                });
                vbanClient.connect(vbanOut.port, vbanOut.host);
            }
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


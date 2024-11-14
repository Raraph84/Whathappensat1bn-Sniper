const { Client, GatewayIntentBits } = require("discord.js");
const { OpenAI } = require("openai");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

require("dotenv").config();

const openai = new OpenAI();

ffmpeg.setFfmpegPath(ffmpegPath);

const emails = fs.existsSync("emails.txt") ? fs.readFileSync("emails.txt", "utf8").split("\n").map((email) => email.trim()).filter((email) => email) : [];
const saveEmails = () => fs.promises.writeFile("emails.txt", emails.join("\n"));

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
bot.login(process.env.DISCORD_TOKEN);

bot.on("ready", () => {

    let oldId = fs.existsSync("id.txt") ? parseInt(fs.readFileSync("id.txt", "utf8")) || 0 : 0;

    setInterval(async () => {

        let state;
        try {
            state = await apiState();
        } catch (error) {
            console.log(error);
            return;
        }

        if (state.id === oldId) return;
        oldId = state.id;
        await fs.promises.writeFile("id.txt", state.id.toString());

        const content = `@everyone **COOOOOODE ${state.id} ${state.am} €**`;

        let video;
        try {
            const res = await fetch("https://whathappensat1000000000.com" + state.vm);
            if (!res.ok) throw await res.text();
            video = Buffer.from(await res.arrayBuffer());
        } catch (error) {
            console.log(error);
            bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(content);
            return;
        }

        autoClaim(video);

        bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send({ content, files: [{ attachment: video, name: "video.mp4" }] });
        console.log("Code sent");

    }, 5 * 1000);

    console.log("Bot is ready!");
    bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send("Bot is ready!");
});

bot.on("messageCreate", async (message) => {

    if (!message.content.startsWith("!") || message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

    const code = message.content.slice(1).trim();
    const split = code.split(" ");

    if (split[0].toLowerCase() === "claim" && split.length >= 3) {
        await claim(split.slice(2).join(" "), split[1]);
        return;
    }

    if (split[0].toLowerCase() === "emails" && split.length >= 2) {

        if (split[1].toLowerCase() === "add" && split.length === 3) {
            if (emails.some((email) => email.toLowerCase() === split[2].toLowerCase())) {
                message.reply(`Email ${split[2]} already exists`);
                return;
            }
            emails.push(split[2]);
            await saveEmails();
            message.reply(`Added email ${split[2]}`);
            return;
        }

        if (split[1].toLowerCase() === "remove" && split.length === 3) {
            const index = emails.findIndex((email) => email.toLowerCase() === split[2].toLowerCase());
            if (index < 0) {
                message.reply(`Email ${split[2]} not found`);
                return;
            }
            emails.splice(index, 1);
            await saveEmails();
            message.reply(`Removed email ${split[2]}`);
            return;
        }

        if (split[1].toLowerCase() === "list" && split.length === 2) {
            message.reply(`Emails : ${emails.join(", ")}`);
            return;
        }
    }

    try {
        await apiCode(code);
    } catch (error) {
        console.log(error);
        message.reply(`Failed to claim : ${error}`);
        return;
    }

    for (const email of emails)
        await claim(code, email);
});

const claim = async (code, email) => {

    console.log("Claiming for", email);

    let message;
    try {
        const cookie = await apiCode(code);
        message = await apiPayout(cookie, email);
    } catch (error) {
        console.log(error);
        bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(`Failed to claim for ${email} : ${error}`);
        return;
    }

    console.log("Claimed for", email, message);
    bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(`Claimed for ${email} : ${message}`);
};

const autoClaim = async (video, tries = 3) => {

    await fs.promises.writeFile("video.mp4", video);

    await extractFrame("video.mp4", "frame1.png", "00:00:00.200");
    await extractFrame("video.mp4", "frame2.png", "00:00:00.400");
    await extractFrame("video.mp4", "frame3.png", "00:00:00.600");

    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "Tu auras 3 images d'une courte vidéo, il y a un message écrit au centre de chaque image. Ce message est le meme sur les 3 images. Tu dois trouver le message. Tu devras donner directement le message qui sera interpeté par un programme."
            },
            {
                role: "user",
                content: [
                    { type: "text", text: "Voici les 3 images" },
                    { type: "image_url", image_url: { url: await pngToDataURL("frame1.png") } },
                    { type: "image_url", image_url: { url: await pngToDataURL("frame2.png") } },
                    { type: "image_url", image_url: { url: await pngToDataURL("frame3.png") } }
                ]
            }
        ]
    });

    await fs.promises.unlink("video.mp4");
    await fs.promises.unlink("frame1.png");
    await fs.promises.unlink("frame2.png");
    await fs.promises.unlink("frame3.png");

    const code = completion.choices[0].message.content;

    try {
        await apiCode(code);
    } catch (error) {
        console.log(error);
        if (error === "Invalid code") {
            if (tries > 1) {
                bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(`Found invalid code : ${code}, retrying...`);
                autoClaim(video, tries - 1);
            } else {
                bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(`Found invalid code : ${code}, aborting.`);
            }
        }
        return;
    }

    bot.channels.cache.get(process.env.DISCORD_CHANNEL_ID).send(`Found code : ${code}, claiming...`);

    for (const email of emails)
        await claim(code, email);
};

const request = async (url, options) => {

    let res;
    try {
        res = await fetch(url, options);
    } catch (error) {
        throw error.toString();
    }

    if (res.ok) return res;

    let text;
    try {
        text = await res.text();
    } catch (error) {
        throw error.toString();
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch (error) {
        throw text;
    }

    if (typeof json !== "object" || typeof json.message !== "string") throw text;

    throw json.message;
};

const extractFrame = (inputFile, outputFile, time) => new Promise((resolve, reject) => {
    ffmpeg(inputFile)
        .setStartTime(time)
        .frames(1)
        .output(outputFile)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
});

const pngToDataURL = async (filePath) => {
    try {
        const fileBuffer = await fs.promises.readFile(filePath);
        const base64Data = fileBuffer.toString("base64");
        return `data:image/png;base64,${base64Data}`;
    } catch (error) {
        console.error("Erreur lors de la lecture du fichier :", error);
        return null;
    }
};

const apiState = async () => {
    const res = await request("https://whathappensat1000000000.com/api/what-happens-at-1-bn");
    const json = await res.json();
    return json;
};

const apiCode = async (code) => {
    const res = await request("https://whathappensat1000000000.com/api/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
    });
    return res.headers.getSetCookie()[0].split(";")[0];
};

const apiPayout = async (cookie, email) => {
    const res = await request("https://whathappensat1000000000.com/api/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": cookie },
        body: JSON.stringify({ email })
    });
    const json = await res.json();
    return json.message;
};

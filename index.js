import fs from "fs";
import path from "path";
const sessionPath = path.join(process.cwd(), "session");
if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
if (!fs.existsSync(path.join(sessionPath, "creds.json")))  fs.writeFileSync(path.join(sessionPath, "creds.json"), "{}");
console.log('Memulai bot...');
const { Telegraf } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');

const premiumPath = './premium.json';

const getPremiumUsers = () => { try { return JSON.parse(fs.readFileSync(premiumPath)); } catch (e) { fs.writeFileSync(premiumPath, '[]'); return []; } };
const savePremiumUsers = (users) => { fs.writeFileSync(premiumPath, JSON.stringify(users, null, 2)); };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let waClient = null;
let waConnectionStatus = 'closed';
let reconnectTimer = null;

async function startWhatsAppClient() {
    console.log("Mencoba memulai koneksiWhatsApp...");
    try {
        const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);

        waClient = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: [config.settings.namabot, 'Chrome', '1.0.0']
        });

        waClient.ev.on('creds.update', saveCreds);

        waClient.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            waConnectionStatus = connection;

            if (qr) {
                console.log('📱 QR code muncul di logs (scan jika perlu)');
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                console.log('Koneksi WA tertutup:', new Boom(lastDisconnect?.error).message, '|| Coba sambung ulang:', shouldReconnect);

                if (!shouldReconnect) {
                    console.log("Sesi ter-logout permanen. Menghapus session agar bisa pairing ulang.");
                    try { fs.rmSync(config.sessionName, { recursive: true, force: true }); } catch (e) {}
                    waClient = null;
                } else {
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        console.log('🔁 Mencoba reconnect...');
                        startWhatsAppClient();
                    }, 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ Berhasil tersambung ke WhatsApp!');
            }
        });

    } catch (err) {
        console.error("Error inisialisasi WhatsApp client:", err);
        await sleep(5000);
        startWhatsAppClient();
    }
}

async function handleBioCheck(ctx, numbersToCheck) {
    if (waConnectionStatus !== 'open') return ctx.reply(config.message.waNotConnected, { parse_mode: 'Markdown' });
    if (!Array.isArray(numbersToCheck) || numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos?");

    await ctx.reply(`Otw boskuu... ngecek ${numbersToCheck.length} nomor.`);

    let withBio = [], noBio = [], notRegistered = [];

    const jids = numbersToCheck.map(num => num.trim() + '@s.whatsapp.net');
    let existenceResults = [];
    try {
        existenceResults = await waClient.onWhatsApp(...jids);
    } catch(e) {
        console.error('Error onWhatsApp:', e);
        return ctx.reply('Gagal cek nomor, coba lagi nanti.');
    }

    const registeredJids = [];
    existenceResults.forEach(res => {
        if (res.exists) {
            registeredJids.push(res.jid);
        } else {
            notRegistered.push(res.jid.split('@')[0]);
        }
    });
    const registeredNumbers = registeredJids.map(jid => jid.split('@')[0]);

    if (registeredNumbers.length > 0) {
        const batchSize = config.settings.cekBioBatchSize || 15;
        for (let i = 0; i < registeredNumbers.length; i += batchSize) {
            const batch = registeredNumbers.slice(i, i + batchSize);
            const promises = batch.map(async (nomor) => {
                const jid = nomor.trim() + '@s.whatsapp.net';
                try {
                    const statusResult = await waClient.fetchStatus(jid);
                    let bioText = null, setAtText = null;
                    if (Array.isArray(statusResult) && statusResult.length > 0) {
                        const data = statusResult[0];
                        if (data) {
                            if (typeof data.status === 'string') bioText = data.status;
                            else if (typeof data.status === 'object' && data.status !== null) bioText = data.status.text || data.status.status;
                            setAtText = data.setAt || (data.status && data.status.setAt);
                        }
                    }
                    if (bioText && bioText.trim() !== '') {
                        withBio.push({ nomor, bio: bioText, setAt: setAtText });
                    } else { noBio.push(nomor); }
                } catch (e) {
                    notRegistered.push(nomor.trim());
                }
            });
            await Promise.allSettled(promises);
            await sleep(1000);
        }
    }

    let fileContent = "HASIL CEK BIO SEMUA USER\n\n";
    fileContent += `✅ Total nomor dicek : ${numbersToCheck.length}\n`;
    fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
    fileContent += `📵 Tanpa Bio        : ${noBio.length}\n`;
    fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n\n`;
    if (withBio.length > 0) {
        fileContent += `----------------------------------------\n\n`;
        fileContent += `✅ NOMOR DENGAN BIO (${withBio.length})\n\n`;
        const groupedByYear = withBio.reduce((acc, item) => {
            const year = (item.setAt) ? new Date(item.setAt).getFullYear() : 'Tahun Tidak Diketahui';
            if (!acc[year]) acc[year] = [];
            acc[year].push(item);
            return acc;
        }, {});
        const sortedYears = Object.keys(groupedByYear).sort();
        for (const year of sortedYears) {
            fileContent += `Tahun ${year}\n\n`;
            groupedByYear[year].sort((a, b) => new Date(a.setAt) - new Date(b.setAt)).forEach(item => {
                const date = new Date(item.setAt);
                let formattedDate = '...';
                if (!isNaN(date)) {
                    const datePart = date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    const timePart = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\./g, ':');
                    formattedDate = `${datePart}, ${timePart.replace(/:/g, '.')}`;
                }
                fileContent += `└─ 📅 ${item.nomor}\n   └─ 📝 "${item.bio}"\n      └─ ⏰ ${formattedDate}\n\n`;
            });
        }
    }
    fileContent += `----------------------------------------\n\n`;
    fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${noBio.length})\n\n`;
    if (noBio.length > 0) {
        noBio.forEach(nomor => { fileContent += `${nomor}\n`; });
    } else { fileContent += `(Kosong)\n`; }
    fileContent += `\n`;

    const filePath = `./hasil_cekbio_${ctx.from.id}.txt`;
    fs.writeFileSync(filePath, fileContent);
    await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya boskuu." });
    fs.unlinkSync(filePath);
}

const bot = new Telegraf(config.telegramBotToken);

const checkAccess = (level) => async (ctx, next) => {
    const userId = ctx.from.id;
    if (level === 'owner' && userId !== config.ownerId) {
        return ctx.reply(config.message.owner, { parse_mode: 'Markdown' });
    }
    if (level === 'premium') {
        const isPremium = getPremiumUsers().includes(userId);
        if (userId !== config.ownerId && !isPremium) {
            return ctx.reply(config.message.premium, { parse_mode: 'Markdown' });
        }
    }
    await next();
};

bot.command('start', (ctx) => {
    const userName = ctx.from.first_name || 'bos';
    const caption = `✨ *Wih, halo ${userName}!*\nGw siap bantu lu cek bio & info WhatsApp.\n\n🚀 *FITUR UTAMA*\n/cekbio <nomor1> <nomor2> ...\n/cekbiotxt (reply file .txt)\n\n👑 *PUNYA OWNER*\n/pairing <nomor>\n/addakses <id_user>\n/delakses <id_user>\n/listallakses\n/resetsession (hapus session WA)`;
    ctx.replyWithPhoto({ url: config.photoStart }, { caption: caption, parse_mode: 'Markdown' });
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
    const phoneNumber = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
    if (!phoneNumber) return ctx.reply("Formatnya salah bos.\nContoh: /pairing 62812...");
    try {
        await ctx.reply("Otw minta kode pairing...");
        const code = await waClient.requestPairingCode(phoneNumber);
        await ctx.reply(`📲 Nih kodenya bos: *${code}*\n\nMasukin di WA lu:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Gagal request pairing code:', e);
        ctx.reply('Gagal minta pairing code. Jika gagal, coba scan QR dari logs atau pairing manual.');
    }
});

bot.command('cekbio', checkAccess('premium'), async (ctx) => {
    const numbersToCheck = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];
    await handleBioCheck(ctx, numbersToCheck);
});

bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
    if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) {
        return ctx.reply("Reply file .txt nya dulu, bos.");
    }
    const doc = ctx.message.reply_to_message.document;
    if (doc.mime_type !== 'text/plain') { return ctx.reply("Filenya harus .txt, jangan yang lain."); }
    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await axios.get(fileLink.href);
        const numbersToCheck = response.data.match(/\d+/g) || [];
        await handleBioCheck(ctx, numbersToCheck);
    } catch (error) {
        console.error("Gagal proses file:", error);
        ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
    }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
    const command = ctx.message.text.split(' ')[0].slice(1);
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(targetId)) return ctx.reply("ID-nya angka, bos.");
    let premiumUsers = getPremiumUsers();
    if (command === 'addakses') {
        if (premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium.`);
        premiumUsers.push(targetId);
        savePremiumUsers(premiumUsers);
        ctx.reply(`✅ ID ${targetId} sekarang premium.`);
    } else {
        if (!premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} bukan premium.`);
        const newUsers = premiumUsers.filter(id => id !== targetId);
        savePremiumUsers(newUsers);
        ctx.reply(`✅ ID ${targetId} udah dicabut.`);
    }
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
    const premiumUsers = getPremiumUsers();
    if (premiumUsers.length === 0) return ctx.reply("Belum ada member premium, bos.");
    let text = "*Nih daftar member premium:*\n";
    premiumUsers.forEach(id => { text += `- ${id}\n`; });
    ctx.reply(text, { parse_mode: 'Markdown' });
});

// resetsession command - owner only
bot.command('resetsession', checkAccess('owner'), async (ctx) => {
    try {
        fs.rmSync(config.sessionName, { recursive: true, force: true });
        await ctx.reply("✅ Session dihapus. Silakan pairing ulang.");
    } catch (e) {
        await ctx.reply("⚠️ Gagal hapus session: " + e.message);
    }
});

(async () => {
    await startWhatsAppClient();
    bot.launch();
    console.log('Bot Telegram OTW!');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

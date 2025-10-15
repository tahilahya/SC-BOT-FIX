console.log('🚀 Memulai bot...');

const { Telegraf } = require('telegraf');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');

const premiumPath = './premium.json';

// === FUNGSI PENDUKUNG ===
const getPremiumUsers = () => {
    try { return JSON.parse(fs.readFileSync(premiumPath)); }
    catch (e) { fs.writeFileSync(premiumPath, '[]'); return []; }
};

const savePremiumUsers = (users) => fs.writeFileSync(premiumPath, JSON.stringify(users, null, 2));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// === WHATSAPP CLIENT ===
let waClient = null;
let waConnectionStatus = 'closed';
let reconnectTimer = null;

async function startWhatsAppClient() {
    console.log("🔌 Mencoba memulai koneksi WhatsApp...");

    try {
        const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);
        waClient = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: [config.settings.namabot || 'CekBioBot', 'Chrome', '1.0.0']
        });

        waClient.ev.on('creds.update', saveCreds);

        waClient.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            waConnectionStatus = connection;

            if (qr) console.log('📱 QR code muncul di logs (scan pakai WhatsApp)');

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;

                console.log('❌ Koneksi WA terputus:', new Boom(lastDisconnect?.error).message, '| Reconnect:', shouldReconnect);

                if (!shouldReconnect) {
                    console.log("🧹 Sesi terhapus. Silakan pairing ulang.");
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
        console.error("⚠️ Error inisialisasi WhatsApp client:", err);
        await sleep(5000);
        startWhatsAppClient();
    }
}

// === FUNGSI CEK BIO ===
async function handleBioCheck(ctx, numbersToCheck) {
    if (waConnectionStatus !== 'open') return ctx.reply(config.message.waNotConnected);
    if (!Array.isArray(numbersToCheck) || numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos?");

    await ctx.reply(`Otw boskuu... ngecek ${numbersToCheck.length} nomor.`);

    let withBio = [], noBio = [], notRegistered = [];

    try {
        const results = await Promise.all(numbersToCheck.map(num => waClient.onWhatsApp(num + '@s.whatsapp.net')));
        for (const resArr of results) {
            const res = resArr[0];
            if (!res?.exists) notRegistered.push(res?.jid?.split('@')[0]);
        }

        const registered = numbersToCheck.filter(num => !notRegistered.includes(num));
        for (const nomor of registered) {
            try {
                const jid = nomor + '@s.whatsapp.net';
                const status = await waClient.fetchStatus(jid);
                if (status && status.status) {
                    withBio.push({ nomor, bio: status.status, setAt: status.setAt });
                } else {
                    noBio.push(nomor);
                }
            } catch {
                noBio.push(nomor);
            }
        }
    } catch (e) {
        console.error('Error saat cek bio:', e);
        return ctx.reply('Gagal cek nomor, coba lagi nanti.');
    }

    let fileContent = `HASIL CEK BIO\n\n`;
    fileContent += `Total dicek: ${numbersToCheck.length}\n`;
    fileContent += `Dengan bio: ${withBio.length}\n`;
    fileContent += `Tanpa bio: ${noBio.length}\n`;
    fileContent += `Tidak terdaftar: ${notRegistered.length}\n\n`;

    if (withBio.length > 0) {
        fileContent += `=== DENGAN BIO ===\n`;
        withBio.forEach(x => {
            fileContent += `📞 ${x.nomor}\n📝 ${x.bio}\n⏰ ${x.setAt || '-'}\n\n`;
        });
    }
    if (noBio.length > 0) {
        fileContent += `=== TANPA BIO ===\n${noBio.join('\n')}\n\n`;
    }
    if (notRegistered.length > 0) {
        fileContent += `=== TIDAK TERDAFTAR ===\n${notRegistered.join('\n')}\n\n`;
    }

    const filePath = `./hasil_cekbio_${ctx.from.id}.txt`;
    fs.writeFileSync(filePath, fileContent);
    await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya boskuu." });
    fs.unlinkSync(filePath);
}

// === TELEGRAM BOT ===
const bot = new Telegraf(config.telegramBotToken);

const checkAccess = (level) => async (ctx, next) => {
    const userId = ctx.from.id;
    if (level === 'owner' && userId !== config.ownerId)
        return ctx.reply(config.message.owner);
    if (level === 'premium') {
        const isPremium = getPremiumUsers().includes(userId);
        if (userId !== config.ownerId && !isPremium)
            return ctx.reply(config.message.premium);
    }
    await next();
};

// === COMMANDS ===
bot.command('start', (ctx) => {
    const name = ctx.from.first_name || 'bos';
    ctx.replyWithPhoto(
        { url: config.photoStart },
        {
            caption: `✨ Halo ${name}!\nBot siap bantu cek bio WhatsApp.\n\nGunakan:\n/cekbio <nomor>\n/cekbiotxt (reply file .txt)`,
        }
    );
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
    const phone = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
    if (!phone) return ctx.reply("Format salah bos. Contoh: /pairing 62812...");
    try {
        await ctx.reply("Minta kode pairing...");
        const code = await waClient.requestPairingCode(phone);
        ctx.reply(`📲 Kode pairing: *${code}*`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(e);
        ctx.reply('Gagal minta pairing code.');
    }
});

bot.command('cekbio', checkAccess('premium'), async (ctx) => {
    const numbers = ctx.message.text.match(/\d+/g) || [];
    await handleBioCheck(ctx, numbers);
});

bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
    if (!ctx.message.reply_to_message?.document) return ctx.reply("Reply file .txt dulu.");
    const doc = ctx.message.reply_to_message.document;
    if (doc.mime_type !== 'text/plain') return ctx.reply("Filenya harus .txt");
    try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const res = await axios.get(link.href);
        const numbers = res.data.match(/\d+/g) || [];
        await handleBioCheck(ctx, numbers);
    } catch {
        ctx.reply("Gagal ambil nomor dari file.");
    }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
    const cmd = ctx.message.text.split(' ')[0].slice(1);
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(targetId)) return ctx.reply("ID harus angka.");
    let list = getPremiumUsers();
    if (cmd === 'addakses') {
        if (list.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium.`);
        list.push(targetId);
        savePremiumUsers(list);
        ctx.reply(`✅ ID ${targetId} jadi premium.`);
    } else {
        list = list.filter(id => id !== targetId);
        savePremiumUsers(list);
        ctx.reply(`❌ ID ${targetId} dihapus dari premium.`);
    }
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
    const list = getPremiumUsers();
    if (list.length === 0) return ctx.reply("Belum ada premium.");
    ctx.reply("Member Premium:\n" + list.map(x => `- ${x}`).join('\n'));
});

bot.command('resetsession', checkAccess('owner'), async (ctx) => {
    try {
        fs.rmSync(config.sessionName, { recursive: true, force: true });
        await ctx.reply("✅ Session dihapus, silakan pairing ulang.");
    } catch (e) {
        await ctx.reply("⚠️ Gagal hapus session: " + e.message);
    }
});

// === RUN ===
(async () => {
    await startWhatsAppClient();
    bot.launch();
    console.log('🤖 Bot Telegram siap jalan!');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

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

async function startWhatsAppClient() {
    console.log("Mencoba memulai koneksi WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);
    
    waClient = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Mac OS", "Safari", "10.15.7"]
    });

    waClient.ev.on('creds.update', saveCreds);

    waClient.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        waConnectionStatus = connection;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Koneksi WA tertutup, alasan:', reason);
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(startWhatsAppClient, 5000);
            } else {
                console.log('Logout permanen, hapus session.');
                fs.rmSync(config.sessionName, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
        }
    });
}

const bot = new Telegraf(config.telegramBotToken);
bot.command('start', (ctx) => ctx.reply('Bot aktif! ✅'));
(async () => {
    await startWhatsAppClient();
    bot.launch();
    console.log('Bot Telegram OTW!');
})();

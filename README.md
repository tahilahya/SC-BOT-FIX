SC-BOT-FINAL
============

Files:
- index.js (main bot)
- config.js (token included)
- package.json
- premium.json

Usage:
1. Upload to GitHub and connect to Railway or upload zip via 'Add files via upload'.
2. Deploy. If using Railway volumes, consider mounting /app/session to persistent volume.
3. Use Telegram commands:
   - /start
   - /pairing <628...> (owner only)
   - /cekbio <numbers...>
   - /cekbiotxt (reply .txt)
   - /resetsession (owner only)

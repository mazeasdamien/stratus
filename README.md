# Stratus

Your iCloud mailbox as a PWA, on one Cloudflare Worker — with Claude to help you write. It runs in your own Cloudflare account, on the free plan: no Stratus server holds your mail or your password.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mazeasdamien/stratus)

## Setup

1. **Deploy** with the button (give each secret a different long random string, and keep `BOOTSTRAP_KEY`), or:
   ```sh
   npm install && npx wrangler login
   npm run deploy                                   # prints https://stratus.<you>.workers.dev
   npm run secrets -- https://stratus.<you>.workers.dev
   ```
2. **Activate** each device once, a minute after the first deploy: `https://stratus.<you>.workers.dev/auth#k=<BOOTSTRAP_KEY>`. Keep that link private.
3. **Connect iCloud**: Settings → Connect iCloud, with an app-specific password from [account.apple.com](https://account.apple.com).

Optional: a custom domain (dashboard → Domains & Routes), an Anthropic key for Claude (account button → Writing assistant), sending from your own domain (`RELAY_DOMAINS` in `wrangler.jsonc`), and the Chrome extension in `extension/` (put your address in place of `mail.agentxr.app`).

## Features

Archive, move, star, snooze and search, written through to iCloud · drafts, scheduled send, undo send, aliases and Hide My Email · Claude: Fix, Improve, replies, thread summaries · invitations · remote images held back, one-click unsubscribe, blocked senders · PDF, `.eml`, zip, nightly backup · Web Push. Press `?` for the shortcuts.

## How it works

iCloud (IMAP/SMTP) ⇄ Worker + D1 + R2 ⇄ PWA. A cron syncs every minute and snapshots the database nightly; the iCloud password is sealed with AES-256-GCM; bodies are sanitised and shown in a sandboxed iframe. `npm run check` runs every test. `env.dmzs` in `wrangler.jsonc` is the maintainer's own instance, picked by `CLOUDFLARE_ENV=dmzs` in an untracked `.env`.

MIT licence. No warranty; your mail is your responsibility.

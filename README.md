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

Optional: a custom domain (dashboard → Domains & Routes), an Anthropic key for Claude (account button → Writing assistant), sending from your own domain (`RELAY_DOMAINS` in `wrangler.jsonc`), and the Chrome extension in `extension/` (load unpacked, then give it your address and `BOOTSTRAP_KEY`).

## Features

**Mail.** Archive, move, star, snooze, written through to iCloud · search with operators (`from:`, `has:attachment`, `is:unread`, `after:`, `"a phrase"`, `-word`; the `?` in the search box lists them) · named categories, pins, importance · follow-up flags with a reminder, and "remind me if nobody replies" · rules that sort mail as it arrives · drafts, scheduled send, undo send, aliases and Hide My Email, a signature per address · a warning before mail goes to a look-alike address, and on mail that poses as a well-known brand · emoji reactions · remote images held back, one-click unsubscribe, blocked senders · right-to-left mail, the files inside a `winmail.dat` · swipe actions you choose, drag to a folder.

**Calendar, People, Tasks.** Day, week and month views with recurring events, reminders and read-only subscriptions to calendars on the web; invitations from your mail appear among them · an address book with contact cards · a to-do list, with tasks made from a message. These three live in your Worker's database, not at iCloud.

**In and out.** `.eml` and `.mbox` for mail, `.ics` for calendars, `.vcf` for contacts · PDF, zip, nightly backup.

**Also.** Claude: Fix, Improve, replies, thread summaries · Web Push · offline reading on the devices that turn it on (Settings → Offline). Press `?` for the shortcuts.

## How it works

iCloud (IMAP/SMTP) ⇄ Worker + D1 + R2 ⇄ PWA. A cron syncs every minute and snapshots the database nightly; the iCloud password is sealed with AES-256-GCM; bodies are sanitised and shown in a sandboxed iframe. `npm run check` runs every test. `env.dmzs` in `wrangler.jsonc` is the maintainer's own instance, picked by `CLOUDFLARE_ENV=dmzs` in an untracked `.env`.

MIT licence. No warranty; your mail is your responsibility.

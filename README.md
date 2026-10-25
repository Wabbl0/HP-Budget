# HP Budget

A gamified, offline budget tracker for iPhone. Your remaining monthly budget is an HP bar: spending deals damage, income and refunds heal.

- Plain HTML/CSS/JS, no build step. Installable as a PWA (Safari → Share → Add to Home Screen).
- All data is stored on the device (localStorage). Use Settings → Export backup regularly.
- The site lives in `public/` and is hosted on Cloudflare Workers as static assets (`wrangler.jsonc`, deploy command `npx wrangler deploy`).

When changing any file, bump `CACHE` in `public/sw.js` so installed copies pick up the update.

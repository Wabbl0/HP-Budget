# HP Budget

A gamified, offline budget tracker for iPhone. Your remaining monthly budget is an HP bar: spending deals damage, income and refunds heal.

- Plain HTML/CSS/JS, no build step. Installable as a PWA (Safari → Share → Add to Home Screen).
- All data is stored on the device (localStorage). Use Settings → Export backup regularly.
- Hosted as a static site (Cloudflare Pages: no build command, output directory `/`).

When changing any file, bump `CACHE` in `sw.js` so installed copies pick up the update.

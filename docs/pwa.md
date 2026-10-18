# p66-tuner offline (PWA) support

p66-tuner works offline at the car or track. The app ships a
`manifest.webmanifest` and a service worker (`sw.js`) that:

- Registers only on `https:` or `localhost` (never on `file://`), so the app
  behaves identically when the service worker is unavailable.
- Precaches the full app shell on install — `index.html`, every script
  (including the lazily-loaded `js/ve3d.js`, `js/report.js`, `js/compare.js`),
  stylesheets, the manifest, and the icon — under a versioned cache
  (`p66-tuner-v2`). Old caches are deleted on activation.
- Serves same-origin GET requests cache-first; cross-origin requests, POSTs
  (uploads), and IndexedDB (your saved XDF shelf) pass through untouched.
- Falls back to the cached `index.html` for navigation requests when offline.

To install it on a phone or laptop: open the app over HTTPS (or localhost),
then use the browser's "Add to Home Screen" / "Install app" option. The app
opens in standalone mode with the `#10151d` theme.

Cache versioning: bump the `CACHE_NAME` string in `sw.js` whenever the app
shell changes; the activate handler drops every cache whose name doesn't
match. `tools/pwa-test.js` guards the manifest, icon, and service worker
structure (28 checks).

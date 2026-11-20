// Turns the Expo web export in dist/ into an installable Home Screen app:
// iPhone meta tags, a manifest, icons (made by the workflow), an offline service worker and .nojekyll for GitHub Pages.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dist = process.argv[2] ?? "dist";
const base = "/yearline-web";
const build = new Date().toISOString();

let html = readFileSync(join(dist, "index.html"), "utf8");
html = html.replace(/<meta name="viewport"[^>]*>/, "");
const head = `
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Yearline" />
    <meta name="theme-color" content="#000000" />
    <link rel="apple-touch-icon" href="${base}/icon-180.png" />
    <link rel="manifest" href="${base}/manifest.webmanifest" />
    <style>
      html, body { background: #000; overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
      input, textarea { -webkit-user-select: text; user-select: text; }
    </style>`;
html = html.replace("</head>", `${head}\n  </head>`);
const sw = `
    <script>
      if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("${base}/sw.js", { scope: "${base}/" }).catch(() => {}));
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    </script>`;
html = html.replace("</body>", `${sw}\n  </body>`);
writeFileSync(join(dist, "index.html"), html);

writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify({
  name: "Yearline", short_name: "Yearline", start_url: `${base}/`, scope: `${base}/`, display: "standalone",
  background_color: "#000000", theme_color: "#000000", orientation: "portrait",
  icons: [192, 512].map((s) => ({ src: `${base}/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })),
}, null, 2));

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(dist);
const urls = files.map((f) => `${base}/${relative(dist, f).split("\\").join("/")}`).filter((u) => !u.endsWith("/sw.js"));
writeFileSync(join(dist, "sw.js"), `// Yearline offline cache, build ${build}
const CACHE = "yearline-${build}";
const FILES = ${JSON.stringify([`${base}/`, ...urls])};
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // Pages: try the network first (so updates arrive), fall back to the saved copy offline. Everything else: saved copy first.
  if (req.mode === "navigate") { e.respondWith(fetch(req).catch(() => caches.match("${base}/"))); return; }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.length ? cs[0].focus() : self.clients.openWindow("${base}/"))); });
`);
writeFileSync(join(dist, ".nojekyll"), "");
console.log(`PWA ready: ${urls.length} files cached`);

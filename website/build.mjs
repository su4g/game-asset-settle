import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(root, "dist");
const site = new URL(process.env.SITE_URL || "https://www.suag.top/");
if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) throw new Error("SITE_URL must be a public HTTPS URL without credentials, query or fragment");
if (!site.pathname.endsWith("/")) site.pathname += "/";
await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, "site-assets"), { recursive: true });
// Explicit public-file allowlist. Never package the application, local account data or credentials.
const publicFiles = ["index.html", "robots.txt", "sitemap.xml"];
const assets = ["styles.css", "app.js", "app-icon.png", "buff.png", "uu.png", "steam.png"];
for (const name of publicFiles) await cp(path.join(root, "src", name), path.join(destination, name));
for (const name of assets) await cp(path.join(root, "src/assets", name), path.join(destination, "site-assets", name));
let html = await readFile(path.join(destination, "index.html"), "utf8");
html = html.replaceAll('"/site-assets/', `"${site.pathname}site-assets/`)
  .replaceAll("https://www.suag.top/", site.href);
for (const name of assets) {
  const content = await readFile(path.join(destination, "site-assets", name));
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  // Keep assets stable for screenshot replacement; version references for cache invalidation.
  html = html.replaceAll(`/site-assets/${name}`, `/site-assets/${name}?v=${hash}`);
}
await writeFile(path.join(destination, "index.html"), html);
for (const name of ["robots.txt", "sitemap.xml"]) {
  const content = await readFile(path.join(destination, name), "utf8");
  await writeFile(path.join(destination, name), content.replaceAll("https://www.suag.top/", site.href));
}
await writeFile(path.join(destination, ".nojekyll"), "");
const texts = [...publicFiles, "site-assets/styles.css", "site-assets/app.js"];
for (const name of texts) {
  const content = await readFile(path.join(destination, name));
  await writeFile(path.join(destination, `${name}.gz`), gzipSync(content, { level: 9 }));
}
const files = [...await readdir(destination), ...await readdir(path.join(destination, "site-assets"))];
console.log(`Static website built: ${destination} (${files.length - 1} files, no runtime dependencies). Site: ${site.href}`);

/**
 * After `vitepress build`, the links it doesn't check: every internal link's `#fragment` names an
 * id on its target page, and every link in the landing page's frontmatter reaches a built page.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../.vitepress/dist");
const INDEX = resolve(import.meta.dirname, "../index.md");
const problems: string[] = [];

const pages = (readdirSync(DIST, { recursive: true }) as string[])
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".html") && f !== "404.html" && !f.startsWith("assets/"));
const urlOf = (file: string) => `/${file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`;

const entities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const ids = new Map<string, Set<string>>();
const idsOf = (file: string) => {
  let set = ids.get(file);
  if (!set) {
    const html = readFileSync(join(DIST, file), "utf8");
    set = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => entities(id!)));
    ids.set(file, set);
  }
  return set;
};

/** The built file a site path names, or undefined if none is built. */
const fileOf = (path: string) => {
  const p = decode(path).replace(/^\//, "");
  const candidates = p === "" || p.endsWith("/") ? [`${p}index.html`] : [p.endsWith(".html") ? p : `${p}.html`, `${p}/index.html`];
  return candidates.find((c) => existsSync(join(DIST, c)));
};

/** Checks one link from a page at `from` (a site URL); returns why it's broken, or undefined. */
const broken = (href: string, from: string) => {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return; // external, mailto:, javascript:
  const url = new URL(href, `https://site${from}`);
  if (/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith(".html")) return; // .md, .txt, assets
  const file = fileOf(url.pathname);
  if (!file) return "no such page";
  const fragment = decode(url.hash.slice(1));
  if (fragment && !idsOf(file).has(fragment)) return `no #${fragment} on ${urlOf(file)}`;
};

for (const page of pages) {
  const html = readFileSync(join(DIST, page), "utf8");
  for (const [, raw] of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
    const href = entities(raw!);
    const why = broken(href, urlOf(page));
    if (why) problems.push(`${urlOf(page)} → ${href}: ${why}`);
  }
}

const frontmatter = readFileSync(INDEX, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
for (const [, raw] of frontmatter.matchAll(/^\s*(?:-\s+)?link:\s*(.+?)\s*$/gm)) {
  const href = raw!.replace(/^(["'])(.*)\1$/, "$2");
  const why = broken(href, "/");
  if (why) problems.push(`index.md frontmatter → ${href}: ${why}`);
}

if (problems.length > 0) {
  console.error(`Broken links in ${relative(process.cwd(), DIST)}:\n  ${[...new Set(problems)].join("\n  ")}`);
  process.exit(1);
}
console.log(`Links: ${pages.length} pages, every internal link and anchor resolves.`);

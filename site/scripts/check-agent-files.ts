/**
 * After `vitepress build`: every HTML page has its `{page}.md` and links it, no `.md` still holds
 * a directive, and `/llms.txt` lists every page with a title and a description.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../.vitepress/dist");
const problems: string[] = [];

const files = (readdirSync(DIST, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/"));
const html = files.filter((f) => f.endsWith(".html") && f !== "404.html" && !f.startsWith("assets/"));
const markdown = files.filter((f) => f.endsWith(".md"));
const read = (file: string) => readFileSync(join(DIST, file), "utf8");

for (const page of html) {
  const md = page.replace(/\.html$/, ".md");
  if (!markdown.includes(md)) problems.push(`${page}: no ${md}`);
  const link = `<link rel="alternate" type="text/markdown" href="/${md}">`;
  if (!read(page).includes(link)) problems.push(`${page}: no ${link}`);
}

for (const md of markdown) {
  const text = read(md);
  if (/^\s*<<</m.test(text)) problems.push(`${md}: holds a <<< import`);
  if (/@include/.test(text)) problems.push(`${md}: holds an @include`);
  if (text.startsWith("---\n")) problems.push(`${md}: holds its frontmatter`);
}

const llms = existsSync(join(DIST, "llms.txt")) ? read("llms.txt") : "";
if (!llms) problems.push("no llms.txt");
const entries = [...llms.matchAll(/^- \[(.*)\]\((\/[^)]*)\)(?::\s*(.*))?$/gm)];
for (const md of markdown) {
  const listed = entries.filter(([, , href]) => href === `/${md}`);
  if (listed.length !== 1) problems.push(`llms.txt: lists /${md} ${listed.length} times`);
  for (const [, title, , description] of listed) {
    if (!title?.trim()) problems.push(`${md}: no title`);
    if (!description?.trim()) problems.push(`${md}: no description`);
  }
}
for (const [, , href] of entries) {
  if (!existsSync(join(DIST, href!))) problems.push(`llms.txt: links ${href}, which isn't built`);
}

const full = existsSync(join(DIST, "llms-full.txt")) ? read("llms-full.txt") : "";
for (const md of markdown.filter((f) => f !== "index.md")) {
  if (!full.includes(read(md))) problems.push(`llms-full.txt: lacks ${md}`);
}
if (markdown.includes("index.md") && full.includes(`<!-- /index.md -->`)) {
  problems.push("llms-full.txt: holds the landing page");
}

if (problems.length > 0) {
  console.error(`Agent files in ${relative(process.cwd(), DIST)}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Agent files: ${markdown.length} pages, each with its .md, all in llms.txt.`);

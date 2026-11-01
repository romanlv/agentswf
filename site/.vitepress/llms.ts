import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MarkdownRenderer, SiteConfig } from "vitepress";

type Token = ReturnType<MarkdownRenderer["parse"]>[number] & { src?: [string, string] };
type Page = { title: string; description: string; markdown: string };

/** Each page's Markdown as a reader needs it, captured as VitePress renders the page. */
const pages = new Map<string, Page>();

/**
 * Records every page's Markdown after VitePress has rendered it, so `{page}.md` is built from the
 * same expansion as the HTML: `@include` already read into the source, every `<<<` sample read
 * into its fence and every fence's imports rewritten. Nothing here reads a sample on its own.
 */
export function captureMarkdown(md: MarkdownRenderer) {
  const render = md.renderer.render.bind(md.renderer);
  md.renderer.render = (tokens, options, env) => {
    const html = render(tokens, options, env);
    // The frontmatter plugin leaves the page without its frontmatter in `env.content`.
    if (typeof env?.content === "string" && env.relativePath) {
      pages.set(env.relativePath, {
        title: String(env.frontmatter?.title ?? ""),
        description: String(env.frontmatter?.description ?? ""),
        markdown: toMarkdown(tokens as Token[], env.content, env.frontmatter),
      });
    }
    return html;
  };
}

function toMarkdown(
  tokens: Token[],
  content: string,
  frontmatter: Frontmatter = {},
): string {
  const lines = content.split("\n");
  const edits: [start: number, end: number, replacement: string[]][] = [];
  for (const token of tokens) {
    if (!token.map) continue;
    const [start, end] = token.map;
    if (token.type === "fence") {
      const indent = lines[start]?.match(/^\s*/)?.[0] ?? "";
      const body = token.content.replace(/\n+$/, "");
      const longest = Math.max(2, ...(body.match(/^\s*`{3,}/gm) ?? []).map((m) => m.trim().length));
      const fence = "`".repeat(longest + 1);
      const lang = token.info.split(/[\s{[]/)[0];
      const block = [`${fence}${lang}`, ...body.split("\n"), fence];
      edits.push([start, end, block.map((line) => (line ? indent + line : line))]);
    } else if (token.type.startsWith("html_") && /^\s*<(script|style|[A-Z])/.test(token.content)) {
      // A Vue component or an SFC block; a component alone on its line parses as `html_inline`.
      edits.push([start, end, []]);
    }
  }
  for (const [start, end, replacement] of edits.reverse()) {
    lines.splice(start, end - start, ...replacement);
  }
  let markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // The landing page keeps its hero and features in frontmatter, which the Markdown would lose.
  if (frontmatter.layout === "home") markdown = `${homeMarkdown(frontmatter)}\n\n${markdown}`;
  return `${markdown}\n`;
}

/** A site link as its Markdown: `/guide/` is `/guide/index.md`, `/guide/agents` `/guide/agents.md`. */
const toMarkdownLink = (link: string) =>
  link.startsWith("/") ? link.replace(/\/$/, "/index").replace(/^([^#]*?)(#|$)/, "$1.md$2") : link;

type Link = { text?: string; link?: string };
type Frontmatter = {
  layout?: string;
  title?: string;
  description?: string;
  hero?: { name?: string; text?: string; tagline?: string; actions?: Link[] };
  features?: { title?: string; details?: string; link?: string }[];
};

function homeMarkdown({ hero = {}, features = [], title, description }: Frontmatter): string {
  const parts = [`# ${hero.name ?? title ?? ""}`];
  if (hero.text) parts.push(`**${hero.text}**`);
  parts.push(hero.tagline ?? description ?? "");
  const actions = (hero.actions ?? []).filter((a) => a.text && a.link);
  if (actions.length > 0) {
    parts.push(actions.map((a) => `- [${a.text}](${toMarkdownLink(a.link!)})`).join("\n"));
  }
  if (features.length > 0) {
    const items = features.map(({ title, details, link }) => {
      const name = link ? `[${title}](${toMarkdownLink(link)})` : title;
      return `- **${name}.** ${details ?? ""}`.trimEnd();
    });
    parts.push(items.join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

const AGENTS_TEMPLATE = join(
  import.meta.dirname,
  "../../packages/engine/src/init-template/AGENTS.md.template",
);

/** The path a page's Markdown is served at: `guide/agents.md` is `/guide/agents.md`. */
export const markdownHref = (relativePath: string) => `/${relativePath}`;

const linkOf = (relativePath: string) =>
  `/${relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;

/**
 * Writes `{page}.md` for every page, `/llms.txt` (the written preamble, then every page by the
 * site map's sections) and `/llms-full.txt` (every page but the landing page).
 */
export function writeAgentFiles(
  siteConfig: SiteConfig,
  siteMap: { text: string; items: [link: string, text: string][] }[],
) {
  const { outDir, pages: sources } = siteConfig;
  const missing = sources.filter((path) => !pages.has(path));
  if (missing.length > 0) throw new Error(`llms: no Markdown captured for ${missing.join(", ")}`);

  for (const [path, page] of pages) {
    if (!sources.includes(path)) continue;
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, page.markdown);
  }

  const mapped = siteMap.flatMap(({ items }) => items.map(([link]) => link));
  const sections = siteMap
    .map(({ text, items }) => ({
      text,
      paths: items.map(([link]) => sources.find((path) => linkOf(path) === link)).filter(isString),
    }))
    .filter(({ paths }) => paths.length > 0);
  const others = sources
    .filter((path) => path !== "index.md" && !mapped.includes(linkOf(path)))
    .sort();
  if (others.length > 0) sections.push({ text: "More", paths: others });
  if (sources.includes("index.md")) sections.unshift({ text: "Home", paths: ["index.md"] });

  const entry = (path: string) => {
    const { title, description } = pages.get(path)!;
    return `- [${title}](${markdownHref(path)}): ${description}`;
  };
  const preamble = readFileSync(join(import.meta.dirname, "llms-preamble.md"), "utf8").trim();
  const agentsMd = readFileSync(AGENTS_TEMPLATE, "utf8").trim();
  const rules = `## Rules for writing a workflow\n\nThe \`AGENTS.md\` that \`awf init\` writes into a workflow folder, as written:\n\n\`\`\`\`md\n${agentsMd}\n\`\`\`\``;
  const index = sections
    .map(({ text, paths }) => `## ${text}\n\n${paths.map(entry).join("\n")}`)
    .join("\n\n");
  writeFileSync(join(outDir, "llms.txt"), `${preamble}\n\n${rules}\n\n${index}\n`);

  const full = sections
    .flatMap(({ paths }) => paths)
    .filter((path) => path !== "index.md")
    .map((path) => `<!-- ${markdownHref(path)} -->\n\n${pages.get(path)!.markdown}`)
    .join("\n\n");
  writeFileSync(join(outDir, "llms-full.txt"), full);
}

const isString = (value: string | undefined): value is string => value !== undefined;

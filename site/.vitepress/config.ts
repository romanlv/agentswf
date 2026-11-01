import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type DefaultTheme, defineConfig } from "vitepress";

const SITE = resolve(import.meta.dirname, "..");
const REPO = "https://github.com/romanlv/agentswf";

const { version } = JSON.parse(
  readFileSync(join(SITE, "../packages/agentswf/package.json"), "utf8"),
) as { version: string };

/** The site map, in the story's order. A page shows once its `.md` exists, so sections fill in. */
const SITE_MAP: { text: string; items: [link: string, text: string][] }[] = [
  {
    text: "Get started",
    items: [
      ["/guide/", "Why agents.wf"],
      ["/guide/install", "Install"],
      ["/guide/quick-start", "Quick start"],
      ["/guide/how-it-works", "How it works"],
      ["/guide/limits", "Limits"],
    ],
  },
  { text: "Build with AI", items: [["/ai/", "Build with AI"]] },
  {
    text: "Learn: agents",
    items: [
      ["/guide/agents", "Agents"],
      ["/guide/harnesses", "Harnesses"],
      ["/guide/sandboxes", "Sandboxes"],
      ["/guide/tools", "Tools"],
    ],
  },
  {
    text: "Learn: workflows",
    items: [
      ["/guide/workflows", "Workflows"],
      ["/guide/parallel", "Parallel"],
      ["/guide/loops", "Loops"],
      ["/guide/deadlines", "Deadlines and nudges"],
      ["/guide/messaging", "Messaging"],
      ["/guide/decisions", "Decisions"],
      ["/guide/testing", "Testing"],
    ],
  },
  {
    text: "Learn: runs",
    items: [
      ["/guide/runs", "Runs"],
      ["/guide/durability", "Durability"],
      ["/guide/following-runs", "Following runs"],
    ],
  },
  {
    text: "In depth",
    items: [
      ["/guide/events", "Events"],
      ["/guide/people", "People"],
      ["/guide/hosting-events", "Hosting events"],
      ["/guide/calling-session", "Calling session"],
    ],
  },
  {
    text: "Running",
    items: [
      ["/guide/cost", "Cost"],
      ["/guide/security", "Security"],
      ["/guide/troubleshooting", "Troubleshooting"],
    ],
  },
  {
    text: "Patterns",
    items: [
      ["/patterns/review-loop", "Review loop"],
      ["/patterns/plan-implement", "Plan, implement, review"],
      ["/patterns/review-on-event", "Review on event"],
    ],
  },
  {
    text: "Reference",
    items: [
      ["/reference/workflow-api", "Workflow API"],
      ["/reference/testing-api", "Testing API"],
      ["/reference/awf", "awf"],
      ["/reference/data", "Data"],
      ["/reference/configuration", "Configuration"],
    ],
  },
];

const exists = (link: string) =>
  existsSync(join(SITE, link.endsWith("/") ? `${link}index.md` : `${link}.md`));

const sidebar: DefaultTheme.SidebarItem[] = SITE_MAP.map(({ text, items }) => ({
  text,
  items: items.filter(([link]) => exists(link)).map(([link, text]) => ({ text, link })),
})).filter((group) => group.items.length > 0);

const firstIn = (prefix: string) =>
  SITE_MAP.flatMap(({ items }) => items.map(([link]) => link)).find(
    (link) => link.startsWith(prefix) && exists(link),
  );

const nav: DefaultTheme.NavItem[] = [
  ...(
    [
      ["Guide", "/guide/", "^/(guide|ai)/"],
      ["Patterns", "/patterns/", "^/patterns/"],
      ["Reference", "/reference/", "^/reference/"],
    ] as const
  ).flatMap(([text, prefix, activeMatch]) => {
    const link = firstIn(prefix);
    return link ? [{ text, link, activeMatch }] : [];
  }),
  { text: `v${version}`, link: `https://www.npmjs.com/package/agentswf/v/${version}` },
];

/**
 * Examples import the workspace's names for the author surface; a reader's workflow imports the
 * published ones, which `awf test` and `awf run` serve as the same modules.
 */
const PUBLIC_IMPORTS: [from: string, to: string][] = [
  ['"@agentswf/contract/workflow"', '"agentswf/workflow"'],
  ['"@agentswf/engine/workflow-testing"', '"agentswf/testing"'],
];

export default defineConfig({
  title: "agents.wf",
  description: "Workflows for coding agents, in TypeScript.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["**/AGENTS.md", "**/README.md"],
  sitemap: { hostname: "https://agents.wf" },
  markdown: {
    // Before VitePress's own plugins, so this fence runs innermost: after `<<<` has read the file.
    preConfig(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, ...rest) => {
        const token = tokens[idx]!;
        for (const [from, to] of PUBLIC_IMPORTS) token.content = token.content.replaceAll(from, to);
        return fence(tokens, idx, ...rest);
      };
    },
    config(md) {
      // VitePress leaves an `@include` it cannot read in the page, silently.
      md.core.ruler.push("unresolved-include", (state) => {
        const unresolved = state.src.match(/<!--\s*@include:\s*(.*?)\s*-->/);
        if (unresolved) {
          throw new Error(`${state.env.relativePath}: cannot include ${unresolved[1]}`);
        }
      });
    },
  },
  themeConfig: {
    nav,
    sidebar,
    socialLinks: [
      { icon: "github", link: REPO },
      { icon: "npm", link: "https://www.npmjs.com/package/agentswf" },
    ],
    editLink: {
      pattern: `${REPO}/edit/main/site/:path`,
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
  },
});

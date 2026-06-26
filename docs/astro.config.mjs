// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkGfm from "remark-gfm";
import starlightLlmsTxt from "starlight-llms-txt";

// Deploy defaults target this repo's GitHub Pages project URL
// (https://danielscholl.github.io/keelson/). For a custom domain, set base to
// "/" and add a CNAME. The bespoke landing in public/ uses relative links, so it
// rides whatever base is set here.
export default defineConfig({
  site: "https://danielscholl.github.io",
  base: "/keelson",
  trailingSlash: "always",
  // Installing a rib is an operator how-to, not a tutorial rung, so it lives in
  // the guides tier; this preserves the old tutorial URL for bookmarks and search.
  redirects: {
    "/docs/tutorials/install-a-rib": "/keelson/docs/guides/managing-ribs/",
  },
  // Astro 6 dropped GFM from the MDX pipeline that Starlight uses, which silently
  // breaks Markdown tables in .mdx; re-add it on the channel the MDX integration
  // reads. (Piggybacks on the remarkPlugins deprecation Starlight already emits.)
  markdown: {
    remarkPlugins: [remarkGfm],
  },
  // The Starter workflows page builds its cards from the bundled workflow YAML in
  // packages/workflows/, outside this project's root. Let the dev server read it.
  vite: {
    server: { fs: { allow: [".."] } },
  },
  integrations: [
    starlight({
      title: "Keelson",
      description: "A local agent harness. Pluggable ribs, deterministic workflows.",
      favicon: "/assets/keelson-mark.svg",
      customCss: ["./src/styles/keelson-theme.css"],
      // Emits /llms.txt, /llms-full.txt, /llms-small.txt at build (llmstxt.org).
      plugins: [
        starlightLlmsTxt({
          projectName: "Keelson",
          description:
            "A single-user, local-only agent harness: pluggable ribs, deterministic YAML workflows, a typed extension contract.",
        }),
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/danielscholl/keelson" },
      ],
      sidebar: [
        { label: "Overview", link: "/docs/" },
        { label: "Concepts", items: [{ autogenerate: { directory: "docs/concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
        { label: "Tutorials", items: [{ autogenerate: { directory: "docs/tutorials" } }] },
        { label: "Workflows", items: [{ autogenerate: { directory: "docs/workflows" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
        { label: "Design", items: [{ autogenerate: { directory: "docs/design" } }] },
      ],
    }),
  ],
});

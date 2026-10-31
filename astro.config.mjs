// @ts-check
import { defineConfig } from 'astro/config';

import { loadConfig } from './scripts/lib/config.mjs';

// The config is loaded and validated here as well as in the components, so a
// broken `site.config.json` fails the build immediately rather than midway
// through rendering.
const config = loadConfig();

/**
 * Which host this build is for.
 *
 * Both hosts serve at a domain root in the usual case, so the difference only
 * shows up for a GitHub project site with no custom domain: that one is served
 * from `<owner>.github.io/<repo>/` and needs `base` set, or every asset
 * resolves against the wrong origin and 404s.
 *
 * The value comes from the environment because one source produces both
 * builds, and the Astro CLI has no `--base` flag.
 */
const target =
  process.env.DEPLOY_TARGET === 'github-pages' ? 'github-pages' : 'cloudflare-pages';

const deploy = config.deploy;
const site = target === 'github-pages' ? deploy.githubPages.site : deploy.cloudflarePages.site;
const base = target === 'github-pages' ? deploy.githubPages.basePath : '';

export default defineConfig({
  site,
  ...(base ? { base } : {}),
  build: {
    format: 'directory',
  },
});

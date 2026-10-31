// @ts-check
import { defineConfig } from 'astro/config';

import { loadConfig } from './scripts/lib/config.mjs';

// The config is loaded and validated here as well as in the components, so a
// broken `site.config.json` fails the build immediately rather than midway
// through rendering. `site` becomes the canonical URL: the first custom domain
// when one is configured, otherwise the Pages subdomain.
const site = loadConfig();

export default defineConfig({
  site: site.customDomains.length
    ? `https://${site.customDomains[0]}`
    : `https://${site.projectName}.pages.dev`,
  build: {
    format: 'directory',
  },
});

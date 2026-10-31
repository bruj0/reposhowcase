/**
 * Typed entry point to the site config for Astro.
 *
 * The validation lives in `scripts/lib/config.mjs` so that Node scripts and
 * the build read the same file through the same rules. This module exists
 * only to give the components types.
 */

import rawConfig from '../../site.config.json';
import { validateConfig } from '../../scripts/lib/config.mjs';
import type { SiteConfig } from '../../scripts/lib/config.mjs';

export type { SiteConfig };

/**
 * The resolved config. Importing it validates it: a bad config throws here,
 * which fails the build rather than rendering something wrong.
 */
export const site: SiteConfig = validateConfig(rawConfig);

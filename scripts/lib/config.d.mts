/** Types for `scripts/lib/config.mjs`, which is plain ESM so scripts can share it. */

export interface BrandLink {
  label: string;
  href: string;
}

export interface Brand {
  name: string;
  eyebrow: string;
  title: string;
  description: string;
  headline: string;
  lede: string;
  cta: BrandLink;
  links: BrandLink[];
}

export interface CatalogueRules {
  include: string[];
  exclude: string[];
  includeForks: boolean;
  includeArchived: boolean;
  empty: {
    stubReadmeBytes: number;
    discussionBytes: number;
  };
  unnoticed: {
    maxStars: number;
    maxViews: number;
    maxFiles: number;
  };
}

export interface Taxonomy {
  purpose: string[];
  platform: string[];
  language: string[];
}

export interface SiteConfig {
  projectName: string;
  productionBranch: string;
  buildOutputDir: string;
  githubOwner: string;
  customDomains: string[];
  tokenExpiryDays: number;
  deployTokenName: string;
  brand: Brand;
  catalogue: CatalogueRules;
  taxonomy: Taxonomy;
  sort: {
    default: string;
    options: string[];
  };
}

export const CONFIG_PATH: string;

export class ConfigError extends Error {
  key: string;
}

export function render(
  template: string,
  subject: Record<string, string>,
  context?: string,
): string;

export function loadConfig(file?: string): SiteConfig;

export function validateConfig(raw: unknown): SiteConfig;

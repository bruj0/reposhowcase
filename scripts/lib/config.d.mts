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

export interface CloudflarePagesTarget {
  /** The Pages project, which is also the `*.pages.dev` subdomain. */
  projectName: string;
  customDomains: string[];
  /** Canonical URL: the first custom domain, else the pages.dev subdomain. */
  site: string;
}

export interface GitHubPagesTarget {
  /** `owner/name` for an external artifact repository; null for this one. */
  repository: string | null;
  owner: string;
  name: string;
  branch: string;
  customDomain: string | null;
  /** Empty at a domain root; `/<name>` for a project site. Derived. */
  basePath: string;
  site: string;
}

export interface Deploy {
  targets: string[];
  cloudflarePages: CloudflarePagesTarget;
  githubPages: GitHubPagesTarget;
}

export interface SiteConfig {
  projectName: string;
  productionBranch: string;
  buildOutputDir: string;
  githubOwner: string;
  /**
   * Compatibility alias for `deploy.cloudflarePages.customDomains`.
   *
   * `cf-setup.mjs` works on a mutable copy while it discovers zones, so it
   * reads this. New code should read `deploy` instead.
   */
  customDomains: string[];
  deploy: Deploy;
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

export function validateDeploy(
  raw: unknown,
  projectName: string,
  githubOwner: string,
): Deploy;

export const DEPLOY_TARGETS: string[];

/**
 * The `site.config.json` contract: parse, validate, resolve placeholders.
 *
 * This module is the single JavaScript implementation. `src/lib/site.ts` adds
 * types on top of it, and `scripts/lib/config.py` is the Python equivalent.
 * Two implementations exist because Python scripts need the same values; a
 * check compares their output on the real config so they cannot drift.
 *
 * Validation is strict on purpose. A key that is misspelled, a sort mode that
 * is not offered, or a placeholder that names nothing must fail the build
 * rather than fall back to a default — a silent default is how two names for
 * one project happen.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Absolute path to the config this repository builds from. */
export const CONFIG_PATH = path.join(ROOT, 'site.config.json');

/** A Pages project name is also a `*.pages.dev` subdomain. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,57}$/;

/** Lowercase words joined by single hyphens. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A hostname, not a URL and not a wildcard. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** A `{placeholder}` inside a brand string. */
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Raised when the config is unusable. Names the key that is wrong. */
export class ConfigError extends Error {
  /**
   * @param {string} key Dotted path, e.g. `sort.default`.
   * @param {string} message What is wrong with it.
   */
  constructor(key, message) {
    super(`site.config.json: ${key} ${message}`);
    this.name = 'ConfigError';
    this.key = key;
  }
}

/**
 * Read one required string.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} context
 * @returns {string}
 */
function requireString(source, key, context) {
  const value = source?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${context}${key}`, 'must be a non-empty string');
  }
  return value;
}

/**
 * Read an optional number with a floor.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} context
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(source, key, context, fallback) {
  const value = source?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${context}${key}`, 'must be a number of zero or more');
  }
  return value;
}

/**
 * Read an optional boolean.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} context
 * @param {boolean} fallback
 * @returns {boolean}
 */
function booleanOr(source, key, context, fallback) {
  const value = source?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${context}${key}`, 'must be true or false');
  }
  return value;
}

/**
 * Read an array of strings and reject anything else.
 *
 * @param {unknown} value
 * @param {string} context
 * @returns {string[]}
 */
function stringList(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(context, 'must be an array of strings');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${context}[${index}]`, 'must be a non-empty string');
    }
    return entry;
  });
}

/**
 * Replace `{placeholder}` tokens in one string.
 *
 * An unknown placeholder is an error rather than being left in place: `{name}`
 * surviving into the page is a broken build that still looks like a build.
 *
 * @param {string} template
 * @param {Record<string, string>} subject
 * @param {string} context
 * @returns {string}
 */
export function render(template, subject, context = 'brand') {
  return template.replace(PLACEHOLDER, (whole, key) => {
    if (!(key in subject)) {
      throw new ConfigError(
        context,
        `uses {${key}}, which is not one of: ${Object.keys(subject).join(', ')}`,
      );
    }
    return subject[key];
  });
}

/**
 * Load and validate the config.
 *
 * @param {string} [file] Path to a config file; defaults to this repository's.
 * @returns {object} The config with every brand string resolved.
 */
export function loadConfig(file = CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, `could not be read as JSON (${err.message})`);
  }
  return validateConfig(raw);
}

/**
 * Validate an already-parsed config.
 *
 * Split from `loadConfig` because the Astro build imports the JSON through
 * Vite rather than reading it from disk: inside a bundled prerender module
 * `import.meta.url` points at `dist/`, so resolving the file that way finds
 * nothing. Keeping the pure half separate means the build never touches the
 * filesystem.
 *
 * @param {unknown} raw Parsed JSON.
 * @returns {object} The config with every brand string resolved.
 */
export function validateConfig(raw) {
  const projectName = requireString(raw, 'projectName', '');
  if (!PROJECT_NAME.test(projectName)) {
    throw new ConfigError(
      'projectName',
      `must be lowercase letters, digits and hyphens (got "${projectName}")`,
    );
  }

  const productionBranch = requireString(raw, 'productionBranch', '');
  const buildOutputDir = requireString(raw, 'buildOutputDir', '');
  const githubOwner = requireString(raw, 'githubOwner', '');

  const customDomains = stringList(raw.customDomains, 'customDomains').map((domain) => {
    const name = domain.trim().toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(name)) {
      throw new ConfigError('customDomains', `contains "${domain}", which is not a hostname`);
    }
    return name;
  });
  if (new Set(customDomains).size !== customDomains.length) {
    throw new ConfigError('customDomains', 'contains a duplicate hostname');
  }

  // --- brand -------------------------------------------------------------
  const brandRaw = raw.brand;
  if (typeof brandRaw !== 'object' || brandRaw === null) {
    throw new ConfigError('brand', 'must be an object');
  }

  const brandName = requireString(brandRaw, 'name', 'brand.');

  /** Everything a `{placeholder}` may resolve to. */
  const subject = { name: brandName, projectName, githubOwner };

  /**
   * Resolve a brand string.
   *
   * @param {Record<string, unknown>} source
   * @param {string} key
   * @returns {string}
   */
  const brandString = (source, key) =>
    render(requireString(source, key, 'brand.'), subject, `brand.${key}`);

  const ctaRaw = brandRaw.cta;
  if (typeof ctaRaw !== 'object' || ctaRaw === null) {
    throw new ConfigError('brand.cta', 'must be an object with label and href');
  }

  const linksRaw = brandRaw.links;
  if (!Array.isArray(linksRaw) || linksRaw.length === 0) {
    throw new ConfigError('brand.links', 'must be a non-empty array');
  }

  const brand = {
    name: brandName,
    eyebrow: brandString(brandRaw, 'eyebrow'),
    title: brandString(brandRaw, 'title'),
    description: brandString(brandRaw, 'description'),
    headline: brandString(brandRaw, 'headline'),
    lede: brandString(brandRaw, 'lede'),
    cta: {
      label: render(requireString(ctaRaw, 'label', 'brand.cta.'), subject, 'brand.cta.label'),
      href: render(requireString(ctaRaw, 'href', 'brand.cta.'), subject, 'brand.cta.href'),
    },
    links: linksRaw.map((link, index) => {
      if (typeof link !== 'object' || link === null) {
        throw new ConfigError(`brand.links[${index}]`, 'must be an object');
      }
      return {
        label: render(
          requireString(link, 'label', `brand.links[${index}].`),
          subject,
          `brand.links[${index}].label`,
        ),
        href: render(
          requireString(link, 'href', `brand.links[${index}].`),
          subject,
          `brand.links[${index}].href`,
        ),
      };
    }),
  };

  // --- catalogue ---------------------------------------------------------
  const catalogueRaw = raw.catalogue ?? {};
  if (typeof catalogueRaw !== 'object' || catalogueRaw === null) {
    throw new ConfigError('catalogue', 'must be an object');
  }

  const include = stringList(catalogueRaw.include, 'catalogue.include');
  const exclude = stringList(catalogueRaw.exclude, 'catalogue.exclude');

  // An allowlist and a denylist that name the same repository is a contradiction.
  const both = include.filter((name) => exclude.includes(name));
  if (both.length > 0) {
    throw new ConfigError(
      'catalogue.include',
      `and catalogue.exclude both name ${both.join(', ')}`,
    );
  }

  const emptyRaw = catalogueRaw.empty ?? {};
  const unnoticedRaw = catalogueRaw.unnoticed ?? {};

  const catalogue = {
    include,
    exclude,
    includeForks: booleanOr(catalogueRaw, 'includeForks', 'catalogue.', false),
    includeArchived: booleanOr(catalogueRaw, 'includeArchived', 'catalogue.', false),
    empty: {
      stubReadmeBytes: numberOr(emptyRaw, 'stubReadmeBytes', 'catalogue.empty.', 120),
      discussionBytes: numberOr(emptyRaw, 'discussionBytes', 'catalogue.empty.', 400),
    },
    unnoticed: {
      maxStars: numberOr(unnoticedRaw, 'maxStars', 'catalogue.unnoticed.', 0),
      maxViews: numberOr(unnoticedRaw, 'maxViews', 'catalogue.unnoticed.', 0),
      maxFiles: numberOr(unnoticedRaw, 'maxFiles', 'catalogue.unnoticed.', 10),
    },
  };

  // --- taxonomy ----------------------------------------------------------
  const taxonomyRaw = raw.taxonomy;
  if (typeof taxonomyRaw !== 'object' || taxonomyRaw === null) {
    throw new ConfigError('taxonomy', 'must be an object with purpose, platform and language');
  }

  const taxonomy = {};
  for (const axis of ['purpose', 'platform', 'language']) {
    const values = stringList(taxonomyRaw[axis], `taxonomy.${axis}`);
    if (values.length === 0) {
      throw new ConfigError(`taxonomy.${axis}`, 'must list at least one value');
    }
    for (const value of values) {
      if (!SLUG.test(value)) {
        throw new ConfigError(
          `taxonomy.${axis}`,
          `contains "${value}", which must be lowercase letters, digits and hyphens`,
        );
      }
    }
    taxonomy[axis] = values;
  }

  // --- sort --------------------------------------------------------------
  const sortRaw = raw.sort;
  if (typeof sortRaw !== 'object' || sortRaw === null) {
    throw new ConfigError('sort', 'must be an object with default and options');
  }
  const options = stringList(sortRaw.options, 'sort.options');
  if (options.length === 0) {
    throw new ConfigError('sort.options', 'must list at least one mode');
  }
  const sortDefault = requireString(sortRaw, 'default', 'sort.');
  if (!options.includes(sortDefault)) {
    throw new ConfigError(
      'sort.default',
      `is "${sortDefault}", which is not in sort.options (${options.join(', ')})`,
    );
  }

  return {
    projectName,
    productionBranch,
    buildOutputDir,
    githubOwner,
    customDomains,
    tokenExpiryDays: numberOr(raw, 'tokenExpiryDays', '', 365),
    deployTokenName:
      typeof raw.deployTokenName === 'string' && raw.deployTokenName.trim() !== ''
        ? raw.deployTokenName
        : `${projectName}-pages-deploy`,
    brand,
    catalogue,
    taxonomy,
    sort: { default: sortDefault, options },
  };
}

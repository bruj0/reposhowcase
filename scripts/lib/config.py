"""The ``site.config.json`` contract, for the Python utilities.

This is the Python equivalent of ``scripts/lib/config.mjs``. Two
implementations exist because the site is built with Node and the catalogue
utilities are Python; ``scripts/check-config.mjs`` compares their output on the
real config so they cannot drift.

Validation is strict on purpose. A misspelled key, a sort mode that is not
offered, or a ``{placeholder}`` that names nothing must raise rather than fall
back to a default.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "site.config.json"

PROJECT_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,57}$")
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HOSTNAME = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_]+)\}")

#: The hosts this build knows how to publish to.
DEPLOY_TARGETS = ("cloudflare-pages", "github-pages")

#: A repository name, optionally ``owner/name``.
REPOSITORY = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$")


class ConfigError(Exception):
    """Raised when the config is unusable. Names the key that is wrong."""

    def __init__(self, key: str, message: str) -> None:
        super().__init__(f"site.config.json: {key} {message}")
        self.key = key


def _require_string(source: dict, key: str, context: str = "") -> str:
    value = (source or {}).get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{context}{key}", "must be a non-empty string")
    return value


def _number_or(source: dict, key: str, context: str, fallback: float) -> float:
    value = (source or {}).get(key)
    if value is None:
        return fallback
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        raise ConfigError(f"{context}{key}", "must be a number of zero or more")
    return value


def _boolean_or(source: dict, key: str, context: str, fallback: bool) -> bool:
    value = (source or {}).get(key)
    if value is None:
        return fallback
    if not isinstance(value, bool):
        raise ConfigError(f"{context}{key}", "must be true or false")
    return value


def _string_list(value, context: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ConfigError(context, "must be an array of strings")
    out = []
    for index, entry in enumerate(value):
        if not isinstance(entry, str) or not entry.strip():
            raise ConfigError(f"{context}[{index}]", "must be a non-empty string")
        out.append(entry)
    return out


def render(template: str, subject: dict[str, str], context: str = "brand") -> str:
    """Replace ``{placeholder}`` tokens. An unknown one is an error."""

    def substitute(match: re.Match) -> str:
        key = match.group(1)
        if key not in subject:
            raise ConfigError(
                context,
                f"uses {{{key}}}, which is not one of: {', '.join(sorted(subject))}",
            )
        return subject[key]

    return PLACEHOLDER.sub(substitute, template)


def _hostname_list(value, key: str) -> list[str]:
    """Lowercase, strip a trailing dot, and reject a duplicate or a non-hostname."""
    names = []
    for domain in _string_list(value, key):
        name = domain.strip().lower().rstrip(".")
        if not HOSTNAME.match(name):
            raise ConfigError(key, f'contains "{domain}", which is not a hostname')
        names.append(name)
    if len(set(names)) != len(names):
        raise ConfigError(key, "contains a duplicate hostname")
    return names


def _claimed_hostnames(domain: str) -> list[str]:
    """The hostnames a GitHub Pages custom domain answers for.

    GitHub redirects between an apex and its ``www`` once the records exist, so
    choosing one of them claims both. Both are checked against the other target,
    because a hostname served by two hosts is a coin toss at resolve time rather
    than a configuration.
    """
    if domain.startswith("www."):
        return [domain, domain[4:]]
    return [domain, f"www.{domain}"]


def validate_deploy(raw: dict, project_name: str, github_owner: str) -> dict:
    """Validate and resolve the ``deploy`` block.

    This block is the only place a deployment target is chosen. ``basePath`` and
    ``site`` are derived rather than stated, because they follow from the target
    and the repository name — and a second place to write them is a second place
    to be wrong.
    """
    deploy_raw = raw.get("deploy") or {}
    if not isinstance(deploy_raw, dict):
        raise ConfigError("deploy", "must be an object")

    targets = _string_list(deploy_raw.get("targets"), "deploy.targets")
    if not targets:
        raise ConfigError("deploy.targets", "must list at least one target")
    for target in targets:
        if target not in DEPLOY_TARGETS:
            known = ", ".join(DEPLOY_TARGETS)
            raise ConfigError(
                "deploy.targets", f'contains "{target}", which is not a known target ({known})'
            )
    if len(set(targets)) != len(targets):
        raise ConfigError("deploy.targets", "contains a duplicate target")

    cf_raw = deploy_raw.get("cloudflarePages") or {}
    if not isinstance(cf_raw, dict):
        raise ConfigError("deploy.cloudflarePages", "must be an object")
    cloudflare_domains = _hostname_list(
        cf_raw.get("customDomains"), "deploy.cloudflarePages.customDomains"
    )

    gh_raw = deploy_raw.get("githubPages") or {}
    if not isinstance(gh_raw, dict):
        raise ConfigError("deploy.githubPages", "must be an object")

    # Omitted means "the repository this build lives in", which is what a public
    # repository needs and what needs no credential to push to.
    repository = gh_raw.get("repository")
    if repository is not None:
        repository = _require_string(gh_raw, "repository", "deploy.githubPages.")
        if not REPOSITORY.match(repository):
            raise ConfigError(
                "deploy.githubPages.repository",
                f'must be "name" or "owner/name" (got "{repository}")',
            )

    branch = gh_raw.get("branch")
    if not isinstance(branch, str) or not branch.strip():
        branch = "gh-pages"
    else:
        branch = branch.strip()

    custom_domain = None
    raw_domain = gh_raw.get("customDomain")
    if raw_domain is not None:
        value = _require_string(gh_raw, "customDomain", "deploy.githubPages.")
        name = value.strip().lower().rstrip(".")
        if not HOSTNAME.match(name):
            raise ConfigError(
                "deploy.githubPages.customDomain", f'is "{value}", which is not a hostname'
            )
        collision = next(
            (host for host in _claimed_hostnames(name) if host in cloudflare_domains), None
        )
        if collision:
            raise ConfigError(
                "deploy.githubPages.customDomain",
                f'"{collision}" is claimed by both cloudflarePages and githubPages',
            )
        custom_domain = name

    # A project site without a custom domain is served under a path prefix; with
    # one, at the domain root.
    if repository is None:
        owner, name = github_owner, project_name
    elif "/" in repository:
        owner, name = repository.split("/", 1)
    else:
        owner, name = github_owner, repository

    github_pages = {
        "repository": repository,
        "owner": owner,
        "name": name,
        "branch": branch,
        "customDomain": custom_domain,
        "basePath": "" if custom_domain else f"/{name}",
        "site": (
            f"https://{custom_domain}"
            if custom_domain
            else f"https://{owner}.github.io/{name}/"
        ),
    }

    cloudflare_pages = {
        "projectName": project_name,
        "customDomains": cloudflare_domains,
        "site": (
            f"https://{cloudflare_domains[0]}"
            if cloudflare_domains
            else f"https://{project_name}.pages.dev"
        ),
    }

    return {
        "targets": targets,
        "cloudflarePages": cloudflare_pages,
        "githubPages": github_pages,
    }


def load_config(file: Path | str | None = None) -> dict:
    """Load and validate the config, returning every brand string resolved."""
    path = Path(file) if file else CONFIG_PATH
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ConfigError(str(path), f"could not be read as JSON ({err})") from err

    project_name = _require_string(raw, "projectName")
    if not PROJECT_NAME.match(project_name):
        raise ConfigError(
            "projectName",
            f'must be lowercase letters, digits and hyphens (got "{project_name}")',
        )

    production_branch = _require_string(raw, "productionBranch")
    build_output_dir = _require_string(raw, "buildOutputDir")
    github_owner = _require_string(raw, "githubOwner")

    # --- deploy ----------------------------------------------------------
    # Domains belong to a target, not to the site: two hosts may own different
    # names, and neither may claim a name the other answers for.
    deploy = validate_deploy(raw, project_name, github_owner)

    # Compatibility alias. `cf-setup.mjs` works on a mutable copy while it
    # discovers zones, so it reads this rather than reaching into `deploy`.
    custom_domains = deploy["cloudflarePages"]["customDomains"]

    brand_raw = raw.get("brand")
    if not isinstance(brand_raw, dict):
        raise ConfigError("brand", "must be an object")

    brand_name = _require_string(brand_raw, "name", "brand.")
    subject = {"name": brand_name, "projectName": project_name, "githubOwner": github_owner}

    def brand_string(key: str) -> str:
        return render(_require_string(brand_raw, key, "brand."), subject, f"brand.{key}")

    cta_raw = brand_raw.get("cta")
    if not isinstance(cta_raw, dict):
        raise ConfigError("brand.cta", "must be an object with label and href")

    links_raw = brand_raw.get("links")
    if not isinstance(links_raw, list) or not links_raw:
        raise ConfigError("brand.links", "must be a non-empty array")

    links = []
    for index, link in enumerate(links_raw):
        if not isinstance(link, dict):
            raise ConfigError(f"brand.links[{index}]", "must be an object")
        links.append(
            {
                "label": render(
                    _require_string(link, "label", f"brand.links[{index}]."),
                    subject,
                    f"brand.links[{index}].label",
                ),
                "href": render(
                    _require_string(link, "href", f"brand.links[{index}]."),
                    subject,
                    f"brand.links[{index}].href",
                ),
            }
        )

    brand = {
        "name": brand_name,
        "eyebrow": brand_string("eyebrow"),
        "title": brand_string("title"),
        "description": brand_string("description"),
        "headline": brand_string("headline"),
        "lede": brand_string("lede"),
        "cta": {
            "label": render(
                _require_string(cta_raw, "label", "brand.cta."), subject, "brand.cta.label"
            ),
            "href": render(
                _require_string(cta_raw, "href", "brand.cta."), subject, "brand.cta.href"
            ),
        },
        "links": links,
    }

    # --- catalogue -------------------------------------------------------
    catalogue_raw = raw.get("catalogue") or {}
    if not isinstance(catalogue_raw, dict):
        raise ConfigError("catalogue", "must be an object")

    include = _string_list(catalogue_raw.get("include"), "catalogue.include")
    exclude = _string_list(catalogue_raw.get("exclude"), "catalogue.exclude")

    both = [name for name in include if name in exclude]
    if both:
        raise ConfigError(
            "catalogue.include", f"and catalogue.exclude both name {', '.join(both)}"
        )

    empty_raw = catalogue_raw.get("empty") or {}
    unnoticed_raw = catalogue_raw.get("unnoticed") or {}

    catalogue = {
        "include": include,
        "exclude": exclude,
        "includeForks": _boolean_or(catalogue_raw, "includeForks", "catalogue.", False),
        "includeArchived": _boolean_or(catalogue_raw, "includeArchived", "catalogue.", False),
        "empty": {
            "stubReadmeBytes": _number_or(
                empty_raw, "stubReadmeBytes", "catalogue.empty.", 120
            ),
            "discussionBytes": _number_or(
                empty_raw, "discussionBytes", "catalogue.empty.", 400
            ),
        },
        "unnoticed": {
            "maxStars": _number_or(unnoticed_raw, "maxStars", "catalogue.unnoticed.", 0),
            "maxViews": _number_or(unnoticed_raw, "maxViews", "catalogue.unnoticed.", 0),
            "maxFiles": _number_or(unnoticed_raw, "maxFiles", "catalogue.unnoticed.", 10),
        },
    }

    # --- taxonomy --------------------------------------------------------
    taxonomy_raw = raw.get("taxonomy")
    if not isinstance(taxonomy_raw, dict):
        raise ConfigError(
            "taxonomy", "must be an object with purpose, platform and language"
        )

    taxonomy = {}
    for axis in ("purpose", "platform", "language"):
        values = _string_list(taxonomy_raw.get(axis), f"taxonomy.{axis}")
        if not values:
            raise ConfigError(f"taxonomy.{axis}", "must list at least one value")
        for value in values:
            if not SLUG.match(value):
                raise ConfigError(
                    f"taxonomy.{axis}",
                    f'contains "{value}", which must be lowercase letters, digits and hyphens',
                )
        taxonomy[axis] = values

    # --- sort ------------------------------------------------------------
    sort_raw = raw.get("sort")
    if not isinstance(sort_raw, dict):
        raise ConfigError("sort", "must be an object with default and options")
    options = _string_list(sort_raw.get("options"), "sort.options")
    if not options:
        raise ConfigError("sort.options", "must list at least one mode")
    sort_default = _require_string(sort_raw, "default", "sort.")
    if sort_default not in options:
        raise ConfigError(
            "sort.default",
            f'is "{sort_default}", which is not in sort.options ({", ".join(options)})',
        )

    deploy_token_name = raw.get("deployTokenName")
    if not isinstance(deploy_token_name, str) or not deploy_token_name.strip():
        deploy_token_name = f"{project_name}-pages-deploy"

    return {
        "projectName": project_name,
        "productionBranch": production_branch,
        "buildOutputDir": build_output_dir,
        "githubOwner": github_owner,
        "customDomains": custom_domains,
        "deploy": deploy,
        "tokenExpiryDays": _number_or(raw, "tokenExpiryDays", "", 365),
        "deployTokenName": deploy_token_name,
        "brand": brand,
        "catalogue": catalogue,
        "taxonomy": taxonomy,
        "sort": {"default": sort_default, "options": options},
    }


if __name__ == "__main__":
    print(json.dumps(load_config(), indent=2))

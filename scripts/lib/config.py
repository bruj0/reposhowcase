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

    custom_domains = []
    for domain in _string_list(raw.get("customDomains"), "customDomains"):
        name = domain.strip().lower().rstrip(".")
        if not HOSTNAME.match(name):
            raise ConfigError("customDomains", f'contains "{domain}", which is not a hostname')
        custom_domains.append(name)
    if len(set(custom_domains)) != len(custom_domains):
        raise ConfigError("customDomains", "contains a duplicate hostname")

    # --- brand -----------------------------------------------------------
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
        "tokenExpiryDays": _number_or(raw, "tokenExpiryDays", "", 365),
        "deployTokenName": deploy_token_name,
        "brand": brand,
        "catalogue": catalogue,
        "taxonomy": taxonomy,
        "sort": {"default": sort_default, "options": options},
    }


if __name__ == "__main__":
    print(json.dumps(load_config(), indent=2))

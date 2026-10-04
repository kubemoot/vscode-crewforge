#!/usr/bin/env bash
# Prints CHANGELOG.md for the package being built. The GitHub Releases are its one
# source, so the Marketplace and Open VSX Changelog tab shows what they say.
#
# Usage: scripts/changelog.sh VERSION > CHANGELOG.md   (X.Y.Z, or X.Y.Z-rc.N for a candidate)
#
# Each final release (a vX.Y.Z tag, not a draft or pre-release) is one section, newest
# first, holding its release body without the body's own "## Changes since" heading and
# "All commits:" link. A VERSION with no final release yet (the version being promoted,
# or a candidate) gets a section on top: the release notes from the last final tag to
# HEAD, what its release body will hold.
#
# Needs GITHUB_REPOSITORY (owner/name; set in Actions), GH_TOKEN when the API needs a
# token, curl and jq, a checkout with every tag, and RELEASE_LIB naming
# kubemoot/release-actions' release-lib.sh. When GitHub cannot be read it fails with
# exit status 2 rather than print a partial changelog.
set -euo pipefail

tag_prefix=v

die() {
  echo "ERROR: $*" >&2
  exit 2
}

usage() {
  echo "usage: $0 VERSION (X.Y.Z or X.Y.Z-rc.N)" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
version="$1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || usage
if [ -z "${RELEASE_LIB:-}" ] || [ ! -r "$RELEASE_LIB" ]; then
  die "RELEASE_LIB must name kubemoot/release-actions' release-lib.sh"
fi
[ -n "${GITHUB_REPOSITORY:-}" ] || die "GITHUB_REPOSITORY must name the repository (owner/name)"
# shellcheck source=/dev/null
source "$RELEASE_LIB"

api="${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY}/releases"
releases_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/releases"

# Every release of the repository as one JSON array, read page by page.
all_releases() {
  local page=1 body all='[]' auth=()
  [ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GH_TOKEN}")
  while :; do
    body="$(curl -fsS --retry 3 -H 'Accept: application/vnd.github+json' "${auth[@]}" \
      "${api}?per_page=100&page=${page}")" || die "cannot read the releases at ${api}"
    jq -e 'type == "array"' <<<"$body" >/dev/null 2>&1 || die "the releases at ${api} are not a JSON list"
    [ "$(jq length <<<"$body")" -gt 0 ] || break
    all="$(jq -s 'add' <<<"${all}${body}")"
    page=$((page + 1))
  done
  printf '%s\n' "$all"
}

# The final releases: published, not pre-releases, tagged vX.Y.Z; newest first.
final_tags() {
  jq -r --arg re "^${tag_prefix}[0-9]+\\.[0-9]+\\.[0-9]+$" \
    '.[] | select((.draft | not) and (.prerelease | not) and (.tag_name | test($re))) | .tag_name' \
    <<<"$1" | sort -rV
}

# release_body JSON TAG: the release's body without its own heading and commits link.
release_body() {
  jq -r --arg tag "$2" '.[] | select(.tag_name == $tag) | .body // ""' <<<"$1" \
    | tr -d '\r' \
    | awk '
        NR == 1 && /^## Changes( since .*)?$/ { next }
        /^All commits: / { next }
        { lines[++n] = $0 }
        END {
          first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
          last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
          for (i = first; i <= last; i++) print lines[i]
        }'
}

# section TITLE TEXT: one release's heading and its notes.
section() {
  printf '\n## %s\n\n%s\n' "$1" "${2:-Maintenance only.}"
}

releases="$(all_releases)"
finals="$(final_tags "$releases")"

printf '# Changelog\n\n'
printf 'Generated from the release notes on [GitHub Releases](%s) when the extension is packaged.\n' "$releases_url"

if ! grep -qxF -- "${tag_prefix}${version}" <<<"$finals"; then
  last_final="$(rl_latest_final "$tag_prefix" HEAD)"
  notes="$(rl_release_notes "$last_final" HEAD)"
  section "$version" "$notes"
fi

while read -r tag; do
  [ -n "$tag" ] || continue
  body="$(release_body "$releases" "$tag")"
  section "${tag#"$tag_prefix"}" "$body"
done <<<"$finals"

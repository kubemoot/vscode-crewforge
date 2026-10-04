#!/usr/bin/env bash
# A stand-in for kubemoot/release-actions' release-lib.sh with the two functions
# scripts/changelog.sh calls, so its tests need no clone of that repository. Notes list
# unscoped feat and fix commits only, capitalized as the real filter writes them (which
# also reads scopes and breaking marks); everything else is maintenance.
# test/changelog.test.ts runs the same tests against the real library when RELEASE_LIB
# is set, so the two cannot drift unnoticed.

# Declares the same locals as the real functions, so a caller's readonly global of the
# same name fails here too.
rl_latest_final() {
  local prefix="$1" commit="$2"
  git tag --merged "$commit" --list "${prefix}[0-9]*" | grep -E "^${prefix}[0-9]+\.[0-9]+\.[0-9]+$" | sort -V | tail -n 1 || true
}

rl_release_notes() {
  local from="$1" to="$2" range
  range="$to"
  [ -n "$from" ] && range="${from}..${to}"
  git log --format='%h%x09%s' "$range" | awk -F '\t' '
    function entry(desc) { return "- " toupper(substr(desc, 1, 1)) substr(desc, 2) " (" $1 ")\n" }
    /\tfeat: / { feat = feat entry(substr($2, 7)) }
    /\tfix: / { fix = fix entry(substr($2, 6)) }
    END {
      if (feat != "") printf "### New\n\n%s\n", feat
      if (fix != "") printf "### Fixed\n\n%s\n", fix
    }'
}

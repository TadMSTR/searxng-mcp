#!/usr/bin/env bash
# Prove the secret scanner, and THIS REPO'S OWN RULES, can actually fail.
#
# WHY THIS EXISTS.
#
# If --config cannot be read, gitleaks does not error — it falls back to its
# bundled ruleset and carries on. Every rule in .gitleaks.toml (internal domains,
# the 10.10.1.x range, the real ntfy channels) then silently stops running, while
# the scan still passes green on a repo that holds no generic secrets. That is the
# precise shape of a gate that cannot fail, and nothing in the output says so.
#
# So the config being LOADED is asserted on every run, not assumed.
#
# WHAT THIS CHECKS, AND HOW — three things, each learned the hard way.
#
# 1. THE BINARY EXISTS. Checked explicitly, because the obvious formulation
#    `if gitleaks …; then` treats exit 127 "command not found" as a successful
#    detection: with no gitleaks on PATH at all, an earlier version of this script
#    reported both probes passing and exited 0.
#
# 2. THE EXIT CODE IS NOT ENOUGH. gitleaks exits 1 both for "leaks found" and for
#    "could not read the config" (measured, v8.30.1). A non-zero exit therefore
#    cannot distinguish the thing being tested from the failure it is testing for.
#    So the probes read the JSON report and assert the EXACT RuleID that should
#    have matched.
#
# 3. THE PROBES MUST BE DETERMINISTIC. gitleaks scores entropy on its
#    high-cardinality rules, so a generated token is not a reliable trigger: a
#    random `ghp_` + 36 chars fired on 13 of 40 trials (measured, v8.30.1). A
#    probe like that turns a merge gate into a coin flip. A memorable placeholder
#    is no better — low entropy never fires — and AWS's documented
#    AKIAIOSFODNN7EXAMPLE key is allowlisted upstream, so it is a guaranteed
#    false green. Both probes below are regex rules with no entropy term, which is
#    why they fire every time.
#
# WHAT THIS DELIBERATELY DOES NOT CHECK.
#
# gitleaks' own bundled ruleset. There is no cheap deterministic trigger for it —
# the entropy-scored rules are the flaky ones above, and the private-key rules did
# not fire on a truncated fake key. That is upstream's test suite's job. What
# matters here is the layer this repo adds, and if gitleaks were broken outright
# the custom probes below would not fire either.
#
# THE PROBE STRINGS ARE ASSEMBLED AT RUNTIME, NEVER WRITTEN AS LITERALS. This file
# lives inside the tree the real scan reads, so a literal 10.10.1.x here would be
# found by the very rule it tests — the gate would flag its own test data and go
# red for the wrong reason. A gitleaks allowlist entry for this path would be
# worse: an allowlist path excuses the WHOLE file, so a real secret pasted here
# later would be excused too.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "::error::gitleaks is not on PATH — nothing was scanned" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is not on PATH — cannot read the gitleaks report" >&2
  exit 1
fi

probe_root="${RUNNER_TEMP:-/tmp}/gitleaks-selftest.$$"
trap 'rm -rf "$probe_root"' EXIT
mkdir -p "$probe_root"

fail=0

# Runs gitleaks over a one-file directory and asserts which rules matched.
#   $1 label   $2 expected RuleID, or "" to expect no findings at all
#   $3 body    file content to scan
check() {
  # Declared separately: bash expands every word of a `local` command before
  # assigning any of them, so `dir="$probe_root/$label"` on one line would read an
  # unset $label and trip `set -u`.
  local label="$1"
  local want="$2"
  local body="$3"
  local dir="$probe_root/$label"
  local report="$probe_root/$label.json"

  mkdir -p "$dir"
  cp .gitleaks.toml "$dir/"
  printf '%s\n' "$body" > "$dir/probe.txt"

  # `|| true` because a detection exits 1 and `set -e` would abort here. The
  # verdict comes from the report, not the exit code — see note 2 above.
  gitleaks dir "$dir" --config "$dir/.gitleaks.toml" --no-banner --redact \
    --report-format json --report-path "$report" >/dev/null 2>&1 || true

  if [ ! -f "$report" ]; then
    echo "::error::probe '$label': gitleaks wrote no report — it did not run as expected"
    fail=1
    return
  fi

  local got
  got="$(jq -r '[.[].RuleID] | unique | join(",")' "$report")"

  if [ -z "$want" ]; then
    if [ -n "$got" ]; then
      echo "::error::probe '$label': expected no findings, got [$got] — the rules match too much"
      fail=1
    else
      echo "ok: probe '$label' found nothing, as it must"
    fi
    return
  fi

  case ",$got," in
    *",$want,"*) echo "ok: probe '$label' matched rule '$want', as it must" ;;
    *) echo "::error::probe '$label': expected rule '$want', got [${got:-none}] — .gitleaks.toml is not being applied"
       fail=1 ;;
  esac
}

# Both custom rules, so one rule being deleted or broken cannot hide behind the
# other. Assembled, not literal.
check internal-ip     real-internal-ip "$(printf 'SEARXNG_URL=http://10.10.%d.%d:8080' 1 42)"
check internal-domain internal-domain  "$(printf 'u = https://searxng.%s.me/x' tadmstr)"

# The control. Without it, a config that matched everything would look identical
# to one that works.
check clean "" "SEARXNG_URL=http://searxng:8080"

if [ "$fail" != 0 ]; then
  echo "self-test failed: the scanner is not enforcing what this repo thinks it enforces" >&2
  exit 1
fi
echo "self-test: 2 rules fired, control clean — gitleaks and .gitleaks.toml are live"

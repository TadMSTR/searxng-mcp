#!/usr/bin/env bash
# Acceptance test for docker/playwright-adblock.
#
# THE ASSERTION THAT MATTERS IS NOT "ARE ADS BLOCKED".
#
# init-adblock.js registers a context route in front of Firecrawl's in-browser
# SSRF guard. Playwright runs handlers in reverse registration order, and
# route.continue() dispatches without invoking the remaining handlers — so an
# adblock handler that calls continue() silently deletes assertSafeTargetUrl.
# Ads still get blocked. Pages still render. /scrape still returns 200.
#
# This script therefore asserts that UPSTREAM's handler still executes, by
# looking for the bare hostname it logs when its AD_SERVING_DOMAINS check
# fires. That check sits after assertSafeTargetUrl in the same handler, so
# observing it proves the guard ran.
#
# It also builds a deliberately broken variant and asserts the signal
# DISAPPEARS — without that control, a test that always passes looks identical
# to a test that works.
#
# Two modes:
#
#   ./verify-ssrf-guard.sh [local-tag]
#       Build mode (default tag playwright-adblock:verify). Builds the image
#       from this checkout under <local-tag> and tests that. Used by CI and
#       before publishing. <local-tag> must be a plain local name: a
#       registry-qualified name (ghcr.io/..., anything whose first path
#       component has a "." or ":", or localhost/...) or one containing "@" is
#       refused, so a source build can never overwrite a tag that compose
#       would resolve to the published image.
#
#   ./verify-ssrf-guard.sh --image <ref>
#       Published-image mode. `docker pull`s <ref> (repo:tag@sha256:... is the
#       form to use) and tests exactly those bytes. Nothing is ever tagged onto
#       <ref>. The image's resolved digest is printed so a report can record
#       what was tested.
#
# In both modes the broken control is built from this checkout (so run it from
# the matching release tag), under a scratch tag: <local-tag>-REGRESSION in
# build mode, playwright-adblock:verify-control in --image mode.
#
# Exit codes: 0 PASS, 1 FAIL, 2 usage error or refused argument. Any other
# non-zero status is an unexpected error from a command the script ran (set -e):
# treat it as "not verified", never as a pass.
#
# -e is on, so the two `grep -c` calls below are explicitly guarded: grep exits
# 1 when it matches nothing, and "matches nothing" is the EXPECTED result for
# the regression build. Without the guard, -e would abort the script at exactly
# the moment the control succeeds.
set -euo pipefail

usage() {
  sed -n '/^# Two modes:/,/^# Exit codes:/p' "$0" | sed 's/^# \{0,1\}//' >&2
}

MODE=build
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --image)
    if [ $# -ne 2 ] || [ -z "$2" ]; then
      echo "usage: $0 --image <repo:tag@sha256:...>" >&2
      exit 2
    fi
    MODE=image
    IMAGE="$2"
    CONTROL=playwright-adblock:verify-control
    ;;
  -*)
    echo "unknown option: $1" >&2
    usage
    exit 2
    ;;
  *)
    [ $# -le 1 ] || { echo "usage: $0 [local-tag] | --image <ref>" >&2; exit 2; }
    IMAGE="${1:-playwright-adblock:verify}"
    first="${IMAGE%%/*}"
    if [[ "$IMAGE" == *@* ]] ||
       { [[ "$IMAGE" == */* ]] && { [[ "$first" == *.* ]] || [[ "$first" == *:* ]] || [ "$first" = localhost ]; }; }; then
      echo "REFUSED: build mode writes a local tag, and '$IMAGE' is a registry or digest reference." >&2
      echo "A source build under that name could be picked up by compose in place of the published image." >&2
      echo "Use a plain local tag (e.g. playwright-adblock:verify), or test the published image with --image '$IMAGE'." >&2
      exit 2
    fi
    CONTROL="${IMAGE}-REGRESSION"
    ;;
esac

NET=pwverify-net
SITE=pwverify-site
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'docker rm -f "$SITE" pwverify-fixed pwverify-regress >/dev/null 2>&1;
      docker network rm "$NET" >/dev/null 2>&1;
      docker rmi -f "$CONTROL" >/dev/null 2>&1;
      rm -rf "$WORK"' EXIT

if [ "$MODE" = image ]; then
  echo "==> pulling $IMAGE"
  docker pull -q "$IMAGE" >/dev/null || { echo "FAIL: pull $IMAGE"; exit 1; }
  echo "    testing $(docker image inspect --format '{{join .RepoDigests " "}}' "$IMAGE")"
else
  echo "==> building $IMAGE"
  docker build -q -t "$IMAGE" "$HERE" >/dev/null || { echo "FAIL: build"; exit 1; }
fi

echo "==> building the regression variant (fallback -> continue)"
cp -r "$HERE" "$WORK/regress"
sed -i 's/return route\.fallback();/return route.continue();/g' "$WORK/regress/init-adblock.js"
grep -q 'return route.continue();' "$WORK/regress/init-adblock.js" \
  || { echo "FAIL: regression variant did not apply — the control is not testing anything"; exit 1; }
docker build -q -t "$CONTROL" "$WORK/regress" >/dev/null || { echo "FAIL: regression build"; exit 1; }

docker network create "$NET" >/dev/null 2>&1
mkdir -p "$WORK/site"
cat > "$WORK/site/index.html" <<'HTML'
<!doctype html><html><head><title>adblock probe</title></head><body>
<script src="https://doubleclick.net/marker.js"></script>
<script src="https://googletagservices.com/marker.js"></script>
<script src="https://adnxs.com/marker.js"></script>
</body></html>
HTML
docker run -d --name "$SITE" --network "$NET" -v "$WORK/site:/usr/share/nginx/html:ro" nginx:alpine >/dev/null
sleep 3

# ALLOW_LOCAL_WEBHOOKS=true so the locally served probe page passes the
# top-level URL check at api.ts:400. That check is separate from the route
# handler under test; without this the page could not be served at all, since
# any host reachable from here resolves to a private address.
probe() {
  local image="$1" name="$2"
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" --network "$NET" -e ALLOW_LOCAL_WEBHOOKS=true "$image" >/dev/null
  sleep 25
  docker run --rm --network "$NET" curlimages/curl:latest -s -m 90 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"http://$SITE/\",\"wait_after_load\":4000}" \
    "http://$name:3003/scrape" -o /dev/null -w '%{http_code}' > "$WORK/$name.http"
  sleep 3
  docker logs "$name" 2>&1 | grep -cE '^(doubleclick\.net|googletagservices\.com|adnxs\.com)$' \
    > "$WORK/$name.markers" || true
  [ -s "$WORK/$name.markers" ] || echo 0 > "$WORK/$name.markers"
  docker rm -f "$name" >/dev/null 2>&1
}

probe "$IMAGE" pwverify-fixed
probe "$CONTROL" pwverify-regress

fixed_http=$(cat "$WORK/pwverify-fixed.http")
fixed_markers=$(cat "$WORK/pwverify-fixed.markers")
regress_http=$(cat "$WORK/pwverify-regress.http")
regress_markers=$(cat "$WORK/pwverify-regress.markers")

echo
printf 'image under test  : HTTP %s, upstream-handler markers = %s\n' "$fixed_http" "$fixed_markers"
printf 'regression build  : HTTP %s, upstream-handler markers = %s\n' "$regress_http" "$regress_markers"
echo

rc=0
[ "$fixed_http" = "200" ] || { echo "FAIL: image under test did not scrape successfully"; rc=1; }
[ "$fixed_markers" -ge 1 ] || { echo "FAIL: upstream handler did NOT run — the SSRF guard is bypassed"; rc=1; }
[ "$regress_markers" -eq 0 ] || { echo "FAIL: control did not reproduce the bypass — this test cannot detect the regression"; rc=1; }

# Both builds returning 200 is the point, not an accident: it is why a
# functional test cannot substitute for this one.
[ "$regress_http" = "200" ] || echo "NOTE: regression build returned $regress_http, not 200"

[ $rc -eq 0 ] && echo "PASS: SSRF guard still executes with the adblocker loaded, and the control proves this test can fail."
exit $rc

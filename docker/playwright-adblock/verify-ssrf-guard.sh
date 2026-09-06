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
# Usage:  ./verify-ssrf-guard.sh [image-tag]
set -uo pipefail

IMAGE="${1:-playwright-adblock:verify}"
NET=pwverify-net
SITE=pwverify-site
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'docker rm -f "$SITE" pwverify-fixed pwverify-regress >/dev/null 2>&1;
      docker network rm "$NET" >/dev/null 2>&1;
      docker rmi -f "${IMAGE}-REGRESSION" >/dev/null 2>&1;
      rm -rf "$WORK"' EXIT

echo "==> building $IMAGE"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || { echo "FAIL: build"; exit 1; }

echo "==> building the regression variant (fallback -> continue)"
cp -r "$HERE" "$WORK/regress"
sed -i 's/return route\.fallback();/return route.continue();/g' "$WORK/regress/init-adblock.js"
grep -q 'return route.continue();' "$WORK/regress/init-adblock.js" \
  || { echo "FAIL: regression variant did not apply — the control is not testing anything"; exit 1; }
docker build -q -t "${IMAGE}-REGRESSION" "$WORK/regress" >/dev/null || { echo "FAIL: regression build"; exit 1; }

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
    > "$WORK/$name.markers"
  docker rm -f "$name" >/dev/null 2>&1
}

probe "$IMAGE" pwverify-fixed
probe "${IMAGE}-REGRESSION" pwverify-regress

fixed_http=$(cat "$WORK/pwverify-fixed.http")
fixed_markers=$(cat "$WORK/pwverify-fixed.markers")
regress_http=$(cat "$WORK/pwverify-regress.http")
regress_markers=$(cat "$WORK/pwverify-regress.markers")

echo
printf 'shipped build     : HTTP %s, upstream-handler markers = %s\n' "$fixed_http" "$fixed_markers"
printf 'regression build  : HTTP %s, upstream-handler markers = %s\n' "$regress_http" "$regress_markers"
echo

rc=0
[ "$fixed_http" = "200" ] || { echo "FAIL: shipped build did not scrape successfully"; rc=1; }
[ "$fixed_markers" -ge 1 ] || { echo "FAIL: upstream handler did NOT run — the SSRF guard is bypassed"; rc=1; }
[ "$regress_markers" -eq 0 ] || { echo "FAIL: control did not reproduce the bypass — this test cannot detect the regression"; rc=1; }

# Both builds returning 200 is the point, not an accident: it is why a
# functional test cannot substitute for this one.
[ "$regress_http" = "200" ] || echo "NOTE: regression build returned $regress_http, not 200"

[ $rc -eq 0 ] && echo "PASS: SSRF guard still executes with the adblocker loaded, and the control proves this test can fail."
exit $rc

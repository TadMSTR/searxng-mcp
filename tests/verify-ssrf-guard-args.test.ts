// Argument handling of docker/playwright-adblock/verify-ssrf-guard.sh, with a
// stub `docker` (and `sleep`) on PATH that records every call. No real docker.
//
// What this pins:
// - `--image <ref>` pulls the reference and runs exactly that image, never
//   `docker tag` and never `build -t <ref>`; the control is built under the
//   scratch tag playwright-adblock:verify-control;
// - build mode refuses a registry-qualified or digest reference before any
//   docker call, so a source build can't overwrite a tag compose resolves;
// - the stubbed run can FAIL (a missing upstream-handler marker exits 1), so a
//   passing run here is not a test that cannot fail.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(
  import.meta.dirname,
  "../docker/playwright-adblock/verify-ssrf-guard.sh",
);

let dir: string;
let log: string;

// STUB_MARKERS=0 makes the image under test print no marker, i.e. the guard
// "did not run", which the script must report as a failure.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  run)
    for a in "$@"; do
      case "$a" in curlimages/curl*) printf 200; exit 0 ;; esac
    done
    ;;
  logs)
    if [ "$2" = pwverify-fixed ] && [ "\${STUB_MARKERS:-1}" = 1 ]; then
      echo doubleclick.net
    fi
    ;;
  image)
    echo "\${@: -1}@sha256:stubdigest"
    ;;
esac
exit 0
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-ssrf-args-"));
  log = join(dir, "docker.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "docker"), DOCKER_STUB);
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_LOG: log,
      ...env,
    },
    encoding: "utf-8",
    timeout: 20_000,
  });
  const calls = readFileSync(log, "utf-8").split("\n").filter(Boolean);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const REF =
  "ghcr.io/tadmstr/searxng-mcp-playwright-adblock:v4.0.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("verify-ssrf-guard.sh --image", () => {
  it("pulls the reference, runs it, and never tags or builds onto it", () => {
    const { status, out, calls } = run(["--image", REF]);
    expect(out).toContain("PASS");
    expect(status).toBe(0);

    expect(calls).toContain(`pull -q ${REF}`);
    expect(
      calls.some((c) => c.startsWith("run -d ") && c.endsWith(` ${REF}`)),
    ).toBe(true);
    expect(calls.filter((c) => c.startsWith("tag "))).toEqual([]);
    expect(
      calls.filter((c) => c.startsWith("build ") && c.includes(REF)),
    ).toEqual([]);
    // The control comes from the checkout, under the scratch tag only.
    const builds = calls.filter((c) => c.startsWith("build "));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("-t playwright-adblock:verify-control ");
    // Cleanup removes the control, never the image under test.
    expect(
      calls.filter((c) => c.startsWith("rmi ") && c.includes(REF)),
    ).toEqual([]);
    expect(out).toContain(`${REF}@sha256:stubdigest`);
  });

  it("fails when the image under test shows no upstream-handler marker", () => {
    const { status, out } = run(["--image", REF], { STUB_MARKERS: "0" });
    expect(status).toBe(1);
    expect(out).toContain("SSRF guard is bypassed");
  });

  it.each([[["--image"]], [["--image", ""]], [["--image", REF, "extra"]]])(
    "rejects %j as a usage error without calling docker",
    (args) => {
      const { status, calls } = run(args);
      expect(status).toBe(2);
      expect(calls).toEqual([]);
    },
  );
});

describe("verify-ssrf-guard.sh build mode", () => {
  it("builds the default local tag from the checkout", () => {
    const { status, calls } = run([]);
    expect(status).toBe(0);
    expect(
      calls.some((c) => c.startsWith("build -q -t playwright-adblock:verify ")),
    ).toBe(true);
    expect(calls.filter((c) => c.startsWith("pull "))).toEqual([]);
  });

  it("accepts a plain local tag, as the publish workflow passes", () => {
    const { status, calls } = run(["playwright-adblock:candidate"]);
    expect(status).toBe(0);
    expect(
      calls.some((c) =>
        c.startsWith("build -q -t playwright-adblock:candidate "),
      ),
    ).toBe(true);
    expect(
      calls.some((c) =>
        c.startsWith("build -q -t playwright-adblock:candidate-REGRESSION "),
      ),
    ).toBe(true);
  });

  it.each([
    "ghcr.io/tadmstr/searxng-mcp-playwright-adblock:v4.0.0",
    "ghcr.io/tadmstr/searxng-mcp-playwright-adblock:candidate",
    "playwright-adblock@sha256:0123",
    REF,
    "localhost:5000/playwright-adblock:x",
    "localhost/playwright-adblock:x",
    "docker.io/library/playwright-adblock:x",
  ])("refuses %s before any docker call", (tag) => {
    const { status, out, calls } = run([tag]);
    expect(status).toBe(2);
    expect(out).toContain("REFUSED");
    expect(calls).toEqual([]);
  });

  it("rejects an unknown option", () => {
    const { status, calls } = run(["--pull"]);
    expect(status).toBe(2);
    expect(calls).toEqual([]);
  });
});

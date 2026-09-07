// MAINTENANCE SCRIPT — refresh the vendored filter lists. Not run by the build.
//
// It used to be a `RUN node /tmp/fetch-lists.mjs` step in the Dockerfile, which
// meant every image build reached out to easylist.to. That made the image
// non-reproducible and put a third party's uptime on the release path: the
// v3.28.0 release failed on exactly this step and needed a re-run (vikunja#716).
//
// The lists now live in ./lists/ under version control, and the Dockerfile
// asserts ./lists/SHA256SUMS instead of downloading anything. This script is how
// those files get updated — deliberately, by a human or by
// .github/workflows/adblock-lists-refresh.yml, with the change reviewable as a
// diff. For an image whose entire job is filtering, "which rules are in here"
// belongs in git.
//
// Run from anywhere:  node docker/playwright-adblock/fetch-lists.mjs
//
// It still fails loudly rather than writing a bad list. A too-small file is
// treated as a failure because a CDN error page is a 200 with a body, and
// parsing one yields an engine with no rules — an adblocker reporting success
// while doing nothing, which is the defect class this whole line of work is
// about. MIN_BYTES is a plausibility floor, not a size expectation: the real
// lists are ~1.5-2 MB, and the build-time integrity assertion is now the
// checksum, which is strictly stronger. Do not tune this up to hug the current
// sizes — that would fail the day upstream legitimately shrinks a list.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "lists");
const SUMS = join(OUT, "SHA256SUMS");
const MIN_BYTES = 100_000;
const URLS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The `<hash>  <name>` lines only, so a comment change is not a content change. */
function hashLines(text) {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .join("\n");
}

await mkdir(OUT, { recursive: true });

const entries = [];
for (const url of URLS) {
  const name = url.split("/").pop();
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAIL ${url} -> HTTP ${res.status}`);
    process.exit(1);
  }
  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < MIN_BYTES) {
    console.error(`FAIL ${url} -> only ${bytes} bytes, refusing to vendor it`);
    process.exit(1);
  }
  const dest = join(OUT, name);
  await writeFile(dest, text, "utf8");
  // Hash what is ON DISK, not the string we meant to write. SHA256SUMS is the
  // build's integrity assertion, so it has to attest to the bytes the Dockerfile
  // will actually COPY — a short write here would otherwise be recorded as the
  // checksum of the intended content. (The build would still fail closed on the
  // mismatch, which is the right direction, but it would fail describing the
  // wrong thing.)
  const written = await readFile(dest, "utf8");
  entries.push({ name, bytes: Buffer.byteLength(written, "utf8"), hash: sha256(written) });
  console.log(`fetched ${name}: ${bytes} bytes, ${sha256(written)}`);
}

const body = entries.map((e) => `${e.hash}  ${e.name}`).join("\n");
const previous = await readFile(SUMS, "utf8").catch(() => "");

// Rewrite SHA256SUMS only when a hash actually moved. Stamping today's date on
// every run would make the "content last changed" line a lie about the lists and
// would open a no-op PR from the scheduled workflow every single week.
if (hashLines(previous) === body) {
  console.log("lists unchanged — SHA256SUMS left as-is");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
await writeFile(
  SUMS,
  [
    "# Checksums for the vendored filter lists, asserted at image build time by",
    "# ../Dockerfile. Regenerate with `node docker/playwright-adblock/fetch-lists.mjs`.",
    "#",
    "# Sources:",
    ...URLS.map((u) => `#   ${u.split("/").pop().padEnd(16)} ${u}`),
    "#",
    `# Content last changed: ${today}`,
    body,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`SHA256SUMS updated (${today})`);

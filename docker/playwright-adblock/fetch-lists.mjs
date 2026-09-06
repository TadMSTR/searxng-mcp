// Build-time only: download the filter lists baked into the image.
//
// Fails the BUILD on any problem rather than producing an image whose
// adblocker silently blocks nothing. A too-small file is treated as a failure
// because a CDN error page is a 200 with a body, and parsing one yields an
// engine with no rules — an adblocker reporting success while doing nothing,
// which is the defect class this whole release is about.
import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const OUT = "/usr/src/app/adblock/lists";
const MIN_BYTES = 100_000;
const URLS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
];

await mkdir(OUT, { recursive: true });
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
    console.error(`FAIL ${url} -> only ${bytes} bytes, refusing to bake it`);
    process.exit(1);
  }
  await writeFile(join(OUT, name), text, "utf8");
  console.log(`baked ${name}: ${bytes} bytes`);
}
const n = (await Promise.all(URLS.map((u) => stat(join(OUT, u.split("/").pop()))))).length;
console.log(`baked ${n} filter list(s) into ${OUT}`);

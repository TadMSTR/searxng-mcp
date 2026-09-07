import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Docker compose project names and container names are GLOBAL to the host.
 *
 * Compose derives the project name from the compose file's directory basename
 * unless a top-level `name:` overrides it. `docker/reranker/` and the
 * conventional deployment directory are both called `reranker`, so before
 * v3.25.1 a `docker compose down` run from a clone of this repo matched the
 * *deployment's* containers by project label and removed them — silently. That
 * is how a production reranker was removed for ~4.5h on 2026-09-06
 * (vikunja#694).
 *
 * Measured, not reasoned: with the v3.25.0 file in a directory named
 * `reranker`, `docker compose down --dry-run` reported `Container reranker
 * Stopping / Stopped / Removing / Removed` against the live container. With a
 * pinned `name:`, from the same directory, it matched nothing.
 *
 * These assertions are the guard against either half being helpfully restored.
 * They are static because the live behaviour cannot be exercised in CI — the
 * behavioural proof is recorded in the CHANGELOG and in this comment, and the
 * invariant they encode is what produced it.
 */

function composeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist")
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) composeFiles(full, found);
    // Both naming conventions. `docker-compose.yml` is the legacy name; the
    // Compose Specification's is a bare `compose.yml`, and examples/ uses that
    // form. Matching only the legacy pattern is how a guard ends up scanning a
    // shrinking set while new files land outside it entirely — which is exactly
    // what happened when the compose ladder was added in examples/.
    else if (/^(docker-)?compose.*\.ya?ml$/.test(entry)) found.push(full);
  }
  return found;
}

const root = join(__dirname, "..");
const files = composeFiles(root);

describe("compose files cannot collide with another stack on the host", () => {
  it("finds every compose file in the repo", () => {
    // A guard that silently scans nothing is worse than no guard. If this
    // number changes, the new file needs the two assertions below applied to
    // it deliberately — update the count in the same commit.
    //
    // 3 -> 4 in v3.26.0: docker/adblock-proxy/docker-compose.yml was added for
    // standalone use. It went red here first, which is the guard working.
    //
    // 4 -> 6 with the compose ladder (vikunja#710): docker-compose.example.yml
    // and docker-compose.full.yml were retired (-2) and examples/ gained four
    // rungs (+4). This went red at 2, not 6 — the retirement was visible to the
    // matcher and the four new files were not, because they use the Compose
    // Specification's `compose.*.yml` name and the pattern above only accepted
    // the legacy `docker-compose*` form. Bumping the count alone would have
    // left every new file unguarded while the suite went green, which is the
    // failure this assertion exists to prevent. The pattern was widened
    // instead.
    expect(files.length).toBe(6);
  });

  it.each(
    files.map((f) => [f.slice(root.length + 1), f]),
  )("%s pins a top-level project name", (_rel, file) => {
    const doc = parse(readFileSync(file, "utf8")) as { name?: unknown };
    expect(typeof doc.name).toBe("string");
    expect((doc.name as string).trim()).not.toBe("");
  });

  it.each(
    files.map((f) => [f.slice(root.length + 1), f]),
  )("%s sets no container_name on any service", (_rel, file) => {
    const doc = parse(readFileSync(file, "utf8")) as {
      services?: Record<string, Record<string, unknown>>;
    };
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      expect(
        svc?.container_name,
        `service "${name}" sets container_name — it is global to the host`,
      ).toBeUndefined();
    }
  });

  it("the standalone reranker's project name is not the bare directory name", () => {
    // The specific collision that caused the outage. `reranker` is what the
    // directory basename would have produced and what the deployment uses.
    const file = files.find((f) =>
      f.endsWith("docker/reranker/docker-compose.yml"),
    );
    if (!file) throw new Error("docker/reranker/docker-compose.yml not found");
    const doc = parse(readFileSync(file, "utf8")) as { name?: string };
    expect(doc.name).not.toBe("reranker");
    expect(doc.name).toBe("searxng-mcp-reranker");
  });
});

// An instrument name that observability.ts never creates must not compile.
//
// Until 4.1.0 the instrument maps were `Record<string, …>`, so
// `incCounter("crawl")` and `recordHistogram("tool.crawl_site")` type-checked
// against instruments nobody created and exported nothing. The names are now a
// closed union. This compiles a small virtual file against the real
// src/observability.ts with the project's own compiler options, because
// `vitest --typecheck` only checks *.test-d.ts files and a type-level
// assertion in this file would never be evaluated.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const virtualPath = `${root}tests/__virtual_instrument_names__.ts`;

function diagnosticsFor(body: string): string[] {
  const configPath = `${root}tsconfig.json`;
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (!config) throw new Error("tsconfig.json did not parse");
  const options = { ...config.options, noEmit: true, composite: false };
  const source = `import { incCounter, recordHistogram } from "../src/observability.js";\n${body}\n`;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name === virtualPath
      ? ts.createSourceFile(name, source, lang)
      : getSourceFile(name, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtualPath || fileExists(name);
  const program = ts.createProgram([virtualPath], options, host);
  const file = program.getSourceFile(virtualPath);
  return ts
    .getPreEmitDiagnostics(program, file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("instrument names are a closed set", () => {
  it("every created name compiles (the control)", () => {
    expect(
      diagnosticsFor(
        [
          `incCounter("search"); incCounter("fetch"); incCounter("cache");`,
          `incCounter("errors"); incCounter("crawl"); incCounter("degrade");`,
          `recordHistogram("search", 1); recordHistogram("fetch", 1);`,
          `recordHistogram("crawl", 1); recordHistogram("rerank_top_score", 0.5);`,
        ].join("\n"),
      ),
    ).toEqual([]);
  }, 30_000);

  it("an uncreated histogram name is a compile error", () => {
    const diags = diagnosticsFor(`recordHistogram("tool.crawl_site", 1);`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('"tool.crawl_site"');
  }, 30_000);

  it("an uncreated counter name is a compile error", () => {
    const diags = diagnosticsFor(`incCounter("no_such_counter");`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('"no_such_counter"');
  }, 30_000);
});

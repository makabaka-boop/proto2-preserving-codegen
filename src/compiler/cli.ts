import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { parseProto, CompileError } from "./parser.js";
import { generate } from "./generator.js";

export { parseProto, CompileError } from "./parser.js";
export { generate } from "./generator.js";

export interface CompileFromFileOptions {
  outFile: string;
  /** Runtime import specifier in the generated module. */
  runtimeImport?: string;
}

/**
 * Compile a .proto file to a TypeScript codec module on disk.
 * Returns the generated source.
 */
export function compileProtoFile(protoPath: string, opts: CompileFromFileOptions): string {
  const source = readFileSync(protoPath, "utf8");
  const ir = parseProto(source, basename(protoPath));
  const code = generate(ir, {
    runtimeImport: opts.runtimeImport ?? "./runtime.js",
    sourceName: basename(protoPath),
  });
  mkdirSync(dirname(resolve(opts.outFile)), { recursive: true });
  writeFileSync(opts.outFile, code, "utf8");
  return code;
}

function usage(): never {
  process.stderr.write(
    "usage: proto2ts <file.proto> --out <file.ts> [--runtime <import-specifier>]\n",
  );
  process.exit(2);
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  let input: string | undefined;
  let out: string | undefined;
  let runtime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      out = args[++i];
    } else if (a === "--runtime") {
      runtime = args[++i];
    } else if (a === "--help" || a === "-h") {
      usage();
    } else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag: ${a}\n`);
      usage();
    } else {
      if (input) usage();
      input = a;
    }
  }
  if (!input || !out) usage();
  try {
    compileProtoFile(input, { outFile: out, runtimeImport: runtime });
    process.stdout.write(`generated ${out}\n`);
  } catch (e) {
    if (e instanceof CompileError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

main(process.argv);

/** Tiny sequential test runner to avoid node:test watcher/hang issues under tsx. */
import assert from "node:assert/strict";

const suites: Array<{ name: string; tests: Array<[string, () => void | Promise<void>]> }> = [];
let current: { name: string; tests: Array<[string, () => void | Promise<void>]> } | null = null;

export function describe(name: string, fn: () => void): void {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function test(name: string, fn: () => void | Promise<void>): void {
  if (!current) throw new Error("test() outside describe");
  current.tests.push([name, fn]);
}

export { assert };

export async function run(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  for (const s of suites) {
    for (const [name, fn] of s.tests) {
      const label = `${s.name} > ${name}`;
      try {
        await fn();
        pass++;
        console.log(`ok - ${label}`);
      } catch (e) {
        fail++;
        failures.push(label);
        console.log(`FAIL - ${label}`);
        console.log((e as Error).stack ?? String(e));
      }
    }
  }
  console.log(`\n# ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:\n" + failures.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

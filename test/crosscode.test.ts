import { test, describe, assert } from "./harness.js";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Cross, Inner } from "./gen/cross.js";

const require = createRequire(import.meta.url);
/** Path to the protoc npm package's wrapper script (test tooling only). */
const PROTOC = join(require.resolve("protoc/package.json"), "..", "protoc.cjs");

const PROTO_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

function runProtoc(args: string[], stdin?: Uint8Array): { stdout: Buffer; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [PROTOC, ...args], { input: stdin });
  if (r.error) throw r.error;
  return {
    stdout: r.stdout as Buffer,
    stderr: r.stderr.toString(),
    status: r.status ?? -1,
  };
}

/** Encode text-format Cross via protoc. */
function protocEncode(text: string): Uint8Array {
  const r = runProtoc([`--proto_path=${PROTO_DIR}`, "--encode=Cross", "cross.proto"], Buffer.from(text));
  assert.equal(r.status, 0, `protoc --encode failed: ${r.stderr}`);
  return new Uint8Array(r.stdout);
}

/** Decode binary Cross to text-format via protoc. */
function protocDecode(bin: Uint8Array): string {
  const r = runProtoc([`--proto_path=${PROTO_DIR}`, "--decode=Cross", "cross.proto"], Buffer.from(bin));
  assert.equal(r.status, 0, `protoc --decode failed: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** Decode raw (no schema) — used to inspect unknown-field retention. */
function protocDecodeRaw(bin: Uint8Array): string {
  const r = runProtoc(["--decode_raw"], Buffer.from(bin));
  assert.equal(r.status, 0, `protoc --decode_raw failed: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("cross-codec: our encoder -> protoc decoder", () => {
  test("all scalar types and nested messages", () => {
    const msg = new Cross({
      title: "hello",
      neg: -1,
      zig: -2147483648,
      flag: true,
      blob: new Uint8Array([0, 1, 2, 255]),
      packed_u: [1, 2, 300],
      packed_s: [-1, 1, -2],
      loose: [10, -1],
      names: ["a", "日本"],
      inners: [
        { code: 7, note: "n1" },
        { code: -8 },
      ],
      primary: { code: 42 },
    });
    const bin = msg.encode();
    const text = protocDecode(bin);
    assert.match(text, /title: "hello"/);
    assert.match(text, /neg: -1/);
    assert.match(text, /zig: -2147483648/);
    assert.match(text, /flag: true/);
    // protoc 36 prints packed elements as repeated text-format lines.
    assert.match(text, /packed_u: 1\npacked_u: 2\npacked_u: 300/);
    assert.match(text, /packed_s: -1\npacked_s: 1\npacked_s: -2/);
    assert.match(text, /loose: 10/);
    assert.match(text, /loose: -1/);
    assert.match(text, /names: "a"\n/);
    // Non-ASCII is C-escaped by protoc text format; just verify a second
    // entry exists (value round-trip is covered by protoc->our tests).
    assert.match(text, /names: "\\346\\227\\245\\346\\234\\254"/);
    assert.match(text, /code: 7/);
    assert.match(text, /code: 42/);
  });

  test("explicit defaults are emitted and seen by protoc", () => {
    const msg = new Cross({ title: "" });
    msg.setNeg(0);
    msg.setZig(0);
    msg.setFlag(false);
    msg.setBlob(new Uint8Array(0));
    const text = protocDecode(msg.encode());
    // protoc text format shows explicitly-present zero fields.
    assert.match(text, /neg: 0/);
    assert.match(text, /zig: 0/);
    assert.match(text, /flag: false/);
  });

  test("empty message encoding round-trips through protoc", () => {
    // Cross has a required title; build an Inner (has required code).
    const bin = new Inner({ code: 0 }).encode();
    const r = runProtoc([`--proto_path=${PROTO_DIR}`, "--decode=Inner", "cross.proto"], Buffer.from(bin));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.toString(), /code: 0/);
  });
});

describe("cross-codec: protoc encoder -> our decoder", () => {
  test("full text-format message decodes with identical values", () => {
    const text = `
title: "world"
neg: -12345
zig: 12345
flag: true
blob: "\\x01\\x02"
packed_u: [10, 20, 4000000000]
packed_s: [-3, 3]
loose: 5
loose: -5
names: "x"
names: "😀"
inners { code: 1 note: "p" }
inners { code: 2 }
primary { code: 9 }
`;
    const bin = protocEncode(text);
    const m = Cross.decode(bin);
    assert.equal(m.title, "world");
    assert.equal(m.neg, -12345);
    assert.equal(m.zig, 12345);
    assert.equal(m.flag, true);
    assert.deepEqual(Array.from(m.blob!), [1, 2]);
    assert.deepEqual(m.packed_u, [10, 20, 4000000000]);
    assert.deepEqual(m.packed_s, [-3, 3]);
    assert.deepEqual(m.loose, [5, -5]);
    assert.deepEqual(m.names, ["x", "😀"]);
    assert.equal(m.inners.length, 2);
    assert.equal(m.inners[0].code, 1);
    assert.equal(m.inners[0].note, "p");
    assert.equal(m.inners[1].code, 2);
    assert.equal(m.primary!.code, 9);
  });

  test("protoc emits 10-byte varint for negative int32 and we decode it", () => {
    const bin = protocEncode(`title: "t"\nneg: -1\n`);
    // Locate neg tag (field 2 wt0 = 0x10); value must be 10 bytes.
    const arr = Array.from(bin);
    const tag = arr.indexOf(0x10);
    assert.ok(tag >= 0);
    assert.deepEqual(arr.slice(tag + 1, tag + 11), [
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]);
    assert.equal(Cross.decode(bin).neg, -1);
  });
});

describe("cross-codec: merge semantics on the wire", () => {
  test("split singular nested messages accepted by both", () => {
    // protoc's text parser rejects a repeated singular *text* field, but the
    // wire format allows it and decoders must merge. Hand-stitch the bytes:
    //   title="t", primary{code:3}, primary{note:"merged"}
    const part1 = protocEncode(`primary { code: 3 }\n`);
    const part2 = protocEncode(`primary { note: "merged" }\n`);
    const head = protocEncode(`title: "t"\n`);
    const bin = concat(head, part1, part2);

    const m = Cross.decode(bin);
    assert.equal(m.primary!.code, 3);
    assert.equal(m.primary!.note, "merged");
    // protoc agrees on the recursive merge.
    const decoded = protocDecode(bin);
    assert.match(decoded, /code: 3/);
    assert.match(decoded, /note: "merged"/);
  });

  test("packed and unpacked repeated scalar mix (hand-crafted) accepted", () => {
    // packed_u (field 6): packed [1,2], unpacked 3, packed [4].
    const body = Uint8Array.from([
      0x0a, 0x01, 0x74, // title field1 len1 "t"
      0x32, 0x02, 0x01, 0x02, // field6 packed len2
      0x30, 0x03, // field6 unpacked = 3
      0x32, 0x01, 0x04, // field6 packed len1 =4
    ]);
    const m = Cross.decode(body);
    assert.deepEqual(m.packed_u, [1, 2, 3, 4]);
    const decodedByProtoc = protocDecode(body);
    assert.match(decodedByProtoc, /packed_u: 1\npacked_u: 2\npacked_u: 3\npacked_u: 4/);
  });
});

describe("cross-codec: unknown fields survive against a reduced view", () => {
  test("fields beyond the schema are retained and protoc raw sees them", () => {
    // Construct a buffer with known fields + unknown high-numbered field.
    const base = new Cross({ title: "keep" }).encode();
    const unknown = Uint8Array.from([
      // field 5000 wt0 = (5000<<3)|0 = 40000 -> varint
      ...((): number[] => {
        const out: number[] = [];
        let x = 40000;
        while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x >>>= 7; }
        out.push(x);
        return out;
      })(),
      123,
    ]);
    const merged = new Uint8Array(base.length + unknown.length);
    merged.set(base, 0);
    merged.set(unknown, base.length);

    const m = Cross.decode(merged);
    m.setTitle("changed");
    const re = m.encode();

    // Our re-encoded bytes still contain the unknown field; protoc raw sees it.
    const raw = protocDecodeRaw(re);
    assert.match(raw, /5000: 123/);
    assert.match(protocDecode(re), /title: "changed"/);
  });
});

describe("cross-codec: malformed input", () => {
  test("protoc rejects what we reject: truncated length", () => {
    const bad = Uint8Array.from([0x0a, 0x05, 0x61]); // title len=5, 1 byte
    assert.throws(() => Cross.decode(bad), /past end/);
    const r = runProtoc([`--proto_path=${PROTO_DIR}`, "--decode=Cross", "cross.proto"], Buffer.from(bad));
    assert.notEqual(r.status, 0, "protoc should also reject truncated input");
  });
});

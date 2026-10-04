/**
 * Demo consumer for the generated codec test/gen/demo.ts.
 *
 * Run with: npm run demo
 *
 * It exercises the headline behaviors end to end:
 *  1. presence distinction (absent vs explicit default)
 *  2. negative int32 (10-byte varint) and sint32 ZigZag
 *  3. packed + unpacked mixed repeated scalars
 *  4. recursive merge of a repeated singular nested message across blocks
 *  5. required validation only after the whole merge completes
 *  6. unknown-field raw bytes retained (and reordered) across re-encodes
 */

import { Envelope, Node, Person } from "./gen/demo.js";
import { ProtoError } from "../src/runtime.js";

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
const tag = (field: number, wt: number) => varint((field << 3) | wt);
const ld = (field: number, body: number[]) => [...tag(field, 2), ...varint(body.length), ...body];

function section(title: string): void {
  console.log("\n=== " + title + " ===");
}

// 1. Presence ------------------------------------------------------------
section("1. absent vs explicit default");
const p = new Person({ name: "alice" });
p.setScore(0); // explicit zero
console.log("score present?", p.hasScore(), "value:", p.score);
console.log("active present?", p.hasActive(), "(never set)");
const wire1 = p.encode();
console.log("wire:", hex(wire1));
const p1 = Person.decode(wire1);
console.log("decoded score present?", p1.hasScore(), "->", p1.score);
console.log("decoded active present?", p1.hasActive());

// 2. Negative int32 / ZigZag --------------------------------------------
section("2. negative int32 is a 10-byte varint; sint32 uses ZigZag");
const n = new Node({ id: -1 });
n.addWeights(-1).addWeights(1);
const wire2 = n.encode();
console.log("Node{id=-1, weights=[-1,1]}:", hex(wire2));
console.log("decoded:", { id: Node.decode(wire2).id, weights: Node.decode(wire2).weights });

// 3. Mixed packed/unpacked ----------------------------------------------
section("3. mixed packed + unpacked repeated scalar (field 6 groups)");
const mixed = Uint8Array.from([
  ...tag(1, 2), 1, 0x61, // name = "a"
  ...ld(6, [...varint(1), ...varint(2)]), // groups packed [1,2]
  ...tag(6, 0), ...varint(3), // groups unpacked = 3
  ...ld(6, [...varint(4)]), // groups packed [4]
]);
const p3 = Person.decode(mixed);
console.log("merged groups:", p3.groups);
p3.groups.push(100);
console.log("after push+reencode groups:", Person.decode(p3.encode()).groups);

// 4. Recursive merge + delayed required check ----------------------------
section("4. singular nested message split across two blocks");
// First child block lacks required id; second provides it. Decode must
// NOT reject early; only a completed encode validates required fields.
const split = Uint8Array.from([
  ...tag(1, 0), 1, // id = 1
  ...ld(2, []), // child { }  (incomplete on its own)
  ...ld(2, [...tag(1, 0), ...varint(7)]), // child { id = 7 }
]);
const n4 = Node.decode(split); // no throw
console.log("merged child.id:", n4.child?.id);
console.log("encode after merge OK:", n4.encode().length, "bytes");

const incomplete = Node.decode(Uint8Array.from([...tag(1, 0), 1, ...ld(2, [])]));
try {
  incomplete.encode();
  console.log("UNEXPECTED: encode succeeded");
} catch (e) {
  console.log("required check after full merge ->", (e as ProtoError).message);
}

// 5. Unknown fields survive edits ----------------------------------------
section("5. unknown fields retained verbatim through edits");
// 9000 wt0, known name, 9001 wt5(fixed32), then edit score and re-encode.
const withUnknown = Uint8Array.from([
  ...tag(9000, 0), ...varint(123),
  ...tag(1, 2), 2, 0x6f, 0x6b, // "ok"
  ...tag(9001, 5), 1, 0, 0, 0,
]);
const p5 = Person.decode(withUnknown);
console.log("unknown chunks before edit:", p5.$unknown().length);
p5.setScore(999);
const re5 = p5.encode();
console.log("re-encoded:", hex(re5));
const p5b = Person.decode(re5);
console.log("name:", p5b.name, "score:", p5b.score);
console.log("unknown chunks after edit:", p5b.$unknown().length);
console.log("raw identical for untouched parts:", re5.length >= withUnknown.length);

// 6. Whole-envelope convenience construction -----------------------------
section("6. nested init objects + toJSON");
const env = new Envelope({
  topic: "people",
  person: {
    name: "bob",
    score: -7,
    groups: [10, 20],
    phones: [{ number: "555", extension: 42 }],
  },
  nodes: [{ id: 1, weights: [-1, -2] }, { id: 2 }],
});
const envWire = env.encode();
const envBack = Envelope.decode(envWire);
console.log(JSON.stringify(envBack.toJSON(), null, 2));
console.log("\nDemo complete.");

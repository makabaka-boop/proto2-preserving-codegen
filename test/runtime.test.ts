import { test, describe, assert } from "./harness.js";
import {
  Person,
  Node,
  PhoneNumber,
  Envelope,
} from "./gen/demo.js";
import { ProtoError, RequiredFieldError, zigZagEncode32 } from "../src/runtime.js";

/** Encode a varint (unsigned) into an array of bytes. */
function varint(v: number | bigint): number[] {
  let n = typeof v === "bigint" ? v : BigInt(v);
  const out: number[] = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

function tag(field: number, wt: number): number[] {
  return varint((field << 3) | wt);
}

function indexOfSeq(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

function lenDelim(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body];
}

describe("presence: absent vs explicit default", () => {
  test("fresh message has no presence for optional fields", () => {
    const p = new Person();
    assert.equal(p.hasScore(), false);
    assert.equal(p.hasActive(), false);
    assert.equal(p.hasName(), false);
    assert.equal(p.score, undefined);
    assert.deepEqual(p.groups, []);
  });

  test("explicit zero/false/empty is present and is encoded", () => {
    const p = new Person({ name: "x" });
    p.setScore(0);
    p.setActive(false);
    p.setDelta(0);
    p.setAvatar(new Uint8Array(0));
    const encoded = p.encode();
    // Every set field must appear on the wire, even defaults.
    assert.ok(encoded.includes(0x10), "score tag 2/0 expected"); // field 2 wt0
    assert.ok(encoded.includes(0x18), "delta tag 3/0 expected"); // field 3 wt0
    assert.ok(encoded.includes(0x20), "active tag 4/0 expected"); // field 4 wt0
    const back = Person.decode(encoded);
    assert.equal(back.hasScore(), true);
    assert.equal(back.score, 0);
    assert.equal(back.hasActive(), true);
    assert.equal(back.active, false);
    assert.equal(back.hasDelta(), true);
    assert.equal(back.delta, 0);
    assert.equal(back.hasAvatar(), true);
    assert.deepEqual(back.avatar, new Uint8Array(0));
  });

  test("clear removes presence", () => {
    const p = new Person({ name: "a", score: 5 });
    assert.equal(p.hasScore(), true);
    p.clearScore();
    assert.equal(p.hasScore(), false);
    assert.equal(p.score, undefined);
  });

  test("empty repeated is not encoded", () => {
    const n = new Node({ id: 1 });
    assert.deepEqual(n.encode(), bytes(tag(1, 0), [1]));
  });
});

describe("int32 negative values", () => {
  test("-1 encodes as exactly 10 varint bytes", () => {
    const n = new Node({ id: -1 });
    const enc = n.encode();
    // tag(1,0)=0x08 then 10 bytes: ff ff ff ff ff ff ff ff ff 01
    assert.deepEqual(
      Array.from(enc),
      [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
    );
    assert.equal(Node.decode(enc).id, -1);
  });

  test("INT32_MIN / INT32_MAX roundtrip", () => {
    for (const v of [-2147483648, -2147483647, -1, 0, 1, 2147483647]) {
      const enc = new Node({ id: v }).encode();
      assert.equal(Node.decode(enc).id, v);
    }
  });

  test("out-of-range int32 rejected", () => {
    const n = new Node({ id: 1 });
    assert.throws(() => n.setId(2147483648), ProtoError);
    assert.throws(() => n.setId(-2147483649), ProtoError);
  });
});

describe("sint32 ZigZag", () => {
  test("known zigzag encodings", () => {
    assert.equal(zigZagEncode32(0), 0);
    assert.equal(zigZagEncode32(-1), 1);
    assert.equal(zigZagEncode32(1), 2);
    assert.equal(zigZagEncode32(-2), 3);
    assert.equal(zigZagEncode32(2147483647), 4294967294);
    assert.equal(zigZagEncode32(-2147483648), 4294967295);
  });

  test("wire bytes match zigzag", () => {
    const p = new Person({ name: "z" });
    p.addZigzags(-1).addZigzags(1).addZigzags(-2147483648);
    const enc = p.encode();
    // field 7 packed, wire type 2: tag 0x3a; values 1, 2, 4294967295 => 1+1+5 = 7 bytes
    const expected = bytes(
      tag(1, 2),
      varint(1),
      [0x7a],
      tag(7, 2),
      varint(7),
      varint(1),
      varint(2),
      varint(4294967295),
    );
    assert.deepEqual(enc, expected);
    const back = Person.decode(enc);
    assert.deepEqual(back.zigzags, [-1, 1, -2147483648]);
  });
});

describe("packed / unpacked mixed repeated scalars", () => {
  test("decoder merges packed chunks and unpacked entries", () => {
    // groups = [1,2] packed, then groups = 3 unpacked, then [4,5] packed
    const enc = bytes(
      tag(1, 2),
      varint(1),
      [0x61], // "a"
      lenDelim(6, [...varint(1), ...varint(2)]),
      [...tag(6, 0), ...varint(3)],
      lenDelim(6, [...varint(4), ...varint(5)]),
    );
    const p = Person.decode(enc);
    assert.deepEqual(p.groups, [1, 2, 3, 4, 5]);
  });

  test("re-encoding packed field consolidates to a single packed chunk", () => {
    const enc = bytes(
      tag(1, 2),
      varint(1),
      [0x61],
      lenDelim(6, [...varint(1), ...varint(2)]),
      [...tag(6, 0), ...varint(3)],
    );
    const p = Person.decode(enc);
    p.groups.push(9);
    const re = p.encode();
    const back = Person.decode(re);
    assert.deepEqual(back.groups, [1, 2, 3, 9]);
    // Re-encoded field 6 must be one packed blob.
    assert.ok(re.includes(0x32), "packed field 6 expected somewhere");
    // The re-encoded field-6 chunk starts at tag 0x32 followed by length 4
    // (values 1,2,3,9 -> one-byte varints each).
    const idx = Array.from(re).indexOf(0x32);
    assert.ok(idx >= 0);
    assert.equal(re[idx + 1], 4);
  });

  test("explicitly non-packed repeated (scores) emits element tags", () => {
    const p = new Person({ name: "n" });
    p.addScores(10).addScores(-1);
    const enc = p.encode();
    const back = Person.decode(enc);
    assert.deepEqual(back.scores, [10, -1]);
    // -1 must appear as a 10-byte varint even inside unpacked repeated.
    const flat = Array.from(enc);
    // Two field-8 tags: 0x40 0x0a (=10), then 0x40 <10-byte -1>.
    const firstTag = flat.indexOf(0x40);
    const idx = flat.indexOf(0x40, firstTag + 1);
    assert.ok(idx >= 0);
    assert.deepEqual(flat.slice(idx + 1, idx + 1 + 10), [
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]);
  });

  test("packed empty payload decodes to zero elements", () => {
    const enc = bytes(tag(1, 2), varint(1), [0x61], tag(6, 2), [0x00]);
    const p = Person.decode(enc);
    assert.deepEqual(p.groups, []);
  });

  test("packed negative int32 sign-extends correctly", () => {
    // Node.weights (field 3, packed int32) = [-1, -2147483648, 7]
    const body = [
      ...varint(BigInt.asUintN(64, -1n)),
      ...varint(BigInt.asUintN(64, -2147483648n)),
      ...varint(7),
    ];
    const enc = bytes(tag(1, 0), [1], tag(3, 2), varint(body.length), body);
    const n = Node.decode(enc);
    assert.deepEqual(n.weights, [-1, -2147483648, 7]);
  });
});

describe("nested message merge", () => {
  test("same singular nested message appearing twice is recursively merged", () => {
    // Person.primary_phone appears twice: number in the first, extension in second.
    const enc = bytes(
      tag(1, 2),
      varint(3),
      [0x62, 0x6f, 0x62], // "bob"
      lenDelim(11, lenDelim(1, [0x31] /* "1" */)),
      lenDelim(11, [...tag(2, 0), ...varint(42)]),
    );
    const p = Person.decode(enc);
    assert.equal(p.primary_phone!.number, "1");
    assert.equal(p.primary_phone!.hasExtension(), true);
    assert.equal(p.primary_phone!.extension, 42);
  });

  test("required check waits until the whole merge is done", () => {
    // Node{id:1, child: Node{ }} followed by Node{child: Node{id:7}}.
    // The first child block lacks the required id; decoding must not reject.
    const enc = bytes(
      tag(1, 0),
      [1],
      lenDelim(2, []),
      lenDelim(2, [...tag(1, 0), ...varint(7)]),
    );
    const n = Node.decode(enc); // must not throw
    assert.equal(n.child!.id, 7);
    // Only after full merge does encoding validate required fields.
    const re = n.encode();
    const back = Node.decode(re);
    assert.equal(back.child!.id, 7);
  });

  test("encode rejects genuinely missing required fields after merge", () => {
    const enc = bytes(tag(1, 0), [1], lenDelim(2, []));
    const n = Node.decode(enc);
    assert.throws(() => n.encode(), (e: unknown) => {
      return e instanceof RequiredFieldError && e.path === "Node.child.id";
    });
  });

  test("mergeFrom recursively merges singular messages and appends repeats", () => {
    const a = new Person({
      name: "a",
      primary_phone: { number: "123" },
    });
    const b = new Person({
      primary_phone: { extension: 9 },
    });
    a.mergeFrom(b);
    assert.equal(a.primary_phone!.number, "123");
    assert.equal(a.primary_phone!.extension, 9);
    assert.equal(a.name, "a");
  });
});

describe("unknown fields", () => {
  test("unknown scalar fields are retained verbatim with relative order", () => {
    // field 9000 varint=123, name, field 9001 fixed64, field 9002 length-delimited
    const enc = bytes(
      [...tag(9000, 0), ...varint(123)],
      tag(1, 2),
      varint(2),
      [0x68, 0x69], // "hi"
      [...tag(9001, 1), 1, 2, 3, 4, 5, 6, 7, 8],
      [...tag(9002, 2), ...varint(3), 0xaa, 0xbb, 0xcc],
    );
    const p = Person.decode(enc);
    assert.equal(p.name, "hi");
    const unk = p.$unknown();
    assert.equal(unk.length, 3);
    // Re-encode byte-identically for this untouched case.
    assert.deepEqual(p.encode(), enc);
  });

  test("editing a known field keeps unknown bytes and order", () => {
    const unknownA = Uint8Array.from([...tag(9000, 0), ...varint(7)]);
    const unknownB = Uint8Array.from([...tag(9001, 5), 1, 0, 0, 0]);
    const p = Person.decode(
      bytes(
        [...Array.from(unknownA)],
        tag(1, 2),
        varint(2),
        [0x6f, 0x6b],
        [...Array.from(unknownB)],
      ),
    );
    p.setScore(55);
    const re = p.encode();
    const back = Person.decode(re);
    assert.equal(back.name, "ok");
    assert.equal(back.score, 55);
    assert.deepEqual(Array.from(back.$unknown()[0]), Array.from(unknownA));
    assert.deepEqual(Array.from(back.$unknown()[1]), Array.from(unknownB));
    // Raw ordering: unknownA precedes name; unknownB follows it.
    assert.ok(indexOfSeq(re, unknownA) < re.indexOf(0x6f));
    assert.ok(indexOfSeq(re, unknownB) > re.indexOf(0x6f));
  });

  test("known field number with wrong wire type is preserved as unknown", () => {
    // field 2 (score, wt0) sent as length-delimited.
    const enc = bytes(
      tag(1, 2),
      varint(1),
      [0x78],
      tag(2, 2),
      varint(2),
      [0xde, 0xad],
    );
    const p = Person.decode(enc);
    assert.equal(p.hasScore(), false);
    assert.equal(p.$unknown().length, 1);
    assert.deepEqual(p.encode(), enc);
  });

  test("unknown fields inside nested messages are retained", () => {
    const enc = bytes(
      tag(1, 2),
      varint(1),
      [0x74], // topic "t"
      lenDelim(2, [
        ...tag(1, 2),
        ...varint(1),
        0x70, // name "p"
        ...tag(77, 5),
        9,
        9,
        9,
        9,
      ]),
    );
    const e = Envelope.decode(enc);
    assert.equal(e.person!.$unknown().length, 1);
    assert.deepEqual(e.encode(), enc);
  });
});

describe("decode failures", () => {
  test("truncated varint fails", () => {
    assert.throws(() => Node.decode(Uint8Array.from([0x08, 0x80])), ProtoError);
  });

  test("11-byte varint fails", () => {
    assert.throws(
      () => Node.decode(Uint8Array.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])),
      ProtoError,
    );
  });

  test("length past end of buffer fails", () => {
    assert.throws(
      () => Node.decode(Uint8Array.from([0x08, 0x01, 0x12, 0x05, 1])),
      ProtoError,
    );
  });

  test("truncated fixed32 unknown fails", () => {
    // unknown field 9000 wt5 with only 2 body bytes.
    assert.throws(
      () => Person.decode(Uint8Array.from([...tag(9000, 5), 0, 0])),
      ProtoError,
    );
  });

  test("groups (wire type 3) fail explicitly", () => {
    assert.throws(() => Person.decode(Uint8Array.from(tag(50, 3))), ProtoError);
  });

  test("field number 0 fails", () => {
    assert.throws(() => Person.decode(Uint8Array.from([0x00])), ProtoError);
  });

  test("depth over 8 fails", () => {
    // 9 nested Node.child wrappers around a valid id.
    let body = bytes(tag(1, 0), [1]);
    for (let d = 0; d < 9; d++) {
      body = bytes(tag(2, 2), varint(body.length), [...Array.from(body)]);
    }
    assert.throws(() => Node.decode(body), /depth/);
  });

  test("depth exactly 8 nested messages decodes", () => {
    let body = bytes(tag(1, 0), [1]);
    for (let d = 0; d < 8; d++) {
      body = bytes(tag(2, 2), varint(body.length), [...Array.from(body)]);
    }
    const n = Node.decode(body);
    assert.equal(n.child!.child!.child!.child!.child!.child!.child!.child!.id, 1);
  });
});

describe("string and bytes", () => {
  test("UTF-8 roundtrip", () => {
    const p = new PhoneNumber({ number: "日本語-🇯🇵" });
    const back = PhoneNumber.decode(p.encode());
    assert.equal(back.number, "日本語-🇯🇵");
  });

  test("length prefix is sized on UTF-8 byte length, not JS string length", () => {
    // 100 code points * 3 UTF-8 bytes = 300 bytes, but .length === 100.
    const s = "あ".repeat(100);
    const p = new PhoneNumber({ number: s });
    const enc = p.encode(); // would throw on the internal size check before the fix
    assert.equal(PhoneNumber.decode(enc).number, s);
    // And 1000 4-byte emoji: 4000 bytes, varint length prefix = 2 bytes.
    const e = "😀".repeat(1000);
    const enc2 = new PhoneNumber({ number: e }).encode();
    assert.equal(PhoneNumber.decode(enc2).number, e);
  });

  test("invalid UTF-8 fails", () => {
    const enc = bytes(tag(1, 2), varint(2), [0xff, 0xfe]);
    assert.throws(() => PhoneNumber.decode(enc), ProtoError);
  });

  test("bytes copy does not alias the input buffer", () => {
    const src = bytes(tag(5, 2), varint(3), [1, 2, 3], tag(1, 2), varint(1), [0x78]);
    const p = Person.decode(src);
    src[2] = 99;
    assert.deepEqual(p.avatar, Uint8Array.from([1, 2, 3]));
  });
});

describe("uint32 boundaries", () => {
  test("4294967295 roundtrip", () => {
    const ph = new PhoneNumber({ number: "x", extension: 4294967295 });
    const back = PhoneNumber.decode(ph.encode());
    assert.equal(back.extension, 4294967295);
  });
  test("negative value rejected", () => {
    const ph = new PhoneNumber({ number: "x" });
    assert.throws(() => ph.setExtension(-1), ProtoError);
  });
});

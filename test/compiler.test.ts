import { test, describe, assert } from "./harness.js";
import { parseProto, CompileError } from "../src/compiler/parser.js";
import { generate } from "../src/compiler/generator.js";

function expectError(proto: string, fragment: RegExp | string): void {
  try {
    parseProto(proto, "case.proto");
    assert.fail("expected CompileError");
  } catch (e) {
    assert.ok(e instanceof CompileError, `expected CompileError, got ${(e as Error).constructor.name}: ${(e as Error).message}`);
    const msg = (e as Error).message;
    if (fragment instanceof RegExp) assert.match(msg, fragment);
    else assert.ok(msg.includes(fragment), `message "${msg}" should include "${fragment}"`);
    assert.match(msg, /case\.proto:\d+:\d+/, "error must carry file:line:col");
  }
}

const header = 'syntax = "proto2";\n';

describe("parser: basics", () => {
  test("empty file fails", () => {
    expectError("", /empty \.proto file/);
  });
  test("non-proto2 syntax fails", () => {
    expectError('syntax = "proto3";\n', /only proto2/);
  });
  test("minimal message parses", () => {
    const ir = parseProto(header + "message A { required int32 x = 1; }");
    assert.equal(ir.messages.length, 1);
    assert.equal(ir.messages[0].fields[0].label, "required");
    assert.equal(ir.messages[0].fields[0].typeName, "int32");
  });
  test("package and file options are accepted", () => {
    const ir = parseProto(header + 'package foo.bar;\noption java_package = "x";\nmessage A { required int32 x = 1; }');
    assert.equal(ir.package, "foo.bar");
  });
});

describe("parser: comments", () => {
  test("line comments attach to message and field", () => {
    const ir = parseProto(header + `
// message doc line
message A {
  // field doc
  optional string name = 1; // trailing-ish
}
`);
    assert.match(ir.messages[0].comment!, /message doc line/);
    assert.match(ir.messages[0].fields[0].comment!, /field doc/);
  });
  test("block comments attach too", () => {
    const ir = parseProto(header + `
/* block doc */
message A {
  /**
   * multi-line
   */
  optional int32 y = 1;
}
`);
    assert.match(ir.messages[0].comment!, /block doc/);
    assert.match(ir.messages[0].fields[0].comment!, /multi-line/);
  });
  test("unterminated block comment fails", () => {
    expectError(header + "/* oops", /unterminated block comment/);
  });
});

describe("parser: name / number diagnostics", () => {
  test("duplicate message name", () => {
    expectError(header + "message A { required int32 x = 1; } message A { required int32 y = 1; }", /duplicate message name 'A'/);
  });
  test("duplicate field name", () => {
    expectError(header + "message A { required int32 x = 1; optional int32 x = 2; }", /duplicate field name 'x'/);
  });
  test("duplicate field number", () => {
    expectError(header + "message A { required int32 x = 1; optional int32 y = 1; }", /duplicate field number 1/);
  });
  test("field number 0 illegal", () => {
    expectError(header + "message A { required int32 x = 0; }", /illegal field number 0/);
  });
  test("field number -1 illegal (no sign token)", () => {
    expectError(header + "message A { required int32 x = -1; }", /expected/);
  });
  test("reserved range 19000 illegal", () => {
    expectError(header + "message A { required int32 x = 19000; }", /illegal field number 19000/);
  });
  test("field number 536870912 illegal", () => {
    expectError(header + "message A { required int32 x = 536870912; }", /illegal field number/);
  });
  test("field name clashing with generated members rejected", () => {
    expectError(header + "message A { required int32 encode = 1; }", /clashes with a generated/);
  });
});

describe("parser: types", () => {
  test("unknown type", () => {
    expectError(header + "message A { required Ghost g = 1; }", /unknown type 'Ghost'/);
  });
  test("forward type reference accepted", () => {
    const ir = parseProto(header + "message A { optional B b = 1; } message B { required int32 x = 1; }");
    assert.equal(ir.messages[0].fields[0].isMessage, true);
    assert.equal(ir.messages[0].fields[0].typeName, "B");
  });
  test("recursive type accepted", () => {
    const ir = parseProto(header + "message A { optional A self = 1; }");
    assert.equal(ir.messages[0].fields[0].typeName, "A");
  });
  test("qualified names rejected", () => {
    expectError(header + "message A { optional foo.B b = 1; } message B { required int32 x = 1; }", /qualified type names/);
  });
});

describe("parser: unsupported constructs", () => {
  test("import rejected", () => {
    expectError(header + 'import "other.proto";', /import statements are not supported/);
  });
  test("enum rejected", () => {
    expectError(header + "enum E { A = 0; }", /enum is not supported/);
  });
  test("oneof rejected", () => {
    expectError(header + "message A { oneof x { int32 y = 1; } }", /oneof is not supported/);
  });
  test("nested message rejected", () => {
    expectError(header + "message A { message B { required int32 x = 1; } }", /nested messages/);
  });
  test("map rejected", () => {
    expectError(header + "message A { map<string,int32> m = 1; }", /map fields|unexpected/);
  });
  test("group rejected", () => {
    expectError(header + "message A { optional group G = 1 { optional int32 x = 2; } }", /groups are not supported|expected/);
  });
});

describe("parser: labels and options", () => {
  test("missing label rejected", () => {
    expectError(header + "message A { int32 x = 1; }", /expected field label/);
  });
  test("packed=true accepted on repeated numeric", () => {
    const ir = parseProto(header + "message A { repeated int32 x = 1 [packed = true]; }");
    assert.equal(ir.messages[0].fields[0].packed, true);
  });
  test("packed=false accepted", () => {
    const ir = parseProto(header + "message A { repeated int32 x = 1 [packed = false]; }");
    assert.equal(ir.messages[0].fields[0].packed, false);
  });
  test("packed rejected on repeated string", () => {
    expectError(header + "message A { repeated string x = 1 [packed = true]; }", /packed/);
  });
  test("packed rejected on singular field", () => {
    expectError(header + "message A { optional int32 x = 1 [packed = true]; }", /packed/);
  });
  test("unknown field option rejected", () => {
    expectError(header + "message A { optional int32 x = 1 [deprecated = true]; }", /unsupported field option/);
  });
  test("hex field number accepted", () => {
    const ir = parseProto(header + "message A { optional int32 x = 0x10; }");
    assert.equal(ir.messages[0].fields[0].number, 16);
  });
  test("float field number rejected", () => {
    expectError(header + "message A { optional int32 x = 1.5; }", /floating-point/);
  });
});

describe("parser: more than 6 messages", () => {
  test("7th message rejected", () => {
    const protos = [1, 2, 3, 4, 5, 6, 7].map((i) => `message M${i} { required int32 x = 1; }`).join("\n");
    expectError(header + protos, /more than 6/);
  });
  test("6 messages accepted", () => {
    const protos = [1, 2, 3, 4, 5, 6].map((i) => `message M${i} { required int32 x = 1; }`).join("\n");
    const ir = parseProto(header + protos);
    assert.equal(ir.messages.length, 6);
  });
});

describe("generator", () => {
  test("emits imports, classes, defs and defineMessages call", () => {
    const ir = parseProto(header + `
message B { required int32 z = 1; }
// A doc
message A {
  // hi
  optional string name = 1;
  repeated B bs = 2;
  repeated uint32 nums = 3 [packed = true];
}
`);
    const code = generate(ir, { runtimeImport: "../rt.js", sourceName: "x.proto" });
    assert.match(code, /from "\.\.\/rt\.js"/);
    assert.match(code, /export class A /);
    assert.match(code, /export class B /);
    assert.match(code, /\/\*\* A doc \*\//);
    assert.match(code, /\/\*\* hi \*\//);
    assert.match(code, /packed: true/);
    assert.match(code, /defineMessages\(/);
    // TS-ish sanity: every message gets decode + encode inherited
    assert.match(code, /static override decode\(bytes: Uint8Array\): A/);
  });
});

/**
 * Lexer + parser for the supported proto2 subset.
 *
 * Supported: syntax declaration, package, file/message options (ignored),
 * up to 6 top-level messages, required/optional/repeated fields of
 * int32/uint32/sint32/bool/string/bytes and message types, and
 * [packed = true|false] on repeated scalar fields.
 *
 * Comments (// and /* *\/) are lexed and attached as leading comments
 * to messages/fields so the generator can reproduce them as JSDoc.
 */

import {
  MIN_FIELD_NUMBER,
  MAX_FIELD_NUMBER,
  RESERVED_RANGE_START,
  RESERVED_RANGE_END,
  isReservedMemberName,
  type FieldLabel,
  type ScalarName,
} from "../runtime.js";

export class CompileError extends Error {
  constructor(message: string, pos?: SourcePos) {
    super(pos ? `${pos.file}:${pos.line}:${pos.col}: ${message}` : message);
    this.name = "CompileError";
  }
}

export interface SourcePos {
  file: string;
  line: number;
  col: number;
  offset: number;
}

export interface FieldIR {
  name: string;
  namePos: SourcePos;
  typeName: string;
  typePos: SourcePos;
  isMessage: boolean;
  label: FieldLabel;
  number: number;
  numberPos: SourcePos;
  packed: boolean;
  packedPos?: SourcePos;
  comment?: string;
}

export interface MessageIR {
  name: string;
  pos: SourcePos;
  fields: FieldIR[];
  comment?: string;
}

export interface ProtoFileIR {
  package?: string;
  messages: MessageIR[];
}

const SCALARS = new Set<ScalarName>([
  "int32",
  "uint32",
  "sint32",
  "bool",
  "string",
  "bytes",
]);

const MAX_TOP_LEVEL_MESSAGES = 6;

/* ------------------------------ lexer ----------------------------- */

type TokKind =
  | "ident"
  | "number"
  | "string"
  | "{"
  | "}"
  | "["
  | "]"
  | "("
  | ")"
  | "="
  | ";"
  | "."
  | ",";

interface Token {
  kind: TokKind;
  value: string;
  pos: SourcePos;
  /** Comments immediately preceding the token. */
  leadingComments: string[];
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function lex(source: string, file: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const posAt = (offset: number): SourcePos => {
    // Recompute line/col for token start cheaply during the scan instead.
    void offset;
    return { file, line, col, offset: i };
  };
  const pendingComments: string[] = [];

  function advance(n = 1): string {
    const c = source[i];
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
    return c;
  }

  while (i < source.length) {
    const c = source[i];
    // Whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }
    // Line comment
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i++;
      pendingComments.push(source.slice(start, i).trim());
      // Fix up line/col: advancing manually.
      const text = source.slice(start, i);
      for (const ch of text) {
        if (ch === "\n") {
          line++;
          col = 1;
        } else col++;
      }
      continue;
    }
    // Block comment
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      col += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        advance();
      }
      if (i >= source.length) {
        throw new CompileError("unterminated block comment", { file, line, col, offset: i });
      }
      advance(2); // */
      const text = source.slice(start, i);
      pendingComments.push(text.trim());
      continue;
    }
    // Identifier / keyword
    if (isIdentStart(c)) {
      const startPos = posAt(i);
      const start = i;
      while (i < source.length && isIdentPart(source[i])) advance();
      tokens.push({
        kind: "ident",
        value: source.slice(start, i),
        pos: startPos,
        leadingComments: pendingComments.splice(0),
      });
      continue;
    }
    // Number (only non-negative integer literals are legal here)
    if (/[0-9]/.test(c)) {
      const startPos = posAt(i);
      const start = i;
      if (c === "0" && (source[i + 1] === "x" || source[i + 1] === "X")) {
        advance(2);
        while (i < source.length && /[0-9a-fA-F]/.test(source[i])) advance();
      } else {
        while (i < source.length && /[0-9]/.test(source[i])) advance();
      }
      // Anything that makes this a float is illegal.
      if (source[i] === "." || source[i] === "e" || source[i] === "E") {
        throw new CompileError("floating-point literals are not supported", startPos);
      }
      if (isIdentPart(source[i] ?? "")) {
        throw new CompileError("malformed number literal", startPos);
      }
      tokens.push({
        kind: "number",
        value: source.slice(start, i),
        pos: startPos,
        leadingComments: pendingComments.splice(0),
      });
      continue;
    }
    // Strings (" and ')
    if (c === '"' || c === "'") {
      const startPos = posAt(i);
      const quote = c;
      advance();
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\n") {
          throw new CompileError("unterminated string literal", startPos);
        }
        if (source[i] === "\\") {
          advance();
          const esc = source[i];
          switch (esc) {
            case "n":
              value += "\n";
              break;
            case "t":
              value += "\t";
              break;
            case "r":
              value += "\r";
              break;
            case "\\":
              value += "\\";
              break;
            case "'":
              value += "'";
              break;
            case '"':
              value += '"';
              break;
            case "0":
              value += "\0";
              break;
            default:
              throw new CompileError(`unsupported string escape \\${esc}`, startPos);
          }
          advance();
        } else {
          value += source[i];
          advance();
        }
      }
      if (i >= source.length) {
        throw new CompileError("unterminated string literal", startPos);
      }
      advance(); // closing quote
      tokens.push({
        kind: "string",
        value,
        pos: startPos,
        leadingComments: pendingComments.splice(0),
      });
      continue;
    }
    // Punctuation
    const single: Record<string, TokKind> = {
      "{": "{",
      "}": "}",
      "[": "[",
      "]": "]",
      "(": "(",
      ")": ")",
      "=": "=",
      ";": ";",
      ".": ".",
      ",": ",",
    };
    if (single[c]) {
      const startPos = posAt(i);
      advance();
      tokens.push({ kind: single[c], value: c, pos: startPos, leadingComments: pendingComments.splice(0) });
      continue;
    }
    throw new CompileError(`unexpected character ${JSON.stringify(c)}`, { file, line, col, offset: i });
  }
  return tokens;
}

/* ------------------------------ parser ----------------------------- */

class Parser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly file: string,
  ) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private next(): Token {
    const t = this.tokens[this.i++];
    if (!t) throw new CompileError("unexpected end of input", this.lastPos());
    return t;
  }

  private lastPos(): SourcePos {
    const t = this.tokens[this.tokens.length - 1];
    return t ? t.pos : { file: this.file, line: 1, col: 1, offset: 0 };
  }

  private accept(kind: TokKind, value?: string): Token | undefined {
    const t = this.peek();
    if (t && t.kind === kind && (value === undefined || t.value === value)) {
      this.i++;
      return t;
    }
    return undefined;
  }

  private expect(kind: TokKind, value?: string): Token {
    const t = this.peek();
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      const want = value ?? kind;
      const got = t ? `'${t.value}'` : "end of input";
      throw new CompileError(`expected '${want}' but found ${got}`, t?.pos ?? this.lastPos());
    }
    return this.next();
  }

  parseProto(): ProtoFileIR {
    const ir: ProtoFileIR = { messages: [] };

    // syntax = "proto2";  (required, must be first non-comment)
    const first = this.peek();
    if (!first) {
      throw new CompileError("empty .proto file", {
        file: this.file,
        line: 1,
        col: 1,
        offset: 0,
      });
    }
    if (first.kind !== "ident" || first.value !== "syntax") {
      throw new CompileError(`missing 'syntax = "proto2";' declaration`, first.pos);
    }
    this.next();
    this.expect("=");
    const syntaxTok = this.expect("string");
    if (syntaxTok.value !== "proto2") {
      throw new CompileError(`only proto2 is supported, found syntax = "${syntaxTok.value}"`, syntaxTok.pos);
    }
    this.expect(";");

    const messageNames = new Set<string>();

    while (this.peek()) {
      const t = this.next();
      if (t.kind === ";") continue; // stray semicolon at top level
      if (t.kind !== "ident") {
        throw new CompileError(`unexpected token '${t.value}' at top level`, t.pos);
      }
      switch (t.value) {
        case "package": {
          if (ir.package) throw new CompileError("duplicate package declaration", t.pos);
          ir.package = this.parseFullName();
          this.expect(";");
          break;
        }
        case "option":
          this.parseOptionStatement();
          break;
        case "message": {
          if (ir.messages.length >= MAX_TOP_LEVEL_MESSAGES) {
            throw new CompileError(
              `more than ${MAX_TOP_LEVEL_MESSAGES} top-level messages are not supported`,
              t.pos,
            );
          }
          const msg = this.parseMessage(t.leadingComments);
          if (messageNames.has(msg.name)) {
            throw new CompileError(`duplicate message name '${msg.name}'`, msg.pos);
          }
          messageNames.add(msg.name);
          ir.messages.push(msg);
          break;
        }
        case "import":
          throw new CompileError("import statements are not supported", t.pos);
        case "enum":
          throw new CompileError("enum is not supported", t.pos);
        case "service":
          throw new CompileError("service is not supported", t.pos);
        case "extend":
        case "extensions":
        case "reserved":
          throw new CompileError(`'${t.value}' is not supported`, t.pos);
        default:
          throw new CompileError(`unsupported top-level construct '${t.value}'`, t.pos);
      }
    }

    resolveTypes(ir);
    return ir;
  }

  private parseFullName(): string {
    const first = this.expect("ident");
    let name = first.value;
    while (this.accept(".")) {
      name += "." + this.expect("ident").value;
    }
    return name;
  }

  private parseOptionStatement(): void {
    // option <fullName-or-(fullName)> = <constant> ;
    this.parseOptionName();
    this.expect("=");
    this.parseConstant("file");
    this.expect(";");
  }

  private parseOptionName(): string {
    let name = "";
    if (this.accept("(")) {
      name = "(" + this.parseFullName() + ")";
    } else {
      name = this.parseFullName();
    }
    while (this.accept(".")) {
      if (this.accept("(")) {
        name += ".(" + this.parseFullName() + ")";
      } else {
        name += "." + this.parseFullName();
      }
    }
    return name;
  }

  private parseConstant(scope: "file" | "field"): { name: string; value: string | number | boolean; pos: SourcePos } {
    const t = this.next();
    if (t.kind === "string") return { name: "", value: t.value, pos: t.pos };
    if (t.kind === "number") {
      const n = t.value.startsWith("0x") || t.value.startsWith("0X")
        ? parseInt(t.value, 16)
        : parseInt(t.value, 10);
      return { name: "", value: n, pos: t.pos };
    }
    if (t.kind === "ident") {
      if (t.value === "true") return { name: "", value: true, pos: t.pos };
      if (t.value === "false") return { name: "", value: false, pos: t.pos };
      // enum-like constants: identifiers with optional leading sign handled by caller
      return { name: "", value: t.value, pos: t.pos };
    }
    throw new CompileError(`invalid option value in ${scope} options`, t.pos);
  }

  private parseMessage(leadingComments: string[]): MessageIR {
    const nameTok = this.expect("ident");
    const msg: MessageIR = { name: nameTok.value, pos: nameTok.pos, fields: [] };
    if (leadingComments.length) msg.comment = leadingComments.join("\n");
    this.expect("{");
    const fieldNames = new Set<string>();
    const fieldNumbers = new Set<number>();

    while (!this.accept("}")) {
      const t = this.next();
      if (t.kind === ";") continue;
      if (t.kind !== "ident") {
        throw new CompileError(`unexpected token '${t.value}' in message ${msg.name}`, t.pos);
      }
      switch (t.value) {
        case "option":
          this.parseOptionStatement();
          break;
        case "message":
          throw new CompileError("nested messages are not supported", t.pos);
        case "enum":
          throw new CompileError("enum is not supported", t.pos);
        case "oneof":
          throw new CompileError("oneof is not supported", t.pos);
        case "map":
          throw new CompileError("map fields are not supported", t.pos);
        case "group":
          throw new CompileError("groups are not supported", t.pos);
        case "extensions":
        case "reserved":
        case "extend":
          throw new CompileError(`'${t.value}' is not supported`, t.pos);
        case "required":
        case "optional":
        case "repeated":
          this.parseField(t.value as FieldLabel, t.leadingComments, msg, fieldNames, fieldNumbers);
          break;
        default:
          throw new CompileError(
            `expected field label (required/optional/repeated) in message ${msg.name}, found '${t.value}'`,
            t.pos,
          );
      }
    }
    return msg;
  }

  private parseField(
    label: FieldLabel,
    leadingComments: string[],
    msg: MessageIR,
    fieldNames: Set<string>,
    fieldNumbers: Set<number>,
  ): void {
    const typeTok = this.expect("ident");
    if (typeTok.value === "group") {
      throw new CompileError("groups are not supported", typeTok.pos);
    }
    // Allow dotted names syntactically; resolution rejects non-local ones.
    let typeName = typeTok.value;
    while (this.accept(".")) {
      typeName += "." + this.expect("ident").value;
    }
    const nameTok = this.expect("ident");
    this.expect("=");
    const numTok = this.expect("number");
    let number: number;
    if (numTok.value.startsWith("0x") || numTok.value.startsWith("0X")) {
      number = parseInt(numTok.value, 16);
    } else {
      if (!/^[0-9]+$/.test(numTok.value)) {
        throw new CompileError(`invalid field number '${numTok.value}'`, numTok.pos);
      }
      number = parseInt(numTok.value, 10);
    }

    const isScalar = SCALARS.has(typeName as ScalarName);
    const isMessage = !isScalar;

    let packed = false;
    let packedPos: SourcePos | undefined;
    if (this.accept("[")) {
      do {
        const optPos = this.peek()?.pos ?? numTok.pos;
        const rawName = this.parseOptionName();
        const baseName = rawName.replace(/^\(|\)$/g, "").split(".").pop()!;
        this.expect("=");
        const value = this.parseOptionValue();
        if (baseName === "packed") {
          if (label !== "repeated" || !isScalar || typeName === "string" || typeName === "bytes") {
            throw new CompileError(
              "'packed' may only be set on a repeated numeric/bool scalar field",
              optPos,
            );
          }
          if (typeof value.value !== "boolean") {
            throw new CompileError("'packed' must be true or false", value.pos);
          }
          packed = value.value;
          packedPos = optPos;
        } else if (baseName === "default") {
          throw new CompileError(
            "field option 'default' is not supported: presence is tracked at runtime instead",
            optPos,
          );
        } else {
          throw new CompileError(`unsupported field option '${rawName}'`, optPos);
        }
      } while (this.accept(","));
      this.expect("]");
    }
    this.expect(";");

    if (
      number < MIN_FIELD_NUMBER ||
      number > MAX_FIELD_NUMBER ||
      (number >= RESERVED_RANGE_START && number <= RESERVED_RANGE_END)
    ) {
      throw new CompileError(
        `field ${nameTok.value}: illegal field number ${number} ` +
          `(allowed ${MIN_FIELD_NUMBER}..${RESERVED_RANGE_START - 1} and ${RESERVED_RANGE_END + 1}..${MAX_FIELD_NUMBER})`,
        numTok.pos,
      );
    }
    if (fieldNumbers.has(number)) {
      throw new CompileError(`field ${nameTok.value}: duplicate field number ${number} in message ${msg.name}`, numTok.pos);
    }
    if (fieldNames.has(nameTok.value)) {
      throw new CompileError(`duplicate field name '${nameTok.value}' in message ${msg.name}`, nameTok.pos);
    }
    if (isReservedMemberName(nameTok.value)) {
      throw new CompileError(
        `field name '${nameTok.value}' clashes with a generated method/property`,
        nameTok.pos,
      );
    }

    const field: FieldIR = {
      name: nameTok.value,
      namePos: nameTok.pos,
      typeName,
      typePos: typeTok.pos,
      isMessage,
      label,
      number,
      numberPos: numTok.pos,
      packed,
      packedPos,
    };
    if (leadingComments.length) field.comment = leadingComments.join("\n");
    fieldNames.add(nameTok.value);
    fieldNumbers.add(number);
    msg.fields.push(field);
  }

  private parseOptionValue(): { value: string | number | boolean; pos: SourcePos } {
    const c = this.next();
    if (c.kind === "string") return { value: c.value, pos: c.pos };
    if (c.kind === "number") {
      const n = c.value.startsWith("0x") ? parseInt(c.value, 16) : parseInt(c.value, 10);
      return { value: n, pos: c.pos };
    }
    if (c.kind === "ident") {
      if (c.value === "true") return { value: true, pos: c.pos };
      if (c.value === "false") return { value: false, pos: c.pos };
      return { value: c.value, pos: c.pos };
    }
    throw new CompileError("invalid option value", c.pos);
  }
}

function resolveTypes(ir: ProtoFileIR): void {
  const names = new Set(ir.messages.map((m) => m.name));
  for (const msg of ir.messages) {
    for (const f of msg.fields) {
      if (f.isMessage) {
        const local = f.typeName.startsWith(".") ? f.typeName.slice(1) : f.typeName;
        if (local.includes(".")) {
          throw new CompileError(
            `field ${f.name}: qualified type names are not supported (only top-level messages in this file)`,
            f.typePos,
          );
        }
        if (!names.has(local)) {
          throw new CompileError(
            `field ${f.name}: unknown type '${f.typeName}'`,
            f.typePos,
          );
        }
        f.typeName = local;
      }
    }
  }
}

export function parseProto(source: string, file = "<input>"): ProtoFileIR {
  const tokens = lex(source, file);
  return new Parser(tokens, file).parseProto();
}

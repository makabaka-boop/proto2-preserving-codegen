/**
 * TypeScript code generator.
 *
 * Emits one module containing one class per top-level message. Each class
 * stores wire state in the shared runtime's internal slots; the class
 * itself only exposes typed accessors and per-field presence helpers.
 */

import type { FieldIR, MessageIR, ProtoFileIR } from "./parser.js";

export interface GenerateOptions {
  /** Import specifier for the runtime module, e.g. "../runtime.js". */
  runtimeImport: string;
  /** Original proto file name, used in the generated header. */
  sourceName?: string;
}

function tsScalar(kind: string): string {
  switch (kind) {
    case "int32":
    case "uint32":
    case "sint32":
      return "number";
    case "bool":
      return "boolean";
    case "string":
      return "string";
    case "bytes":
      return "Uint8Array";
    default:
      throw new Error(`internal: unhandled scalar ${kind}`);
  }
}

function fieldTsType(f: FieldIR): string {
  const base = f.isMessage ? f.typeName : tsScalar(f.typeName);
  return f.label === "repeated" ? `${base}[]` : base;
}

function jsDoc(comment: string | undefined, indent: string): string {
  if (!comment) return "";
  // Normalize to plain lines.
  const raw = comment
    .replace(/^\/\/\s?/gm, "")
    .split("\n")
    .map((l) => l.trim());
  // Strip block-comment markers.
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    if (i === 0) l = l.replace(/^\/\*\*?/, "").trim();
    if (i === raw.length - 1) l = l.replace(/\*\/$/, "").trim();
    l = l.replace(/^\*\s?/, "");
    if (l.length > 0) lines.push(l);
  }
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${indent}/** ${escapeJSDoc(lines[0])} */\n`;
  return (
    `${indent}/**\n` +
    lines.map((l) => `${indent} * ${escapeJSDoc(l)}`).join("\n") +
    `\n${indent} */\n`
  );
}

function escapeJSDoc(s: string): string {
  return s.replace(/\*\//g, "*\\/");
}

function emitFieldDef(f: FieldIR): string {
  return (
    `      { name: ${JSON.stringify(f.name)}, number: ${f.number}, ` +
    `label: ${JSON.stringify(f.label)}, kind: ${JSON.stringify(
      f.isMessage ? f.typeName : f.typeName,
    )}, packed: ${f.packed}, isMessage: ${f.isMessage} }`
  );
}

function emitMessage(msg: MessageIR): string {
  const out: string[] = [];
  out.push(`export interface ${msg.name}Init {`);
  for (const f of msg.fields) {
    if (f.comment) out.push(jsDoc(f.comment, "  ").replace(/\n$/, ""));
    let initType: string;
    if (f.label === "repeated") {
      const elem = f.isMessage ? `${f.typeName} | ${f.typeName}Init` : fieldTsType(f);
      initType = `Array<${elem}>`;
    } else if (f.isMessage) {
      initType = `${fieldTsType(f)} | ${f.typeName}Init`;
    } else {
      initType = fieldTsType(f);
    }
    out.push(`  ${f.name}?: ${initType};`);
  }
  out.push("}");
  out.push("");

  if (msg.comment) out.push(jsDoc(msg.comment, "").replace(/\n$/, ""));
  out.push(`export class ${msg.name} extends ProtoMessage {`);
  out.push(`  static override readonly $def: MessageDef = $defs.${msg.name};`);
  out.push("");
  out.push(`  static override decode(bytes: Uint8Array): ${msg.name} {`);
  out.push(`    return decodeMessage(${msg.name}, bytes);`);
  out.push("  }");
  out.push("");

  // Field declarations.
  for (const f of msg.fields) {
    if (f.comment) out.push(jsDoc(f.comment, "  ").replace(/\n$/, ""));
    if (f.label === "repeated") {
      out.push(`  declare ${f.name}: ${fieldTsType(f)};`);
    } else {
      out.push(`  declare ${f.name}?: ${fieldTsType(f)};`);
    }
  }
  out.push("");

  out.push(`  constructor(init?: ${msg.name}Init) {`);
  out.push("    super(init as Record<string, unknown> | undefined);");
  out.push("  }");
  out.push("");

  for (const f of msg.fields) {
    if (f.comment) out.push(jsDoc(f.comment, "  ").replace(/\n$/, ""));
    if (f.label === "repeated") {
      const elemType = f.isMessage
        ? `${f.typeName} | ${f.typeName}Init`
        : fieldTsType(f).replace("[]", "");
      out.push(`  add${cap(f.name)}(item: ${elemType}): this {`);
      out.push(`    addRepeated(this, this.$defField(${f.number}), item as unknown, this.$defCtor());`);
      out.push("    return this;");
      out.push("  }");
      out.push("");
    } else {
      out.push(`  set${cap(f.name)}(value: ${fieldTsType(f)}${f.isMessage ? ` | ${f.typeName}Init` : ""}): this {`);
      out.push(`    setSingular(this, this.$defField(${f.number}), value as unknown, this.$defCtor());`);
      out.push("    return this;");
      out.push("  }");
      out.push("");
    }
    out.push(`  has${cap(f.name)}(): boolean {`);
    out.push(`    return this.$has("${f.name}");`);
    out.push("  }");
    out.push("");
    out.push(`  clear${cap(f.name)}(): this {`);
    out.push(`    clearField(this, "${f.name}");`);
    out.push("    return this;");
    out.push("  }");
    out.push("");
  }

  out.push("}");
  return out.join("\n");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generate(ir: ProtoFileIR, opts: GenerateOptions): string {
  const out: string[] = [];
  out.push("// Code generated by proto2ts. DO NOT EDIT.");
  if (opts.sourceName) out.push(`// Source: ${opts.sourceName}`);
  out.push("// proto2 subset codec — runtime presence semantics, unknown-field retention.");
  out.push("");
  out.push(`import {`);
  out.push(`  ProtoMessage,`);
  out.push(`  MessageDef,`);
  out.push(`  decodeMessage,`);
  out.push(`  defineMessages,`);
  out.push(`  setSingular,`);
  out.push(`  addRepeated,`);
  out.push(`  clearField,`);
  out.push(`} from ${JSON.stringify(opts.runtimeImport)};`);
  out.push("");

  // Defs table.
  out.push("const $defs: Record<string, MessageDef> = {};");
  for (const msg of ir.messages) {
    out.push(`$defs.${msg.name} = { name: ${JSON.stringify(msg.name)}, fields: [`);
    out.push(msg.fields.map(emitFieldDef).join(",\n"));
    out.push("] };");
  }
  out.push("");

  for (let i = 0; i < ir.messages.length; i++) {
    out.push(emitMessage(ir.messages[i]));
    if (i < ir.messages.length - 1) out.push("", "");
  }

  out.push("");
  out.push(`defineMessages(`);
  out.push(`  [${ir.messages.map((m) => `$defs.${m.name}`).join(", ")}],`);
  out.push(`  [${ir.messages.map((m) => m.name).join(", ")}],`);
  out.push(`);`);
  out.push("");
  return out.join("\n");
}

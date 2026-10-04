/**
 * Shared runtime for proto2-generated TypeScript codecs.
 *
 * Design notes:
 *  - Wire values for "known" fields are kept in per-instance internal slots
 *    (a WeakMap), separate from the class fields user code reads/writes.
 *    The encoder works off the slots, so presence of explicit defaults
 *    (0 / false / "" / b"") is distinguishable from "field never appeared".
 *    Before encoding, the class fields are reconciled into the slots.
 *  - Unknown fields are kept verbatim (including the tag bytes) in the
 *    relative order they appeared on the wire, interleaved with known
 *    fields. Re-encoding emits the raw bytes again, so edits to known
 *    fields never discard them.
 */

export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoError";
  }
}

/** Thrown after a full message merge when a required field is still absent. */
export class RequiredFieldError extends ProtoError {
  readonly path: string;
  constructor(path: string) {
    super(`missing required field: ${path}`);
    this.name = "RequiredFieldError";
    this.path = path;
  }
}

export type ScalarName =
  | "int32"
  | "uint32"
  | "sint32"
  | "bool"
  | "string"
  | "bytes";

export type FieldLabel = "required" | "optional" | "repeated";

/** Maximum allowed nesting depth of length-delimited messages. */
export const MAX_MESSAGE_DEPTH = 8;
/** Smallest field number that is not in the reserved descriptor range. */
export const MIN_FIELD_NUMBER = 1;
/** Largest legal field number. */
export const MAX_FIELD_NUMBER = 2 ** 29 - 1;
/** Start of the reserved 19000..19999 descriptor range. */
export const RESERVED_RANGE_START = 19000;
export const RESERVED_RANGE_END = 19999;

export interface FieldDef {
  name: string;
  number: number;
  label: FieldLabel;
  /** Scalar name, or the *name* of another message (resolved lazily). */
  kind: ScalarName | string;
  /** true iff this is a repeated scalar with [packed = true]. */
  packed: boolean;
  /** true iff kind names a message rather than a scalar. */
  isMessage: boolean;
}

export interface MessageDef {
  name: string;
  fields: FieldDef[];
  /** Populated by defineMessage() from `fields`. */
  byNumber?: Map<number, FieldDef>;
  byName?: Map<string, FieldDef>;
}

type WireType = 0 | 1 | 2 | 5;

interface KnownSlot {
  kind: "known";
  field: FieldDef;
  /**
   * - singular scalar: the scalar value
   * - singular message: a decoded/generated message instance
   * - repeated:          an array of values (packed stays one array/chunk)
   */
  value: unknown;
}

interface UnknownSlot {
  kind: "unknown";
  /** Complete raw bytes of this field occurrence, tag included. */
  raw: Uint8Array;
}

type Slot = KnownSlot | UnknownSlot;

interface InstanceState {
  slots: Slot[];
}

const stateMap = new WeakMap<object, InstanceState>();

function state(msg: ProtoMessage): InstanceState {
  let s = stateMap.get(msg);
  if (!s) {
    s = { slots: [] };
    stateMap.set(msg, s);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

export class Reader {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, pos = 0, end?: number) {
    this.buf = buf;
    this.pos = pos;
    this.end = end ?? buf.length;
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  /**
   * Read a base-128 varint as an unsigned BigInt.
   * Fails on truncation and on more than 10 bytes (64-bit varints).
   */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    let i = 0;
    for (;;) {
      if (this.pos >= this.end) {
        throw new ProtoError("truncated varint: end of buffer reached");
      }
      const b = this.buf[this.pos++];
      if (i >= 10) {
        throw new ProtoError("varint too long: more than 10 bytes");
      }
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (i === 9 && b > 1) {
          throw new ProtoError("varint overflow: value does not fit in 64 bits");
        }
        return result;
      }
      shift += 7n;
      i++;
    }
  }

  fixed32(): number {
    if (this.end - this.pos < 4) {
      throw new ProtoError("truncated fixed32");
    }
    const v =
      (this.buf[this.pos] |
        (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) |
        (this.buf[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  fixed64(): bigint {
    if (this.end - this.pos < 8) {
      throw new ProtoError("truncated fixed64");
    }
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v |= BigInt(this.buf[this.pos + i]) << BigInt(i * 8);
    }
    this.pos += 8;
    return v;
  }

  /** Read a length-delimited region; fails on impossible/truncated length. */
  lengthDelimited(): Uint8Array {
    const len = Number(this.varint());
    if (len < 0 || !Number.isSafeInteger(len) || this.end - this.pos < len) {
      throw new ProtoError("length-delimited field runs past end of buffer");
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

/** Skip a field with the given wire type; used for unknown fields. */
function skipField(r: Reader, wireType: number): void {
  switch (wireType) {
    case 0:
      r.varint();
      return;
    case 1:
      r.fixed64();
      return;
    case 2: {
      const len = Number(r.varint());
      if (len < 0 || !Number.isSafeInteger(len) || r.end - r.pos < len) {
        throw new ProtoError("unknown length-delimited field runs past buffer");
      }
      r.pos += len;
      return;
    }
    case 5:
      r.fixed32();
      return;
    case 3:
    case 4:
      throw new ProtoError("groups (wire type 3/4) are not supported");
    case 6:
    case 7:
      throw new ProtoError(`invalid wire type ${wireType}`);
    default:
      throw new ProtoError(`unknown wire type ${wireType}`);
  }
}

function wireTypeFor(field: FieldDef): WireType {
  if (field.isMessage) return 2;
  switch (field.kind) {
    case "int32":
    case "uint32":
    case "sint32":
    case "bool":
      return 0;
    case "string":
    case "bytes":
      return 2;
    default:
      throw new ProtoError(`internal: bad scalar kind ${field.kind}`);
  }
}

/* ------------------------------------------------------------------ */
/* Scalar conversions                                                  */
/* ------------------------------------------------------------------ */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;

function checkInt32(v: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtoError("int32 value must be an integer");
  }
  if (v < INT32_MIN || v > INT32_MAX) {
    throw new ProtoError(`int32 value ${v} out of range [-2147483648, 2147483647]`);
  }
  return v;
}

function checkSInt32(v: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtoError("sint32 value must be an integer");
  }
  if (v < INT32_MIN || v > INT32_MAX) {
    throw new ProtoError(`sint32 value ${v} out of range`);
  }
  return v;
}

export function zigZagEncode32(v: number): number {
  return ((v << 1) ^ (v >> 31)) >>> 0;
}

export function zigZagDecode32(u: number): number {
  return (u >>> 1) ^ -(u & 1);
}

function readScalar(r: Reader, kind: ScalarName, wireType: number): unknown {
  switch (kind) {
    case "int32": {
      if (wireType !== 0) throw new ProtoError("bad wire type for int32");
      const u = r.varint();
      // Sign-extend the low 32 bits, matching protobuf int32 semantics.
      return Number(BigInt.asIntN(32, u));
    }
    case "uint32": {
      if (wireType !== 0) throw new ProtoError("bad wire type for uint32");
      const u = r.varint();
      if (u < 0n || u > BigInt(UINT32_MAX)) {
        throw new ProtoError(`uint32 value ${u} out of range [0, 4294967295]`);
      }
      return Number(u);
    }
    case "sint32": {
      if (wireType !== 0) throw new ProtoError("bad wire type for sint32");
      const u = r.varint();
      if (u < 0n || u > BigInt(UINT32_MAX)) {
        throw new ProtoError(`sint32 zigzag value ${u} out of range`);
      }
      return zigZagDecode32(Number(u));
    }
    case "bool": {
      if (wireType !== 0) throw new ProtoError("bad wire type for bool");
      return r.varint() !== 0n;
    }
    case "string": {
      if (wireType !== 2) throw new ProtoError("bad wire type for string");
      return decodeUtf8(r);
    }
    case "bytes": {
      if (wireType !== 2) throw new ProtoError("bad wire type for bytes");
      return readBytes(r);
    }
  }
}

/** Read a string body from a reader positioned right after the tag. */
function decodeUtf8(r: Reader): string {
  const bytes = r.lengthDelimited();
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ProtoError("invalid UTF-8 in string field");
  }
}

/** Read bytes (copied) from a reader positioned right after the tag. */
function readBytes(r: Reader): Uint8Array {
  const b = r.lengthDelimited();
  // Copy: the input buffer may be reused by the caller.
  return b.slice();
}

/** Read one scalar from a packed payload (no tags, no string/bytes). */
function readPackedScalar(r: Reader, kind: ScalarName): unknown {
  switch (kind) {
    case "int32":
      return Number(BigInt.asIntN(32, r.varint()));
    case "uint32": {
      const u = r.varint();
      if (u < 0n || u > BigInt(UINT32_MAX)) {
        throw new ProtoError(`uint32 packed value ${u} out of range`);
      }
      return Number(u);
    }
    case "sint32": {
      const u = r.varint();
      if (u < 0n || u > BigInt(UINT32_MAX)) {
        throw new ProtoError(`sint32 packed zigzag value ${u} out of range`);
      }
      return zigZagDecode32(Number(u));
    }
    case "bool":
      return r.varint() !== 0n;
    case "string":
    case "bytes":
      throw new ProtoError("internal: string/bytes cannot be packed");
  }
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export class Writer {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  finish(): Uint8Array {
    const out = new Uint8Array(this.totalLength);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  get length(): number {
    return this.totalLength;
  }

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  varintBig(value: bigint): void {
    if (value < 0n) {
      throw new ProtoError("cannot encode negative value as unsigned varint");
    }
    const out: number[] = [];
    while (value >= 0x80n) {
      out.push(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    out.push(Number(value));
    this.push(Uint8Array.from(out));
  }

  tag(fieldNumber: number, wireType: number): void {
    this.varintBig(BigInt((fieldNumber << 3) | wireType));
  }

  fixed32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.push(b);
  }

  fixed64(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new ProtoError("fixed64 value out of range");
    }
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, value, true);
    this.push(b);
  }

  bytes(value: Uint8Array): void {
    this.varintBig(BigInt(value.length));
    this.push(value);
  }

  raw(value: Uint8Array): void {
    this.push(value);
  }
}

function writeScalar(w: Writer, kind: ScalarName, value: unknown): void {
  switch (kind) {
    case "int32": {
      const v = checkInt32(value as number);
      // Negative int32 is encoded as a 10-byte, 64-bit two's-complement varint.
      w.varintBig(BigInt.asUintN(64, BigInt(v)));
      return;
    }
    case "uint32": {
      const v = value as number;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > UINT32_MAX) {
        throw new ProtoError(`uint32 value ${String(v)} out of range`);
      }
      w.varintBig(BigInt(v));
      return;
    }
    case "sint32": {
      const v = checkSInt32(value as number);
      w.varintBig(BigInt(zigZagEncode32(v)));
      return;
    }
    case "bool": {
      w.varintBig(value ? 1n : 0n);
      return;
    }
    case "string": {
      if (typeof value !== "string") throw new ProtoError("string field needs a string");
      w.bytes(utf8Encoder.encode(value));
      return;
    }
    case "bytes": {
      if (!(value instanceof Uint8Array)) {
        throw new ProtoError("bytes field needs a Uint8Array");
      }
      w.bytes(value);
      return;
    }
  }
}

function scalarWireSize(kind: ScalarName, value: unknown): number {
  switch (kind) {
    case "int32":
      return varintSize(BigInt.asUintN(64, BigInt(checkInt32(value as number))));
    case "uint32": {
      const v = value as number;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > UINT32_MAX) {
        throw new ProtoError(`uint32 value ${String(v)} out of range`);
      }
      return varintSize(BigInt(v));
    }
    case "sint32":
      return varintSize(BigInt(zigZagEncode32(checkSInt32(value as number))));
    case "bool":
      return 1;
    case "string": {
      const byteLen = utf8Encoder.encode(value as string).length;
      return lenSize(byteLen) + byteLen;
    }
    case "bytes":
      return lenSize((value as Uint8Array).length) + (value as Uint8Array).length;
  }
}

function varintSize(v: bigint): number {
  let n = 1;
  while (v >= 0x80n) {
    v >>= 7n;
    n++;
  }
  return n;
}

function lenSize(len: number): number {
  return varintSize(BigInt(len));
}

/* ------------------------------------------------------------------ */
/* Message base class                                                  */
/* ------------------------------------------------------------------ */

type MessageCtor = (new (init?: Record<string, unknown>) => ProtoMessage) & {
  readonly $def: MessageDef;
};

/** Resolve a message kind name to its constructor. */
function resolveMessage(name: string, pool: Map<string, MessageCtor>): MessageCtor {
  const ctor = pool.get(name);
  if (!ctor) throw new ProtoError(`internal: unknown message type "${name}"`);
  return ctor;
}

export abstract class ProtoMessage {
  /** Set per subclass by defineMessage(). */
  declare static readonly $def: MessageDef;

  /** Decode a message of this class. Subclasses override with a narrower type. */
  static decode(bytes: Uint8Array): ProtoMessage {
    return decodeMessage(this as unknown as { new (): ProtoMessage }, bytes);
  }

  constructor(init?: Record<string, unknown>) {
    state(this);
    const def = (this.constructor as MessageCtor).$def;
    // Repeated fields start out as empty arrays.
    const self = this as unknown as Record<string, unknown>;
    for (const f of def.fields) {
      if (f.label === "repeated") self[f.name] = [];
    }
    if (init !== undefined) {
      applyInit(this, def, init);
    }
  }

  /** Whether a (non-repeated) field was present on the wire / set explicitly. */
  $has(fieldName: string): boolean {
    const def = (this.constructor as MessageCtor).$def;
    const field = def.byName!.get(fieldName);
    if (!field) throw new ProtoError(`no such field: ${fieldName}`);
    return state(this).slots.some((s) => s.kind === "known" && s.field.number === field.number);
  }

  /** All unknown fields, in wire order (raw bytes include each tag). */
  $unknown(): ReadonlyArray<Uint8Array> {
    return state(this)
      .slots.filter((s): s is UnknownSlot => s.kind === "unknown")
      .map((s) => s.raw);
  }

  /** Generated-code helper: this message's definition. */
  $defCtor(): MessageDef {
    return (this.constructor as MessageCtor).$def;
  }

  /** Generated-code helper: field definition by number. */
  $defField(n: number): FieldDef {
    const f = this.$defCtor().byNumber!.get(n);
    if (!f) throw new ProtoError(`internal: no field #${n}`);
    return f;
  }

  /** Merge another message of the same type into this one. */
  mergeFrom(other: ProtoMessage): this {
    if (other.constructor !== this.constructor) {
      throw new ProtoError("mergeFrom requires the same message type");
    }
    const s = state(this);
    for (const slot of state(other).slots) {
      mergeSlot(s.slots, slot, (this.constructor as MessageCtor).$def);
    }
    reconcileFromSlots(this);
    return this;
  }

  /** Encode the whole message. Required fields are validated first. */
  encode(): Uint8Array {
    const Ctor = this.constructor as MessageCtor;
    // Fold public-field edits into slots (recursively), *then* run the
    // required check: presence must reflect the final merged message.
    reconcileAll(this, Ctor.$def);
    ensureInitialized(this, Ctor.$def, Ctor.$def.name);
    const size = messageWireSize(this);
    const w = new Writer();
    writeMessage(w, this);
    if (w.length !== size) {
      throw new ProtoError("internal: encoder size mismatch");
    }
    return w.finish();
  }

  toJSON(): unknown {
    const def = (this.constructor as MessageCtor).$def;
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.label === "repeated") {
        const v = (this as unknown as Record<string, unknown>)[f.name];
        if (Array.isArray(v) && v.length > 0) out[f.name] = v;
      } else if (this.$has(f.name)) {
        const v = (this as unknown as Record<string, unknown>)[f.name];
        if (f.isMessage) {
          out[f.name] = (v as ProtoMessage).toJSON();
        } else if (v instanceof Uint8Array) {
          out[f.name] = base64Encode(v);
        } else {
          out[f.name] = v;
        }
      }
    }
    return out;
  }
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return Buffer.from(s, "binary").toString("base64");
}

/* ------------------------- init / presence ------------------------ */

const RESERVED_JS_NAMES = new Set(["constructor", "$def", "encode", "decode", "mergeFrom", "$has", "$unknown"]);

export function isReservedMemberName(name: string): boolean {
  return RESERVED_JS_NAMES.has(name);
}

function applyInit(msg: ProtoMessage, def: MessageDef, init: Record<string, unknown>): void {
  for (const key of Object.keys(init)) {
    const field = def.byName!.get(key);
    if (!field) throw new ProtoError(`${def.name}: unknown field "${key}" in initializer`);
    const value = init[key];
    if (value === undefined) continue;
    if (field.label === "repeated") {
      if (!Array.isArray(value)) {
        throw new ProtoError(`${def.name}.${field.name}: expected array`);
      }
      for (const item of value) addRepeated(msg, field, item, def);
    } else {
      setSingular(msg, field, value, def);
    }
  }
  reconcileFromSlots(msg);
}

/** Generated-code helper: read a singular field value (undefined if absent). */
export function getSingular(msg: ProtoMessage, fieldName: string): unknown {
  const def = (msg.constructor as MessageCtor).$def;
  const field = def.byName!.get(fieldName)!;
  const s = state(msg);
  for (let i = s.slots.length - 1; i >= 0; i--) {
    const slot = s.slots[i];
    if (slot.kind === "known" && slot.field.number === field.number) return slot.value;
  }
  return undefined;
}

/** Generated-code helper: set a singular scalar/message, establishing presence. */
export function setSingular(msg: ProtoMessage, field: FieldDef, value: unknown, def: MessageDef): void {
  const s = state(msg);
  let valueToStore: unknown;
  if (field.label === "repeated") {
    throw new ProtoError(`internal: ${field.name} is repeated`);
  }
  if (field.isMessage) {
    const pool = getPool(def);
    const Ctor = resolveMessage(field.kind, pool);
    if (value === null) {
      valueToStore = null;
    } else if (value instanceof Ctor) {
      valueToStore = value;
    } else if (value instanceof ProtoMessage) {
      throw new ProtoError(`${def.name}.${field.name}: wrong message type`);
    } else if (typeof value === "object") {
      valueToStore = new Ctor(value as Record<string, unknown>);
    } else {
      throw new ProtoError(`${def.name}.${field.name}: expected ${field.kind} or init object`);
    }
  } else {
    validateScalar(field.kind as ScalarName, value, def, field);
    valueToStore = value;
  }
  // Singular: last write wins, but the occurrence stays in wire order.
  const existingIdx = findKnownSlotIndex(s.slots, field.number);
  if (existingIdx >= 0) {
    (s.slots[existingIdx] as KnownSlot).value = valueToStore;
  } else {
    s.slots.push({ kind: "known", field, value: valueToStore });
  }
  if (valueToStore === null) {
    // Null clears a singular message field: drop presence entirely.
    const idx = findKnownSlotIndex(s.slots, field.number);
    if (idx >= 0) s.slots.splice(idx, 1);
  }
  syncFieldProperty(msg, field, s.slots);
}

function validateScalar(kind: ScalarName, value: unknown, def: MessageDef, field: FieldDef): void {
  switch (kind) {
    case "int32":
      checkInt32(value as number);
      return;
    case "sint32":
      checkSInt32(value as number);
      return;
    case "uint32":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
        throw new ProtoError(`${def.name}.${field.name}: uint32 value ${String(value)} out of range`);
      }
      return;
    case "bool":
      if (typeof value !== "boolean") {
        throw new ProtoError(`${def.name}.${field.name}: expected boolean`);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw new ProtoError(`${def.name}.${field.name}: expected string`);
      }
      return;
    case "bytes":
      if (!(value instanceof Uint8Array)) {
        throw new ProtoError(`${def.name}.${field.name}: expected Uint8Array`);
      }
      return;
  }
}

/** Generated-code helper: append one element to a repeated field. */
export function addRepeated(msg: ProtoMessage, field: FieldDef, item: unknown, def: MessageDef): void {
  const s = state(msg);
  const slot = getOrCreateRepeatedSlot(s.slots, field);
  if (field.isMessage) {
    const Ctor = resolveMessage(field.kind, getPool(def));
    let child: ProtoMessage;
    if (item instanceof ProtoMessage) {
      if (item.constructor !== Ctor) {
        throw new ProtoError(`${def.name}.${field.name}: wrong message type`);
      }
      child = item;
    } else if (typeof item === "object" && item !== null) {
      child = new Ctor(item as Record<string, unknown>);
    } else {
      throw new ProtoError(`${def.name}.${field.name}: expected ${field.kind}`);
    }
    (slot.value as unknown[]).push(child);
  } else {
    validateScalar(field.kind as ScalarName, item, def, field);
    (slot.value as unknown[]).push(item);
  }
  syncFieldProperty(msg, field, s.slots);
}

/** Generated-code helper: clear any field (removes presence / empties list). */
export function clearField(msg: ProtoMessage, fieldName: string): void {
  const def = (msg.constructor as MessageCtor).$def;
  const field = def.byName!.get(fieldName)!;
  const s = state(msg);
  if (field.label === "repeated") {
    const idx = s.slots.findIndex(
      (sl) => sl.kind === "known" && sl.field.number === field.number,
    );
    if (idx >= 0) s.slots.splice(idx, 1);
  } else {
    for (let i = s.slots.length - 1; i >= 0; i--) {
      const sl = s.slots[i];
      if (sl.kind === "known" && sl.field.number === field.number) s.slots.splice(i, 1);
    }
  }
  syncFieldProperty(msg, field, s.slots);
}

/* ---------------------------- slot utils -------------------------- */

function findKnownSlotIndex(slots: Slot[], fieldNumber: number): number {
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (s.kind === "known" && s.field.number === fieldNumber) return i;
  }
  return -1;
}

function getOrCreateRepeatedSlot(slots: Slot[], field: FieldDef): KnownSlot {
  // Repeated fields may have multiple chunks on the wire (mixed
  // packed/unpacked). User-side writes always go into the single last
  // "mutable" chunk, which is what the class-field array mirrors.
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (s.kind === "known" && s.field.number === field.number) return s;
  }
  const slot: KnownSlot = { kind: "known", field, value: [] };
  slots.push(slot);
  return slot;
}

function syncFieldProperty(msg: ProtoMessage, field: FieldDef, slots: Slot[]): void {
  const target = msg as unknown as Record<string, unknown>;
  if (field.label === "repeated") {
    // Expose the last chunk (the mutable one).
    for (let i = slots.length - 1; i >= 0; i--) {
      const s = slots[i];
      if (s.kind === "known" && s.field.number === field.number) {
        target[field.name] = s.value;
        return;
      }
    }
    target[field.name] = [];
  } else {
    const idx = findKnownSlotIndex(slots, field.number);
    target[field.name] = idx >= 0 ? (slots[idx] as KnownSlot).value : undefined;
  }
}

function reconcileFromSlots(msg: ProtoMessage): void {
  const def = (msg.constructor as MessageCtor).$def;
  collapseRepeatedChunks(state(msg).slots);
  const slots = state(msg).slots;
  const target = msg as unknown as Record<string, unknown>;
  for (const f of def.fields) {
    syncFieldProperty(msg, f, slots);
    if (f.label === "repeated" && target[f.name] === undefined) target[f.name] = [];
  }
}

/**
 * Merge multiple wire occurrences (packed chunks / unpacked entries) of
 * each repeated field into a single chunk at the position of its first
 * occurrence. Unknown-field bytes interleaved between them keep their
 * relative positions.
 */
function collapseRepeatedChunks(slots: Slot[]): void {
  const firstByField = new Map<number, number>();
  const removals: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.kind !== "known" || s.field.label !== "repeated") continue;
    const first = firstByField.get(s.field.number);
    if (first === undefined) {
      firstByField.set(s.field.number, i);
    } else {
      const into = slots[first] as KnownSlot;
      into.value = [...(into.value as unknown[]), ...(s.value as unknown[])];
      removals.push(i);
    }
  }
  for (let k = removals.length - 1; k >= 0; k--) slots.splice(removals[k], 1);
}

/**
 * Before encoding, fold changes made through the public class fields
 * back into the slots.
 */
function reconcileIntoSlots(msg: ProtoMessage, def: MessageDef): void {
  const s = state(msg);
  const target = msg as unknown as Record<string, unknown>;
  for (const f of def.fields) {
    const userVal = target[f.name];
    if (f.label === "repeated") {
      const arr = Array.isArray(userVal) ? userVal : [];
      // Merge multiple wire chunks (decode) / replace with the field array.
      const chunks: unknown[][] = [];
      for (const slot of s.slots) {
        if (slot.kind === "known" && slot.field.number === f.number) {
          chunks.push(slot.value as unknown[]);
        }
      }
      // Identify elements that originated from the wire vs user mutations.
      // Strategy: the last chunk is the mirrored one. If the public array
      // is exactly that array (same reference), keep all chunks; the user
      // mutated the last chunk in place. Otherwise replace everything with
      // the supplied array.
      const lastChunk = chunks.length > 0 ? chunks[chunks.length - 1] : null;
      const normalized = normalizeElements(arr, f, def);
      if (lastChunk === arr) {
        // In-place mutation; re-validate/re-normalize in place.
        for (let i = 0; i < arr.length; i++) {
          lastChunk[i] = normalizeElement(arr[i], f, def);
        }
      } else {
        // Replace all chunks for this field with one.
        for (let i = s.slots.length - 1; i >= 0; i--) {
          const sl = s.slots[i];
          if (sl.kind === "known" && sl.field.number === f.number) s.slots.splice(i, 1);
        }
        if (normalized.length > 0) {
          s.slots.push({ kind: "known", field: f, value: normalized });
        }
      }
    } else {
      const present = findKnownSlotIndex(s.slots, f.number) >= 0;
      if (userVal === undefined) {
        if (present) {
          // Explicitly cleared via property delete.
          for (let i = s.slots.length - 1; i >= 0; i--) {
            const sl = s.slots[i];
            if (sl.kind === "known" && sl.field.number === f.number) s.slots.splice(i, 1);
          }
        }
        continue;
      }
      if (f.isMessage) {
        let v = userVal;
        if (!(v instanceof ProtoMessage)) {
          const Ctor = resolveMessage(f.kind, getPool(def));
          if (v === null) {
            // null clears
          } else if (typeof v === "object") {
            v = new Ctor(v as Record<string, unknown>);
          } else {
            throw new ProtoError(`${def.name}.${f.name}: expected message`);
          }
        }
        if (v === null) {
          for (let i = s.slots.length - 1; i >= 0; i--) {
            const sl = s.slots[i];
            if (sl.kind === "known" && sl.field.number === f.number) s.slots.splice(i, 1);
          }
        } else {
          const idx = findKnownSlotIndex(s.slots, f.number);
          if (idx >= 0) (s.slots[idx] as KnownSlot).value = v;
          else s.slots.push({ kind: "known", field: f, value: v });
        }
      } else {
        validateScalar(f.kind as ScalarName, userVal, def, f);
        const idx = findKnownSlotIndex(s.slots, f.number);
        if (idx >= 0) (s.slots[idx] as KnownSlot).value = userVal;
        else s.slots.push({ kind: "known", field: f, value: userVal });
      }
    }
  }
}

function normalizeElements(arr: unknown[], field: FieldDef, def: MessageDef): unknown[] {
  return arr.map((x) => normalizeElement(x, field, def));
}

function normalizeElement(item: unknown, field: FieldDef, def: MessageDef): unknown {
  if (field.isMessage) {
    const Ctor = resolveMessage(field.kind, getPool(def));
    if (item instanceof Ctor) return item;
    if (item instanceof ProtoMessage) {
      throw new ProtoError(`${def.name}.${field.name}: wrong message type`);
    }
    if (typeof item === "object" && item !== null) {
      return new Ctor(item as Record<string, unknown>);
    }
    throw new ProtoError(`${def.name}.${field.name}: expected ${field.kind}`);
  }
  validateScalar(field.kind as ScalarName, item, def, field);
  return item;
}

/* ----------------------------- merging ---------------------------- */

function mergeSlot(slots: Slot[], incoming: Slot, def: MessageDef): void {
  if (incoming.kind === "unknown") {
    slots.push({ kind: "unknown", raw: incoming.raw });
    return;
  }
  const field = incoming.field;
  if (field.label === "repeated") {
    // Every wire occurrence becomes its own chunk: preserves packed vs
    // unpacked ordering on re-encode.
    slots.push({ kind: "known", field, value: (incoming.value as unknown[]).slice() });
    return;
  }
  if (field.isMessage) {
    const idx = findKnownSlotIndex(slots, field.number);
    if (idx >= 0) {
      // Recursively merge same-valued (single) nested message.
      const existing = (slots[idx] as KnownSlot).value as ProtoMessage;
      existing.mergeFrom(incoming.value as ProtoMessage);
    } else {
      slots.push({ kind: "known", field, value: incoming.value });
    }
    return;
  }
  // Singular scalar: last one wins, position kept at first occurrence.
  const idx = findKnownSlotIndex(slots, field.number);
  if (idx >= 0) {
    (slots[idx] as KnownSlot).value = incoming.value;
  } else {
    slots.push({ kind: "known", field, value: incoming.value });
  }
}

/* ----------------------------- decoding --------------------------- */

function decodeInto(msg: ProtoMessage, def: MessageDef, buf: Uint8Array, depth: number): void {
  if (depth > MAX_MESSAGE_DEPTH) {
    throw new ProtoError(`message nesting depth exceeds ${MAX_MESSAGE_DEPTH}`);
  }
  const pool = getPool(def);
  const r = new Reader(buf, 0, buf.length);
  const s = state(msg);
  while (!r.eof) {
    const fieldStart = r.pos;
    const tagRaw = r.varint();
    if (tagRaw > BigInt(MAX_FIELD_NUMBER) * 8n + 7n) {
      throw new ProtoError("tag encodes field number out of range");
    }
    const tag = Number(tagRaw);
    const wireType = tag & 7;
    const fieldNumber = tag >>> 3;
    if (fieldNumber < MIN_FIELD_NUMBER) {
      throw new ProtoError(`invalid field number ${fieldNumber}`);
    }
    if (fieldNumber > MAX_FIELD_NUMBER) {
      throw new ProtoError(`field number ${fieldNumber} out of range`);
    }
    const field = def.byNumber!.get(fieldNumber);
    const wireOk = field !== undefined && wireTypeMatches(field, wireType);
    if (!field || !wireOk) {
      // Unknown field, or known number with unexpected wire type:
      // preserve raw bytes (tag included), in place.
      skipField(r, wireType);
      const raw = buf.slice(fieldStart, r.pos);
      s.slots.push({ kind: "unknown", raw });
      continue;
    }

    if (field.label === "repeated") {
      if (field.isMessage) {
        const payload = r.lengthDelimited();
        const Ctor = resolveMessage(field.kind, pool);
        const child = new Ctor();
        decodeInto(child, Ctor.$def, payload, depth + 1);
        reconcileFromSlots(child);
        s.slots.push({ kind: "known", field, value: [child] });
      } else if (wireType === 2 && scalarIsLengthDelimited(field.kind as ScalarName) !== true) {
        // Packed occurrence of a scalar repeated field.
        if (!field.packed) {
          // A packed encoding for a non-packed declared field is still
          // decodable: protobuf accepts both representations.
        }
        const payload = r.lengthDelimited();
        const values = decodePacked(payload, field.kind as ScalarName, depth);
        s.slots.push({ kind: "known", field, value: values });
      } else {
        // Unpacked single occurrence.
        const value = readScalar(r, field.kind as ScalarName, wireType);
        s.slots.push({ kind: "known", field, value: [value] });
      }
    } else if (field.isMessage) {
      const payload = r.lengthDelimited();
      const Ctor = resolveMessage(field.kind, pool);
      const child = new Ctor();
      decodeInto(child, Ctor.$def, payload, depth + 1);
      reconcileFromSlots(child);
      const incomingSlot: Slot = { kind: "known", field, value: child };
      mergeSlot(s.slots, incomingSlot, def);
    } else {
      const value = readScalar(r, field.kind as ScalarName, wireType);
      mergeSlot(s.slots, { kind: "known", field, value }, def);
    }
  }
}

function decodePacked(payload: Uint8Array, kind: ScalarName, depth: number): unknown[] {
  if (depth > MAX_MESSAGE_DEPTH) {
    throw new ProtoError(`message nesting depth exceeds ${MAX_MESSAGE_DEPTH}`);
  }
  const pr = new Reader(payload, 0, payload.length);
  const values: unknown[] = [];
  while (!pr.eof) {
    values.push(readPackedScalar(pr, kind));
  }
  return values;
}

function scalarIsLengthDelimited(kind: ScalarName): boolean {
  return kind === "string" || kind === "bytes";
}

function wireTypeMatches(field: FieldDef, wireType: number): boolean {
  if (field.label === "repeated" && !field.isMessage && !scalarIsLengthDelimited(field.kind as ScalarName)) {
    // Numeric/bool repeated fields accept either packed (wt 2) or
    // unpacked (wt 0) on the wire.
    return wireType === 0 || wireType === 2;
  }
  return wireTypeFor(field) === wireType;
}

/* ----------------------------- encoding --------------------------- */

/** Recursively fold public class-field edits back into the wire slots. */
function reconcileAll(msg: ProtoMessage, def: MessageDef): void {
  reconcileIntoSlots(msg, def);
  for (const slot of state(msg).slots) {
    if (slot.kind !== "known" || !slot.field.isMessage) continue;
    if (slot.field.label === "repeated") {
      for (const child of slot.value as ProtoMessage[]) {
        reconcileAll(child, (child.constructor as MessageCtor).$def);
      }
    } else if (slot.value instanceof ProtoMessage) {
      reconcileAll(slot.value, (slot.value.constructor as MessageCtor).$def);
    }
  }
}

function messageWireSize(msg: ProtoMessage): number {
  const def = (msg.constructor as MessageCtor).$def;
  const slots = state(msg).slots;
  let total = 0;
  for (const slot of slots) {
    if (slot.kind === "unknown") {
      total += slot.raw.length;
      continue;
    }
    const f = slot.field;
    if (f.label === "repeated") {
      const arr = slot.value as unknown[];
      if (arr.length === 0) continue;
      if (f.isMessage) {
        for (const child of arr) {
          const bodyLen = messageWireSize(child as ProtoMessage);
          total += tagSize(f.number, 2) + lenSize(bodyLen) + bodyLen;
        }
      } else if (f.packed && !scalarIsLengthDelimited(f.kind as ScalarName)) {
        let bodyLen = 0;
        for (const v of arr) bodyLen += scalarValueSize(f.kind as ScalarName, v);
        total += tagSize(f.number, 2) + lenSize(bodyLen) + bodyLen;
      } else {
        const wt = wireTypeFor(f);
        for (const v of arr) {
          total += tagSize(f.number, wt) + scalarValueSize(f.kind as ScalarName, v);
        }
      }
    } else if (f.isMessage) {
      const child = slot.value as ProtoMessage;
      const bodyLen = messageWireSize(child);
      total += tagSize(f.number, 2) + lenSize(bodyLen) + bodyLen;
    } else {
      const wt = wireTypeFor(f);
      total += tagSize(f.number, wt) + scalarValueSize(f.kind as ScalarName, slot.value);
    }
  }
  return total;
}

function tagSize(fieldNumber: number, wt: number): number {
  return varintSize(BigInt((fieldNumber << 3) | wt));
}

function scalarValueSize(kind: ScalarName, value: unknown): number {
  // scalarWireSize already includes the length prefix for string/bytes.
  return scalarWireSize(kind, value);
}

function writeMessage(w: Writer, msg: ProtoMessage): void {
  const def = (msg.constructor as MessageCtor).$def;
  const slots = state(msg).slots;
  for (const slot of slots) {
    if (slot.kind === "unknown") {
      w.raw(slot.raw);
      continue;
    }
    const f = slot.field;
    if (f.label === "repeated") {
      const arr = slot.value as unknown[];
      if (arr.length === 0) continue;
      if (f.isMessage) {
        for (const child of arr) {
          w.tag(f.number, 2);
          writeLengthDelimitedMessage(w, child as ProtoMessage);
        }
      } else if (f.packed && !scalarIsLengthDelimited(f.kind as ScalarName)) {
        const inner = new Writer();
        for (const v of arr) writeScalar(inner, f.kind as ScalarName, v);
        const body = inner.finish();
        w.tag(f.number, 2);
        w.bytes(body);
      } else {
        const wt = wireTypeFor(f);
        for (const v of arr) {
          w.tag(f.number, wt);
          writeScalar(w, f.kind as ScalarName, v);
        }
      }
    } else if (f.isMessage) {
      const child = slot.value as ProtoMessage;
      w.tag(f.number, 2);
      writeLengthDelimitedMessage(w, child);
    } else {
      const wt = wireTypeFor(f);
      w.tag(f.number, wt);
      writeScalar(w, f.kind as ScalarName, slot.value);
    }
  }
}

function writeLengthDelimitedMessage(w: Writer, child: ProtoMessage): void {
  // Required validation runs top-down during the parent encode(); the
  // child slots were reconciled by reconcileAll() before sizing/writing.
  const inner = new Writer();
  writeMessage(inner, child);
  w.bytes(inner.finish());
}

/* --------------------------- required ----------------------------- */

function ensureInitialized(msg: ProtoMessage, def: MessageDef, path: string): void {
  const slots = state(msg).slots;
  for (const f of def.fields) {
    if (f.label === "required") {
      const present = slots.some(
        (s) => s.kind === "known" && s.field.number === f.number,
      );
      if (!present) throw new RequiredFieldError(`${path}.${f.name}`);
    }
    if (f.isMessage) {
      for (const s of slots) {
        if (s.kind !== "known" || s.field.number !== f.number) continue;
        if (f.label === "repeated") {
          for (const child of s.value as ProtoMessage[]) {
            ensureInitialized(child, (child.constructor as MessageCtor).$def, `${path}.${f.name}`);
          }
        } else {
          const child = s.value as ProtoMessage | undefined;
          if (child) {
            ensureInitialized(child, (child.constructor as MessageCtor).$def, `${path}.${f.name}`);
          }
        }
      }
    }
  }
}

/** Public check without throwing. */
export function isInitialized(msg: ProtoMessage): boolean {
  try {
    ensureInitialized(msg, (msg.constructor as MessageCtor).$def, (msg.constructor as MessageCtor).$def.name);
    return true;
  } catch (e) {
    if (e instanceof RequiredFieldError) return false;
    throw e;
  }
}

/* --------------------------- type pool ----------------------------- */

const pools = new WeakMap<MessageDef, Map<string, MessageCtor>>();

function getPool(def: MessageDef): Map<string, MessageCtor> {
  const pool = pools.get(def);
  if (!pool) throw new ProtoError("internal: message type pool not registered");
  return pool;
}

/**
 * Called by generated modules once all message classes exist.
 * Registers the shared type pool and builds lookup maps.
 */
export function defineMessages(
  defs: MessageDef[],
  ctors: Array<(new (init?: Record<string, unknown>) => ProtoMessage) & { readonly $def: MessageDef }>,
): void {
  const pool = new Map<string, MessageCtor>();
  for (const c of ctors) pool.set(c.$def.name, c);
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    def.byNumber = new Map();
    def.byName = new Map();
    for (const f of def.fields) {
      def.byNumber.set(f.number, f);
      def.byName.set(f.name, f);
    }
    pools.set(def, pool);
  }
}

export type { KnownSlot, UnknownSlot, Slot };

/* --------------------------- public decode ------------------------- */

/** Decode a buffer with a generated message class. */
export function decodeMessage<T extends ProtoMessage>(Ctor: { new (): T }, buf: Uint8Array): T {
  const msg = new Ctor();
  decodeInto(msg, (msg.constructor as MessageCtor).$def, buf, 0);
  reconcileFromSlots(msg);
  return msg;
}

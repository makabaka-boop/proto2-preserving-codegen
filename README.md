# proto2-ts-codegen

从真实 `.proto` 文本生成**可直接编译使用**的 TypeScript 编解码模块。
不接受预先整理好的字段 JSON —— 输入只有 `.proto` 源文件。

*生产编码/解码逻辑全部为本仓库自带的编译器 + 共享运行时；`protoc` 仅在测试中用于生成夹具和交叉验证。*

## 支持的 proto 子集

- 仅 `syntax = "proto2"`；最多 **6 个顶层 message**（不支持嵌套 message）
- 字段标签：`required` / `optional` / `repeated`
- 类型：`int32`、`uint32`、`sint32`、`bool`、`string`、`bytes` 以及本文件中的 message 类型
- 支持前向类型引用、递归 message（如 `optional Node child`）
- 数字/bool 的 `repeated` 支持 `[packed = true]`；`string`/`bytes` 不允许 packed
- 解析 `//` 与 `/* */` 注释并作为 JSDoc 保留到生成代码
- 顶层 `package`、文件级 `option`、消息级 `option` 可出现但被忽略

明确**不支持**并在编译期报错：`import`、`enum`、`oneof`、`group`、`map`、
嵌套 message、service、extend、reserved、extensions、浮点字面量、
带点限定类型名。

## 编译期诊断

解析 `.proto` 文本并报告（错误信息带 `file:line:col`）：

- 重名：重复 message 名、重复字段名
- 重复或非法字段号：重复、`0`、`19000..19999` 保留段、超过 `2^29-1`
- 未知类型（含前向引用在全部声明解析后仍找不到）
- 字段名与生成的方法/属性冲突
- 非法 packed 目标、未知字段选项、非法标签/语法等

## 运行时语义

| 主题 | 行为 |
| --- | --- |
| 存在性 | 字段未出现与显式默认值（`0`/`false`/`""`/空 bytes）严格区分；显式默认值会编码上线，`hasX()` 返回 true |
| int32 负数 | 按 64 位二进制补码 varint 编码，**-1 恰为 10 字节**；解码按低 32 位符号扩展 |
| sint32 | 标准 ZigZag（`(n<<1)^(n>>31)`），32 位越界值解码报错 |
| packed 混合 | 同一 repeated 标量的 packed 块与 unpacked 单值可以任意交错出现，解码合并为一个数组；重编码统一为 packed（声明了 `packed=true` 时） |
| 嵌套合并 | 同一单值嵌套 message 在 wire 上多次出现时**递归合并**而非替换 |
| required | 只在整条消息（含所有块）合并完成后、编码时统一校验；不会因第一块缺字段提前拒绝 |
| 未知字段 | 原始 wire 字节（含 tag）连同相对顺序保留；修改已知字段后重编码不丢失未知字段（不要求整份消息字节逐位一致） |
| 限制 | 只接受 wire type 0/1/2/5；嵌套深度超过 8、长度越界、截断 varint、超 10 字节 varint 均明确抛 `ProtoError`；wire 3/4（group）显式报错 |

## 用法

```bash
npm install
npm run build

# 生成：test/demo.proto -> test/gen/demo.ts
node dist/compiler/cli.js test/demo.proto \
  --out test/gen/demo.ts \
  --runtime ../../src/runtime.js
```

`--runtime` 是生成模块里引用运行时的 import 说明符，按输出位置调整。

生成代码示例：

```ts
import { Person } from "./gen/demo.js";

const p = new Person({ name: "alice" });
p.setScore(0);            // 显式 0，会编码上线
p.addGroups(1).addGroups(2);
p.hasScore();             // true
p.hasActive();            // false（从未出现）

const bytes = p.encode(); // Uint8Array
const q = Person.decode(bytes);
q.$unknown();             // 未知字段原始字节（含 tag），保持 wire 顺序
```

## 演示程序

```bash
npm run demo
```

`test/demo-consumer.ts` 端到端演示：存在性、负 int32 十字节、ZigZag、
packed/unpacked 混合、分块嵌套合并与延迟 required 校验、未知字段保留、
嵌套 init 对象。

## 测试

```bash
npm test          # 79 个断言（编译器 + 运行时 + protoc 交叉编解码）
npx tsx test/edge-checks.ts   # 额外的手工边界检查
```

- `test/runtime.test.ts`：存在性、varint/ZigZag 字节、packed 混合、递归合并、
  required 时机、未知字段保留/顺序、wire 限制（深度 8、截断、wire 3/4 等）
- `test/compiler.test.ts`：解析、注释、重名/重号/非法号/未知类型等诊断
- `test/crosscode.test.ts`：用官方 `protoc`（npm 包，仅 devDependency）做
  `--encode`/`--decode`/`--decode_raw` 交叉验证；并手工构造分块单值 message、
  packed/unpacked 交错等 protoc 文本格式无法直接表达的 wire 形态
- 生成代码另以 `test/gen/tsconfig.json` 在 `strict` 模式下通过 `tsc` 检查

## 布局

```
src/
  runtime.ts            共享运行时：Reader/Writer、slots、编解码、required
  compiler/
    parser.ts            .proto 词法/语法分析 -> IR（注释、前向引用、诊断）
    generator.ts         IR -> TypeScript 模块
    cli.ts              命令行入口与库入口
test/
  demo.proto             演示用 proto
  gen/demo.ts            由 demo.proto 生成
  fixtures/cross.proto   protoc 交叉测试夹具
  gen/cross.ts           由 cross.proto 生成
  runtime.test.ts        运行时语义测试
  compiler.test.ts       编译器诊断测试
  crosscode.test.ts      与官方 protoc 双向交叉验证
  demo-consumer.ts       演示消费程序
```

## 实现要点

每个 message 实例除了公开的类型化属性外，内部还维护一个有序的 **slot 列表**：

- `known` slot：字段定义 + 值；singular 多块标量"后值胜出但位置保持"，
  singular message 递归合并；repeated 最初每块一个 chunk（保留 packed 块与
  未知字段交错的顺序），解码后按字段首次出现位置折叠
- `unknown` slot：该字段从 tag 开始的完整原始字节
- 编码按 slot 顺序输出，未知 slot 原样写入；公开属性在编码前统一折叠回 slot，
  然后自顶向下做一次 required 检查，因此"默认值 vs 未出现"、合并与未知字段
  顺序三者可以同时成立

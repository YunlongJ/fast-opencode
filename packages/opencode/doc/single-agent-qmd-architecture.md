# Single-Agent Core + 轻量级内存上下文引擎方案

## 1. 核心愿景
本方案旨在通过一个**内存级 (In-Memory)** 的轻量化索引算法，解决 Agent 的上下文过载问题。弃用复杂的外部 QMD 服务，改用基于符号权重与最近使用的内存缓存机制，实现“极速、原子级”的上下文感知。

## 2. 核心架构设计

### 2.1 内存级上下文拉取 (In-Memory Context Pulling)
- **Hot Memory (热内存)**：在 Session 生命周期内，维护一个内存中的 `Symbol Map`。
- **基于高性能检索库 (FlexSearch)**：集成 `FlexSearch` 作为内存索引引擎。利用其分词 (Tokenization) 与多字段检索能力，对代码符号、逻辑片段进行极速匹配。
- **按需注入**：Agent 在推理时，不再全量读取文件，而是从内存索引中快速拉取 Top-K 的相关片段注入 Prompt。

### 2.2 统一 Single-Agent Core
- **单一入口**：所有的规划、搜索和修改逻辑收拢于 `build` Agent 核心。
- **能力化分发**：LLM 仅作为推理机，Agent 根据任务类型动态调整 Prompt 策略，无需切换 Agent 实例。

## 3. 极致性能与三方库集成 (High-Performance Stack)

### 3.1 符号热索引 (Symbolic Hot-Index)
- **极致提取 (WASM Tree-sitter)**：集成 `web-tree-sitter` (WASM)。利用其增量解析能力，在毫秒级内提取代码库的精确 AST 符号（Class, Function, Interface），替代粗暴的正则匹配。
- **极速检索 (FlexSearch)**：使用 `FlexSearch` 构建内存倒排索引。其分词器经过定制以支持代码特有的 `CamelCase` 命名，提供接近 O(1) 的检索响应。
- **LRU 淘汰**：配合内存占用监控，自动清理冷数据。

### 3.2 语义感知增强 (WASM Semantic Search)
- **本地语义引擎 (Voy)**：引入 `voy-search` (WASM 向量引擎)。
- **混合检索 (Hybrid Search)**：结合 FlexSearch 的关键词检索与 Voy 的语义相似度检索。当关键词匹配度低时，自动启用向量检索寻找逻辑相关的代码片段。

### 3.3 智能上下文分段 (Smart Chunking)
- **AST 级切分**：基于 Tree-sitter 的解析结果，将代码按逻辑原子（而非行数）进行切分，确保注入 LLM 的片段具有完整的语义上下文。

## 4. 实施路线图

### 第一阶段：极致引擎集成
- **WASM 环境搭建**：配置 `web-tree-sitter` 和各语言 (TS/JS/Java) 的 WASM 模块。
- **索引器实现**：开发 `MemoryContextEngine`，集成 FlexSearch 与 Tree-sitter。

### 第二阶段：Agent 逻辑收拢与重构
- **核心化**：在 `packages/opencode/src/agent/agent.ts` 中完成 Agent 逻辑收拢。
- **StepEngine 适配**：重构 `StepEngine`，在发送 Prompt 前调用 `MemoryContextEngine` 获取增强上下文。

### 第三阶段：上下文自动对齐
- 实现 `ContextGovernor`，在 LLM 调用前，根据检索结果自动精简 `messages` 历史。

## 5. 预期收益
- **极速响应**：毫秒级内存检索，无 I/O 开销。
- **低 Token 消耗**：初始上下文仅包含必要的任务指令，其余知识按需从内存拉取。
- **低复杂度**：无需安装 QMD 或启动额外的向量服务。

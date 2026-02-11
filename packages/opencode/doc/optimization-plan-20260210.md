# OpenCode 深度架构设计与优化方案 (2026-02-10)

## 1. 核心目标
构建一个类 Cursor/Windsurf 的高性能、深度 codebase 感知的 Single-Agent 系统。重点解决 Bun 环境下的性能瓶颈、上下文治理的颗粒度以及检索的语义深度。

## 2. 详细架构设计 (Deep Dive)

### 2.1 混合索引引擎 (Hybrid Indexing Engine)
采用三层索引结构，确保检索的准确性与覆盖率：
1.  **L1: 符号表 (AST Symbol Map)**
    - **实现**: 使用 `web-tree-sitter` 实时解析代码，提取类、函数、变量定义。
    - **增强**: 建立“符号拓扑图”，不仅知道函数在哪里定义，还知道它被谁调用（Cross-reference）。
2.  **L2: 全文检索 (FTS)**
    - **实现**: `FlexSearch` (WASM)。
    - **优化**: 针对代码分词进行定制，保留 `_`, `$` 等特殊字符。
3.  **L3: 语义向量 (Semantic Vector)**
    - **方案**: 在 Bun 环境下，优先尝试 `@huggingface/transformers@next` (v4 WebGPU 版本)。
    - **回退**: 若环境不兼容，采用 **Hashing Trick + TF-IDF 增强**，或通过 `Bun.spawn` 调用外部 Rust 编写的轻量级 Embedding 工具。

### 2.2 上下文治理 (Context Governor)
解决“上下文溢出”与“噪音干扰”的关键：
- **动态预算分配 (Dynamic Budgeting)**:
  - 历史消息 (History): 20%
  - 系统提示词 (System Prompt): 10%
  - 核心代码上下文 (Core Context): 50%
  - 辅助元数据 (Metadata/File Structure): 20%
- **基于语义权重的压缩 (Semantic-Driven Compression) [NEW]**:
  - **原理**: 利用 `SemanticEngine` 对上下文片段进行打分。
  - **策略**: 
    - 相似度 > 0.8: 保留完整内容。
    - 相似度 0.5 - 0.8: 仅保留方法签名、Javadoc 及核心控制流。
    - 相似度 < 0.5: 压缩为单行摘要或仅保留文件路径引用。
- **多级压缩策略 (Compression Tiers)**:
  - **Tier 1 (Skeleton)**: 仅保留类名、方法签名和 Javadoc。
  - **Tier 2 (Elision)**: 隐藏方法内部的不相关逻辑块（如大量的 `log` 或空校验）。
  - **Tier 3 (Summary)**: 使用 LLM 对长文件生成 200 字以内的语义摘要。

### 2.3 Bun 环境适配 (Bun-Native Performance)
- **FileSystemAdapter**: 
  - 弃用 Node.js 的 `fs.readFile`，全面改用 `Bun.file(path).text()`。
  - 利用 `Bun.mmap` 处理超大型索引文件。
- **并发处理**: 
  - 索引阶段使用 `Worker Threads` 处理 AST 解析，避免阻塞 Agent 思考的主线程。

## 3. 业界最佳实践参考 (Cursor/Windsurf)
- **Intent-based Context Pulling**: Agent 在思考阶段会先生成一个“检索计划”，明确需要拉取哪些符号的定义及其依赖，而非盲目搜索。
- **Reranking**: 检索回来的 Top-10 片段会经过一个轻量级的 Cross-Encoder 进行重排序，确保最相关的代码最接近 LLM 的底部。

## 4. 实施路线图 (Updated)

### Phase 1: 基础建设 (当前进行中)
- [x] 修复 `ContextGovernor` 核心 Bug。
- [x] 重构 `MemoryContextEngine` 的 LRU 逻辑。
- [ ] **Next**: 实现 `BunFileSystemAdapter` 提升 I/O 性能。

### Phase 2: 检索深度增强
- [ ] 升级 `ASTSymbolExtractor` 以支持跨文件引用追踪。
- [ ] 实验 `Transformers.js v4` 在当前 Bun 环境下的稳定性。

### Phase 3: 治理逻辑重构
- [ ] 将 `ContextGovernor` 重构为基于策略模式的压缩引擎。
- [ ] 引入 Token 预算动态管理机制。

---
*OpenCode 架构组 - 2026-02-10*

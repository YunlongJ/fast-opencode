# OpenCode 架构设计文档

本文档详细介绍了 OpenCode 的系统架构、设计思路及核心组件实现，旨在为开发者提供深度的技术参考。

## 1. 设计哲学 (Design Philosophy)

OpenCode 的设计核心围绕 **“极致效率”** 和 **“语义深度”** 展开。与传统的 AI 助手不同，OpenCode 旨在解决大规模代码库下的 Agent 响应慢、Token 易溢出以及上下文理解不准确等痛点。

- **异步优先 (Async-First)**: 所有耗时操作（IO、模型请求、向量检索）均采用非阻塞异步实现。
- **并行调度 (Parallel Orchestration)**: 打破传统的串行工具执行模型，通过资源锁实现安全的高并发。
- **语义持久化 (Semantic Persistence)**: 利用向量数据库和长短期记忆模型，实现跨会话的代码语义理解。
- **UI 响应性 (UI Responsiveness)**: 使用 React-in-Terminal 技术，确保在大规模数据处理时仍能提供流畅的 TUI 体验。

---

## 2. 系统核心架构 (System Core Architecture)

OpenCode 采用分层架构设计，各层职责清晰，通过事件总线 (Event Bus) 进行松耦合通信。

### 2.1 执行引擎层 (Execution Engine) - `StepEngine`
`StepEngine` 是整个系统的“大脑”，负责管理 LLM 与工具之间的多轮对话循环。
- **上下文治理 (Governance)**: 在每一轮推理前，通过 `MemoryStore` 动态构建最相关的上下文。
- **预测性加载**: 集成 `ToolCallPredictor`，在 LLM 决策过程中提前预判并准备工具资源。
- **错误自修复**: 捕获工具执行失败后的结构化错误，并转化为 LLM 可理解的修复建议。

### 2.2 工具编排层 (Tool Orchestrator)
负责工具的生命周期管理与并发控制。
- **ResourceLockManager**: 核心组件，通过 `shared`/`exclusive` 锁机制管理文件系统资源。
  - `shared`: 用于 `read`, `grep`, `glob` 等只读操作，支持多任务并行。
  - `exclusive`: 用于 `write`, `edit` 等写操作，确保原子性。
- **智能批处理 (Smart Batch)**: 自动合并相邻的同类工具调用，减少进程通信开销。

### 2.3 记忆与向量层 (Memory & Vector Store)
解决“长对话”和“大规模代码索引”的关键。
- **LanceDB 集成**: 使用高性能向量数据库持久化代码片段、会话决策和历史修改。
- **Compaction Service**: 自动检测 Token 溢出，通过摘要生成 (Checkpointing) 和历史修剪 (Pruning) 压缩上下文。
- **Info Extractor**: 自动从对话中提取关键决策 (Decision)、待办 (Todo) 和变更 (Change)，构建结构化记忆。

### 2.4 TUI 展现层 (Terminal User Interface)
基于 **Solid.js + Ink** 的现代化终端界面。
- **Frecency 算法**: 命令补全与 Prompt 提示基于“频率 + 时间衰减”算法，优先展示常用项。
- **Stream Renderer**: 增量渲染 LLM 输出，支持 Markdown、代码高亮和工具执行状态的实时反馈。

---

## 3. 核心工作流 (Core Workflow)

### 3.1 意图处理流程
1. **输入阶段**: TUI 捕获用户输入，通过 `SDKProvider` 发送到后端。
2. **上下文注入**: `StepEngine` 调用 `VectorStore` 检索与当前问题相关的历史代码片段。
3. **推理预测**: LLM 生成响应，同时 `ToolCallPredictor` 预加载可能用到的文件句柄。
4. **并行执行**: `ToolOrchestrator` 根据锁策略，并发运行多个只读工具。
5. **记忆固化**: `InfoExtractor` 提取执行结果中的关键信息，存入 `MemoryStore`。

---

## 4. 关键技术特性 (Technical Highlights)

### 4.1 语义引擎 (Semantic Engine)
集成 AST 提取器，不仅仅存储纯文本，更存储代码的语法结构。这使得 Agent 在搜索“调用了 X 函数的所有地方”时比纯文本搜索更精准。

### 4.2 智能缓存策略 (Smart Cache)
针对工具输出实现了多级缓存：
- **结果缓存**: 对耗时的 `grep` 或 `glob` 结果进行 Hash 校验，若文件内容未变则直接返回缓存。
- **LLM 缓存**: 对相似的系统提示词和上下文进行 Prefix Cache 优化（依赖供应商支持）。

### 4.3 线程安全与并发控制
核心组件均标注有 `@VertxThreadSafety` 或遵循单例模式，通过 `WriteOnceGuard` 确保关键配置和状态在并发环境下的确定性。

---

## 5. 目录结构说明

- `/src/acp`: Agent 协议定义，处理会话同步。
- `/src/agent`: Agent 提示词模板与逻辑封装。
- `/src/session/engine`: 核心执行引擎、向量存储、预测器等。
- `/src/cli/cmd/tui`: TUI 界面实现，包括组件与上下文。
- `/src/project`: 项目状态管理、VCS 集成与实例管理。

---

## 6. 未来演进 (Future Roadmap)
- **多 Agent 协作**: 支持子 Agent 拆分复杂任务。
- **深度调试集成**: 内置 LSP 交互式调试支持。
- **本地模型优化**: 进一步优化针对本地小参数量模型的提示词工程。

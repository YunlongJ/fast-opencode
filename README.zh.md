<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo" width="320">
    </picture>
  </a>
</p>

<p align="center">
  <strong>下一代开源 AI 编程助手</strong><br>
  <em>专为高性能调度、精准上下文管理和极致开发者体验而生。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.3.5-blue?logo=bun&logoColor=white" alt="Bun Version">
  <img src="https://img.shields.io/badge/React-Ink-61DAFB?logo=react&logoColor=black" alt="React Ink">
  <img src="https://img.shields.io/badge/向量库-LanceDB-orange" alt="LanceDB">
  <img src="https://img.shields.io/badge/许可证-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/PRs-欢迎-brightgreen" alt="PRs Welcome">
</p>

---

> [!IMPORTANT]
> 本项目是原开源项目 [OpenCode](https://github.com/anomalyco/opencode) 的**高性能 Fork 版本**。
> 我们在原版基础上进行了深度的架构重构，重点优化了 AI Agent 的执行效率、工具并行调度以及高级语义检索能力。

### ✨ 为什么选择这个版本？

虽然原版 OpenCode 提供了坚实的基础，但本项目专为**规模化开发**中的**速度**与**智能**而设计。我们消除了原有的串行执行瓶颈，引入了并行调度引擎和预测系统，确保系统始终领先于 Agent 的需求。

### 🚀 核心增强功能

#### ⚡ 高并发工具调度引擎 (Parallel Orchestrator)
*   **并行执行引擎**：`read`、`grep`、`glob` 等只读工具现在可以完全并行运行，将任务响应延迟降低了 70% 以上。
*   **高级资源锁**：精细化的 `ResourceLockManager` 支持共享锁与排他锁，确保并行执行时的并发安全与数据一致性。
*   **依赖感知调度**：根据工具间的数据依赖关系智能排队，最大化吞吐量。

#### 🧠 预测性智能层 (Predictive Intelligence)
*   **调用行为预测**：内置 `ToolCallPredictor`，基于历史交互模式预测 Agent 的下一步操作。
*   **资源预加载**：在 Agent “思考”过程中，预先加载相关文件内容和符号索引，实现零延迟响应。

#### 🔍 统一语义引擎 (Unified Semantic Engine)
*   **LanceDB 集成**：支持数百万代码片段的高性能向量检索。
*   **智能上下文压缩**：自动将长会话历史压缩为语义摘要，显著提升 Token 利用率。
*   **AST 结构化索引**：集成深度源码结构分析，提供更高精度的代码搜索。

#### 💻 极致 TUI 交互体验
*   **React + Ink 驱动**：完全现代化的终端界面，提供媲美 IDE 的交互质感。
*   **基于 Frecency 的智能补全**：根据使用频率（Frequency）和新鲜度（Recency）提供精准的命令建议。
*   **实时状态监控**：内置性能看板，实时追踪工具耗时与 Token 消耗。

---

### 📂 项目结构

```text
packages/
├── opencode/      # 核心逻辑、CLI 与 Agent 调度器
├── app/           # 主应用前端 (SolidJS)
├── console/       # 管理控制台与计费系统
├── desktop/       # 桌面端外壳 (Tauri)
├── docs/          # 文档站点
├── enterprise/    # 企业级增强功能
└── sdk/           # 多语言 SDK
```

### 🛠️ 快速开始

**前置条件：** [Bun](https://bun.sh) (v1.3.5 或更高版本)

```bash
# 克隆仓库
git clone https://github.com/your-username/opencode.git
cd opencode

# 安装依赖
bun install

# 启动开发版 TUI
bun run dev
```

---

### 🗺️ 路线图 (Roadmap)

- [x] 并行工具执行引擎
- [x] 基于向量库的上下文压缩
- [ ] **无尽模式 (Infinite Mode)**：具备自主纠错能力的持续任务处理
- [ ] 全局向量库同步
- [ ] `searchcode` UI 优化与多文件编辑增强

---

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

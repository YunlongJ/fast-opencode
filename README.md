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
  <strong>The Next-Generation Open-Source AI Coding Agent</strong><br>
  <em>Enhanced for high-performance orchestration, precision context management, and elite developer experience.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.3.5-blue?logo=bun&logoColor=white" alt="Bun Version">
  <img src="https://img.shields.io/badge/React-Ink-61DAFB?logo=react&logoColor=black" alt="React Ink">
  <img src="https://img.shields.io/badge/Vector_Store-LanceDB-orange" alt="LanceDB">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen" alt="PRs Welcome">
</p>

---

> [!IMPORTANT]
> This project is a **high-performance fork** of the original [OpenCode](https://github.com/anomalyco/opencode).
> It introduces significant architectural improvements focused on AI agent efficiency, parallel tool execution, and advanced semantic retrieval.

### ✨ Why This Fork?

While the original OpenCode provides a solid foundation, this version is engineered for **speed** and **intelligence** at scale. We've replaced sequential bottlenecks with parallel orchestration and integrated predictive systems to stay one step ahead of the agent's needs.

### 🚀 Key Enhancements

#### ⚡ High-Concurrency Tool Orchestrator
*   **Parallel Execution Engine**: Read-only tools (grep, glob, read) now run concurrently, slashing latency by up to 70%.
*   **Advanced Resource Locking**: A sophisticated `ResourceLockManager` handles shared and exclusive locks to ensure data integrity during parallel operations.
*   **Dependency-Aware Scheduling**: Intelligently sequences tool calls based on data dependencies.

#### 🧠 Predictive Intelligence Layer
*   **Tool Call Prediction**: Analyzes historical interaction patterns to anticipate the agent's next logical step.
*   **Resource Preloading**: Proactively warms up file contents and symbol indexes while the agent is "thinking".

#### 🔍 Unified Semantic Engine
*   **LanceDB Integration**: High-performance vector retrieval across millions of code fragments.
*   **Smart Context Compaction**: Automatically compresses long session histories into semantic summaries to maximize token efficiency.
*   **AST-Powered Indexing**: Uses deep structural analysis for more accurate code search and retrieval.

#### 💻 Elite TUI Experience
*   **React + Ink**: A completely modern terminal UI that feels like a full IDE.
*   **Frecency-Based Autocomplete**: Intelligent command suggestions based on Frequency and Recency.
*   **Real-Time Monitoring**: Built-in performance dashboard tracking tool latency and token usage.

---

### 📂 Project Structure

```text
packages/
├── opencode/      # Core logic, CLI, and Agent orchestrator
├── app/           # Main application frontend (SolidJS)
├── console/       # Management console and billing
├── desktop/       # Desktop wrapper (Tauri)
├── docs/          # Documentation site
├── enterprise/    # Enterprise-grade features
└── sdk/           # SDKs for various languages
```

### 🛠️ Quick Start

**Prerequisites:** [Bun](https://bun.sh) (v1.3.5 or higher)

```bash
# Clone the repository
git clone https://github.com/your-username/opencode.git
cd opencode

# Install dependencies
bun install

# Launch the development TUI
bun run dev
```

---

### 🗺️ Roadmap

- [x] Parallel tool execution engine
- [x] Vector-based context compression
- [ ] **Infinite Mode**: Continuous task solving with autonomous self-correction
- [ ] Global vector store synchronization
- [ ] Enhanced UI for `searchcode` and multi-file editing

---

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

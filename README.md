# OpenCode Enhanced

<p align="center">
  <strong>AI Coding Agent with Parallel Tool Execution</strong>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

> [!NOTE]
> This is an enhanced fork of [OpenCode](https://github.com/anomalyco/opencode) with significant performance improvements and architectural enhancements.

## ✨ Key Enhancements

### 🚀 Parallel Tool Execution Engine
- **Resource Lock Manager**: Sophisticated shared/exclusive lock system for safe concurrent operations
- **Dependency-Aware Scheduling**: Intelligent analysis of tool dependencies to maximize parallelism while ensuring data consistency
- **Adaptive Concurrency**: Dynamic adjustment of parallel tool limits based on execution duration and error rates
- **Read Operations Parallelization**: Multiple read-only tools (`read`, `grep`, `list`, `glob`) execute simultaneously, drastically reducing wait times

### 🔧 Enhanced Tools
- **Precise Code Navigation**: Jump directly to symbols, functions, classes, or line numbers with 1-based indexing
- **Smart Code Editing**: Multiple matching strategies (`exact`, `fuzzy`, `block`, `regex`) with `anchorLines` constraints
- **Safe Edit Modes**: `dryRun` and `validateOnly` options for risk-free code modifications
- **Intelligent Error Recovery**: Context-aware suggestions when edits fail (e.g., "Did you mean line X?")
- **Tool Result Caching**: Automatic caching of read operations to avoid redundant executions

#### 🛡️ Edit Tool Safety Features (New)
- **Expected Replacements**: Validates exact match count before editing (prevents accidental multi-replace)
- **Line Number Detection**: Auto-detects and rejects line number prefixes from Read tool output
- **Structured Error Feedback**: Detailed error types (`count_mismatch`, `line_number`, `not_found`) with actionable suggestions
- **Concurrent Edit Protection**: Resource locking prevents race conditions during parallel tool execution

### ⚡ Performance Optimizations
- **Async Lazy Loading**: Heavy components (Tree-Sitter parsers) load on-demand for faster startup
- **Storage Write Batching**: Aggregated state updates reduce I/O overhead
- **Optimized Processing Loops**: Refactored core engine for smoother execution flow
- **Work Queue Integration**: Robust background task management with priority scheduling

### 🎨 UI Improvements
- Streamlined terminal interface with better responsiveness
- Enhanced progress indicators for parallel operations
- Improved error visualization and debugging output

---

## 📦 Installation

```bash
# Clone and install
git clone <your-repo-url>
cd opencode
bun install

# Build
bun run build

# Run
cd packages/opencode
bun run start
```

---

## ⚙️ Configuration

Add to your `~/.opencode/config.json`:

```json
{
  "experimental": {
    "parallel_execution": true,
    "max_parallel_tools": 16
  }
}
```

---

## 🏗️ Architecture Highlights

```
┌─────────────────────────────────────────────────────────────┐
│                    Tool Orchestrator                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Dependency  │  │   Resource  │  │  Adaptive Limiter   │ │
│  │   Graph     │  │    Locks    │  │  (Dynamic Concurrency)│ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │  read   │          │  grep   │          │  bash   │
   │ (parallel)│        │(parallel)│         │(serial) │
   └─────────┘          └─────────┘          └─────────┘
```

---

## 🤝 Contributing

This fork focuses on performance and tool enhancements. Contributions welcome!

---

## 📝 Recent Updates

### 2025-02-27: Edit Tool Safety Enhancement
- **Added** `expectedReplacements` parameter for precise edit control
- **Added** automatic line number prefix detection and removal
- **Added** structured error types with actionable suggestions
- **Added** concurrent edit protection via resource locking
- **Improved** error messages with specific guidance for recovery

### 2025-02-27: Read Tool Performance Optimization
- **Added** intelligent file content caching (LRU with mtime validation)
- **Added** fast binary file detection via extension whitelist
- **Added** concurrent execution metadata (`getResourceKeys`, `getTimeout`)
- **Improved** streaming read performance for large files
- **Improved** tool description for better LLM guidance

---

**Original Project**: [OpenCode](https://github.com/anomalyco/opencode) | **License**: MIT

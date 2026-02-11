# 核心 Agent 执行链路 Review & 重构计划（SessionProcessor / SessionPrompt）

本文聚焦 `packages/opencode/src/session/processor.ts` 与其上游 `packages/opencode/src/session/prompt.ts` 的核心执行链路，目标是：在保证正确性/可观测性的前提下，显著提升吞吐与交互延迟，并把结构从“单文件巨石”进化为可演进的执行引擎。

## 1. 当前链路速览（以代码为准）

- 主循环入口：`SessionPrompt.loop()`（`src/session/prompt.ts`）
  - 负责：会话状态管理、消息队列/回放、选择 agent、构建 tools、创建 assistant message，最后调用 `SessionProcessor.create(...).process(...)`。
- 执行器：`SessionProcessor.process()`（`src/session/processor.ts`）
  - 负责：驱动 `LLM.stream()` 产出事件流，写入 Message parts（text/reasoning/tool/step/patch），做 retry、compaction 触发、permission block、snapshot patch 生成等。
- 工具定义：`resolveTools()`（`src/session/prompt.ts`）
  - 通过 `ToolRegistry.tools(...)` + MCP tools 组装 Vercel AI SDK `tool(...)`，并将 `execute()` 包装进 plugin hooks 与权限询问。

## 2. Review 结论：优先级最高的问题（先保命，再谈性能）

### 2.1 并行工具执行模型存在“正确性不闭合”的高风险点

`SessionProcessor.process()` 在 `parallelEnabled` 分支里：

- 一边把 `tool-call` 收集为 `pendingExecutors`，再走 `executeToolsParallel()` 手动调用 `tool.execute(...)`；
- 另一边又在同一条 `LLM.stream().fullStream` 上继续处理 `tool-result` / `tool-error` 事件。

该组合在语义上很容易出现：

- 工具被执行两次（尤其是有副作用的 tool：write/apply_patch/bash 等）；
- tool part 状态被重复/乱序写入（手动写 completed + stream 又来 tool-result 再写一次）；
- 权限拒绝/问题拒绝的“阻塞语义”在并行路径未对齐（手动执行抛错时只标记 part error，但 `blocked` 的推导只在 `tool-error` 分支处理）。

这类问题属于“再快也没用”的级别：一旦出现重复写文件、重复执行 shell，会把用户 workspace 直接污染。

### 2.2 单文件巨石：职责混杂导致可维护性与可测试性极差

`processor.ts` 目前同时承担了：

- LLM 事件流消费与状态机（start/step/text/reasoning/tool/finish）
- Session part 的持久化写入与 delta 合并策略
- retry/backoff
- compaction 判定与触发
- snapshot/patch 生成
- parallel tool scheduler + 资源锁 + 自适应并发

这会直接导致：

- 任何一个子能力的调整都会“牵一发动全身”
- 很难给关键路径写稳定的单测/集成测试
- 性能优化缺少可观测边界（到底慢在 LLM、storage 写入、还是 tool 调度）

### 2.3 UI/状态机一致性问题：上游工具上下文期待“running”，并行分支用“pending”

`prompt.ts` 的 tool context 里 `metadata()` 仅在 tool part 处于 `running` 时更新（见 `resolveTools()` 内 `metadata` 实现）。

但 `processor.ts` 在并行分支把 tool 状态设为 `pending`，这会导致：

- tool 执行时的标题/元信息更新无法落到 UI（或落得很晚）
- tool 的可视化体验变差，调试也更困难

### 2.4 现有“自适应并发/节流/锁”实现缺少系统性约束

典型迹象：

- 多个 limiter/lock 实现并存、重复（`executeToolsParallel` 内建 limiter + process 内再建一个自适应 limiter）
- 局部变量未使用（例如 `parallelExecutedCount`），存在半成品痕迹
- 锁策略只对 `read/grep` 做 shared，其余全 exclusive，过于粗糙
- `ToolResultCache` 仅 set 不消费，属于“写了但没形成闭环”的代码债

结论：在没有统一执行模型（以及测试/观测）前，继续在此基础上堆性能只会放大不确定性。

## 3. 目标：超过 Claude Code，需要什么“硬指标”

以“用户体感”为导向，我建议用可量化的 KPI 驱动重构：

- 交互延迟：TTFT（time-to-first-token）与首个可见 delta 写入延迟
- 工具吞吐：同一轮内多 tool 的 wall-clock 时间（尤其是 read/grep 批量任务）
- 副作用安全：写类工具（write/apply_patch/bash/edit）在任何路径下最多执行一次
- 稳定性：abort/cancel/retry 不泄漏 timer，不遗留 pending tool part
- 可观测：每一步（LLM、tool、storage、compaction）都有统一 trace/span

## 4. 重构总方案：把“流式生成”和“工具执行”解耦成两段式 Step Engine

### 4.1 关键决策：并行工具执行要“真并行”，必须使用两段式

真正可控的并行工具执行通常是：

1) LLM 生成 tool-calls（只生成，不执行）
2) 执行器按依赖/资源锁并行执行工具，生成 tool-results
3) 把 tool-results 作为下一次 LLM 调用的输入，让模型继续（或收尾）

这样可以做到：

- 工具执行完全由我们调度（可并行、可取消、可重试、可锁资源）
- tool part 的状态机完全由我们控制（pending/running/completed/error）
- 不依赖底层 SDK 对工具执行的隐式行为，避免“重复执行”的不确定性

### 4.2 模块边界（建议的目标结构）

将 `processor.ts` 拆为以下模块（保留现有外部 API：`SessionProcessor.create().process()`）：

- `StepEngine`
  - 驱动状态机：Generate → ExecuteTools → Continue/Stop/Compact
- `StreamRenderer`
  - 负责 text/reasoning 的 delta buffer、节流策略、part 写入（对 storage 的写入做批处理）
- `ToolOrchestrator`
  - 负责 tool call 收集、依赖图、资源锁、并发控制、超时、结果汇总
- `RetryPolicy`
  - 只负责判断 retryable、计算 backoff、统一处理 retry part/status
- `SnapshotManager`
  - start-step / finish-step / patch part 的一致性
- `CompactionController`
  - overflow 判定与 compaction 任务注入策略（减少分散的 if）

## 5. 分阶段落地计划（可持续交付）

### Phase 0：基线与防回归（必须先做）

- 增加“工具最多执行一次”的断言与埋点（按 `sessionID + callID` 维度计数）
- 增加执行路径 trace：LLM stream、tool execute、storage write、snapshot/patch、compaction
- 增加最小集成测试：
  - 单轮多 tool-call（read+grep+apply_patch）确保不会重复执行
  - abort 中断确保所有未完成 tool part 被标记为 error 且无残留 timer

交付物：
- 一套可重复跑的基线测试用例 + 一份 benchmark 输出（本地即可）

### Phase 1：修正执行模型（先正确，再并行）

目标：让系统只有一种工具执行真相来源。

推荐路径（最稳妥）：

- 禁用“在单次 stream 内自动执行工具”的隐式行为
- 改为：LLM 只产出 tool-call（不执行），由 `ToolOrchestrator` 执行并写入 tool-result part
- tool-result 写入后触发下一次 LLM 调用（Continue step），直到 finish reason 不再是 tool-calls 或达到 steps 上限

交付物：
- `processor.ts` 语义变清晰：tool-call 只收集，tool 执行只在 Orchestrator 中发生

### Phase 2：结构拆分（把巨石拆开）

- 把 renderer/orchestrator/retry/snapshot/compaction 拆为独立文件与独立单测
- `SessionProcessor.process()` 仅做 wiring（组装与调度），不写复杂逻辑

交付物：
- `processor.ts` 大幅缩短，逻辑可读、可测、可替换

### Phase 3：性能提升（让优化有闭环）

重点优化点（按收益排序）：

- Storage 写入降频：将 text/reasoning/tool 状态更新做批处理（以事件队列聚合）
- 并行度策略：按 tool 类型/资源键进行分组并行；对 IO 类（read/grep/ls）放大 shared 并行
- 结果缓存闭环：让 `ToolResultCache` 参与 prompt 构建（例如重复 grep/read 直接命中、或用于“推理摘要”）
- 降低 JSON.stringify 热点：避免在 doom-loop 检测里对大输入频繁 stringify

交付物：
- 基准对比：同一 workload 下 wall-clock 时间下降、写入次数下降、TTFT 不变或更好

### Phase 4：Work-Queue 融合（进阶能力，冲“超过 claude code”）

将 `work-queue` 从“示例/实验”升级为执行引擎的一部分：

- 主线程：对用户可见的交互（LLM step + 关键 tool）保持优先级最高
- 后台线程：提交低优先级分析任务（索引、项目结构、依赖图、lint/typecheck 预热）
- 支持任务级取消/超时/重试，且与 SessionStatus/Bus 统一

交付物：
- “前台不断流 + 后台提前算”的体验：用户输入后更快给出下一步，工具调用更少更准

## 6. 验收标准（上线前必须满足）

- 任意工具（尤其 write/apply_patch/bash/edit）在一个 `callID` 下最多执行一次
- 并行执行打开时：同一轮内多个读类工具并发，写类工具互斥，且无死锁/饿死
- abort/cancel 时：不会遗留 pending/running tool part；不会遗留 interval/timeout 计时器
- retry 时：不会重复写 step/patch；状态机在 UI 上可解释
- `processor.ts` 复杂度显著下降：核心逻辑可通过单测覆盖（至少覆盖 tool-call 流程与 abort）

## 7. 下一步（我在代码层面会怎么推进）

在你确认这份计划后，我会按 Phase 0 → Phase 1 → Phase 2 的顺序直接落地到代码，并用仓库现有的 lint/typecheck/test 脚本做回归验证，确保每个阶段都可独立合并/回滚。

---

## 8. 单 Agent 高性能路线：更具体的“实施规范”与验收口径

为确保“更快更稳”，在两段式执行模型的基础上，补充更细的工程规范与落地口径。

### 8.1 两段式执行模型的消息与回灌规范

- 仅在 StepEngine 的“生成阶段”允许产生 tool-call；禁止在同一轮直接执行工具
- 并行执行完成后，构造 `ModelMessage`：
  - `role: "tool"`
  - `content: Array<{ type: "tool-result", toolCallId, toolName, args, output }>`
  - `output` 必须为 `{ type: "content", value: [{ type: "text", text }] }`
- 任何 provider-specific 的 ID/字段规范由 `ProviderTransform.message(...)` 做统一转换（例如 Mistral 的 9 位字母数字 ID）
- 约束：同一 `callID` 在一个 step 中最多产出一个 tool-result；重复执行视为严重错误并拒绝继续

### 8.2 并行度与资源锁：策略与准则

- 锁模式：
  - 读类（read/grep/ls）：`shared`
  - 写类（apply_patch/edit/bash/write）：`exclusive`
- 锁粒度：以“资源键集”（文件路径、目录、外部系统名）为单位；所有键按字典序一致化获取以避免死锁
- 并行度自适应：
  - 滑窗统计 `avg(durationMs)` 与 `errRate`，每 10s 或累计 12 次执行做一次调整
  - 调整规则：`errRate ≥ 25% → 0.7×`；`avg ≥ 2500ms → -1`；`avg ≤ 600ms → +1`；上下限在 `1..maxParallelTools`

### 8.3 写入降频与流控

- Text/Reasoning delta：
  - 聚合 80–140ms 的节流窗口，窗口内合并为一次 `Session.updatePart({ delta })`
  - 回退策略：若外部给定 `deltaThrottleMs`，严格使用外部值
- Tool 状态写入：
  - `pending → running → completed/error` 的状态转移必须在同一任务栈内完成
  - 插入 metadata/title 的更新仅在 `running` 状态生效，避免 pending 阶段的 UI 抖动

### 8.4 Cache 闭环与重复调用抑制

- 在 `ToolResultCache` 记录 `{ sessionID, callID, tool, input, output, attachments }` 并暴露 `getMultiple(sessionID, callIDs)`
- Prompt 构建时：
  - 对已执行过的相同输入的读类工具尝试直接以“数据 part”注入，而非重复执行
  - 对写类工具禁止命中缓存，必须用户明确触发

### 8.5 错误与权限的统一口径

- 权限拒绝（`PermissionNext.RejectedError`）与问题拒绝（`Question.RejectedError`）：
  - 标记 `blocked = true` 并提前结束当前 step
  - UI 层显示拒绝原因，并给出“继续/停止”建议
- Retry：
  - 仅对 API 级可重试错误（网络、限流、5xx）进行指数退避
  - 工具级错误默认不重试（除非工具声明可重试且幂等）

### 8.6 可观测与指标

- Trace：
  - `llm.step`, `tool.execute`, `storage.write`, `snapshot.patch`, `compaction.check`
- 指标：
  - `ttft_ms`（首 token 时间）、
  - `delta_write_ops`（delta 写入次数/秒）、
  - `tool_exec_ms_{p50,p90}`、
  - `error_rate_tool`, `error_rate_llm`
- 日志分级：仅在 error 级别打印异常栈，info 用简要结构化字段

### 8.7 测试矩阵（强制）

- Provider 维度：Anthropic、OpenAI、LiteLLM 代理
- 工具类型：读类（read/grep/ls）、写类（apply_patch/edit/bash）
- 语义场景：
  - 单轮多工具并行（≥3 个读类）
  - 写类工具互斥与并行读类无死锁
  - abort 时无残留 timer 与 pending part
  - 权限拒绝时正确停止且 UI 可解释
  - doom-loop 检测无误报（避免对大 JSON 重复 `stringify`）

### 8.8 风险隔离与回滚

- `experimental.parallel_execution` guard：默认开启；出现回归时可一键关闭回退到串行
- 两段式开关：若 provider/tool 流不兼容，可用 `stripExecute(tools)` 禁用自动执行作为 fallback
- Patch 保护：对写类工具引入“预检查”步骤，先在 snapshot 上验证无冲突再落盘

### 8.9 里程碑与交付物（更细版）

- M0（本周）：两段式模型跑通，串行路径完全正确；基础指标采集
- M1：并行读类工具稳定，无死锁；自适应并发达成目标区间
- M2：写类工具互斥 + 预检查；Cache 闭环接入 prompt
- M3：Work-Queue 融合完成；前后台体验可观测
- M4：性能复盘与调优；对比基准达成“超过 Claude Code”的用户体感指标

### 8.10 TODO 列表（按优先级）

- TODO(Trae): 在 StepEngine 中封装“生成/执行/回灌”三段式 API，完成最小示例
- TODO(Trae): 将 `ToolScheduler` 独立文件化，并引入单元测试覆盖死锁与超时
- TODO(Trae): 提供 `ProviderTransform.message(...)` 的 ID 正常化适配（Mistral/OpenAI）
- TODO(Trae): 增加 `ToolResultCache.getMultiple()` 使用在 prompt 构建路径
- TODO(Trae): 引入指标采集与简单的 Console/JSON 报表导出脚本

---

## 9. 技术选型与库升级建议（不择手段提升效能）

以下建议均按可落地性与收益排序，优先考虑“对现有架构改动小但收益高”的选项。

- 并发控制
  - 内置自适应 limiter 已满足基础需求；如需更强策略，可引入任务级优先队列（最小堆 + aging）替换简单 FIFO
  - 若需进阶调度与跨进程可扩展性：可探索 Redis 驱动的任务队列（如 BullMQ）。本仓库暂不引入外部依赖，建议先在单进程内完成自适应并发闭环
- 代码搜索/批量读工具
  - 在 WSL 环境中直接调用 `ripgrep (rg)` 可显著提升大仓读/搜吞吐（将 grep/read 微批处理聚合成一次外部进程调用）
  - 结合已存在的 `web-tree-sitter`，对结构化语法的检索（如函数/类定义）进行解析后再过滤，减少 LLM 输入 Token
- Provider 路由（多模型选择）
  - 引入“模型级路由策略”：对纯文本生成与纯工具调用预判使用更低时延/成本的模型，复杂推理再回到主力模型
  - 按历史 `ttft_ms`/吞吐成本矩阵做决策（本地记录即可，无需新库）
- Snapshot/Patch 加速
  - 利用 `@parcel/watcher` 的增量事件，避免每步都全量 diff；按变更路径构建 patch，降低 IO 压力
- 度量与观测
  - 迁移现有日志到结构化 JSON 输出（便于离线分析）；无需新库，仅调整输出格式

## 10. 算法优化与调度策略（工程可落地版）

- DAG 拓扑调度
  - 基于工具依赖图（已有 `ToolDependency.analyze`），对无依赖的节点做并行；对共享资源键采用读写锁策略，实现“读最大化、写安全化”
- 微批处理
  - 将“多次相同类型读/搜”合并为一次调用（例如合并 10 次 grep 为 1 次 rg 并在内存中拆分结果），节省进程/IO 开销
- 动态并行度
  - 通过滑窗（近 N 次执行）统计 `avg/p95` 时延与错误率，按规则调整并发（见 8.2）；对写类工具在高错误期降并发或序列化
- Prompt 体积优化
  - 将工具结果在构建消息时做“附件优先文本摘要”，尽量减少 Token 使用；附件走 data URL，仅在需要时使用

## 11. 成本/时延模型与 Provider 选择

- 记录每次 step 的 `ttft_ms`、`tokens_in/out`、`cost`，形成简单的经验矩阵
- 路由策略（示例）：
  - 仅产生工具调用、无文本生成 → 选择更便宜、稳定的模型
  - 需要复杂文本输出或代码生成 → 回到主力模型（按历史 TTFT 与成功率）
  - 失败重试 → 优先替代同一厂商的相近模型以降低协议差异带来的不确定性

## 12. 实施路径（工程化落地顺序）

- 第一步：完成两段式闭环并引入微批处理（不引入新库）
- 第二步：在 WSL 环境引入 `ripgrep` 作为底层加速（工具层可选使用，逐步迁移）
- 第三步：完善路由策略与度量采集，形成成本/时延矩阵
- 第四步：若单进程达到瓶颈，再评估引入 Redis 队列以承载后台任务与跨进程扩展

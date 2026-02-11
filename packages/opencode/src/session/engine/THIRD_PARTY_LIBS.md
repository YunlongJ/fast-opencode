# 第三方库推荐 - 工具优化模块

## 概述

目前我们自行实现了以下功能，但可以使用成熟的第三方库来替代，减少维护成本。

## 推荐的第三方库

### 1. LRU/LFU 缓存

**当前实现**: `smart-cache.ts` 中的 `SmartCache` 类

**推荐库**:

- [`lru-cache`](https://www.npmjs.com/package/lru-cache) - 最流行的 LRU 缓存库
  - 优点：成熟稳定，功能丰富，支持 TTL、大小限制等
  - 安装：`bun add lru-cache`
  - 替代程度：可直接替换

- [`quick-lru`](https://www.npmjs.com/package/quick-lru) - 更快的 LRU 实现
  - 优点：性能更好，Map 实现
  - 适合：需要极致性能的场景

**使用示例**:

```typescript
import { LRUCache } from "lru-cache"

const cache = new LRUCache<string, any>({
  max: 1000, // 最大条目数
  maxSize: 100 * 1024 * 1024, // 最大内存
  sizeCalculation: (value) => JSON.stringify(value).length,
  ttl: 1000 * 60 * 60, // 1小时TTL
  updateAgeOnGet: true, // 访问时更新TTL
  allowStale: false, // 不返回过期数据
})
```

---

### 2. 并发控制

**当前实现**: `concurrency-controller.ts` 中的 `EnhancedConcurrencyController`

**推荐库**:

- [`p-limit`](https://www.npmjs.com/package/p-limit) - 限制并发数
  - 优点：简单轻量，Promise 友好
  - 安装：`bun add p-limit`

- [`p-queue`](https://www.npmjs.com/package/p-queue) - 优先级队列
  - 优点：支持优先级、并发控制、自动重试
  - 适合：需要复杂队列管理的场景

- [`async-sema`](https://www.npmjs.com/package/async-sema) - 信号量实现
  - 优点：轻量级，支持公平调度

**使用示例**:

```typescript
import pLimit from "p-limit"
import PQueue from "p-queue"

// 简单并发限制
const limit = pLimit(10)
const results = await Promise.all(tasks.map((task) => limit(() => executeTask(task))))

// 优先级队列
const queue = new PQueue({
  concurrency: 10,
  autoStart: true,
})

queue.add(() => task1(), { priority: 1 })
queue.add(() => task2(), { priority: 0 }) // 高优先级
```

---

### 3. 批处理

**当前实现**: `smart-batch.ts` 中的 `SmartBatchProcessor`

**推荐库**:

- [`p-map`](https://www.npmjs.com/package/p-map) - 批量执行
  - 优点：支持并发控制，错误处理
  - 安装：`bun add p-map`

- [`p-all`](https://www.npmjs.com/package/p-all) - 批量执行并返回所有结果

**使用示例**:

```typescript
import pMap from "p-map"

const results = await pMap(
  executors,
  async (executor) => {
    return executeTool(executor)
  },
  { concurrency: 10 },
)
```

---

### 4. 重试机制

**当前实现**: `concurrency-controller.ts` 中的重试逻辑

**推荐库**:

- [`p-retry`](https://www.npmjs.com/package/p-retry) - 智能重试
  - 优点：指数退避、自定义重试条件
  - 安装：`bun add p-retry`

- [`async-retry`](https://www.npmjs.com/package/async-retry) - 更灵活的重试

**使用示例**:

```typescript
import pRetry from "p-retry"

const result = await pRetry(() => fetchData(), {
  retries: 3,
  factor: 2, // 指数退避因子
  minTimeout: 1000, // 最小等待1秒
  maxTimeout: 10000, // 最大等待10秒
  onFailedAttempt: (error) => {
    console.log(`Attempt ${error.attemptNumber} failed`)
  },
})
```

---

### 5. 超时控制

**当前实现**: `utils.ts` 中的 `withTimeout`

**推荐库**:

- [`p-timeout`](https://www.npmjs.com/package/p-timeout) - Promise 超时
  - 优点：支持自定义错误消息、清理函数
  - 安装：`bun add p-timeout`

**使用示例**:

```typescript
import pTimeout from "p-timeout"

const result = await pTimeout(fetchData(), {
  milliseconds: 5000,
  message: "Request timed out",
  fallback: () => defaultValue,
})
```

---

### 6. 防抖/节流

**当前实现**: 无

**推荐库**:

- [`lodash.debounce`](https://www.npmjs.com/package/lodash.debounce) / [`lodash.throttle`](https://www.npmjs.com/package/lodash.throttle)
- [`p-debounce`](https://www.npmjs.com/package/p-debounce) - Promise 友好的防抖

---

### 7. 事件发射器（用于监控）

**当前实现**: 无

**推荐库**:

- [`mitt`](https://www.npmjs.com/package/mitt) - 轻量级事件发射器
  - 优点：极小体积（200 bytes），TypeScript 友好
  - 安装：`bun add mitt`

**使用示例**:

```typescript
import mitt from "mitt"

const emitter = mitt<{
  "tool:execute": { toolName: string; duration: number }
  "tool:error": { toolName: string; error: Error }
}>()

emitter.on("tool:execute", (data) => {
  console.log(`${data.toolName} took ${data.duration}ms`)
})
```

---

## 推荐的库组合方案

### 轻量级方案

```bash
bun add lru-cache p-limit p-retry p-timeout
```

### 完整方案

```bash
bun add lru-cache p-queue p-retry p-timeout p-map mitt
```

---

## 迁移建议

### 阶段1：替换缓存（低风险）

1. 安装 `lru-cache`
2. 替换 `SmartCache` 类
3. 保持相同的 API 接口

### 阶段2：替换并发控制（中风险）

1. 安装 `p-queue`
2. 逐步替换 `EnhancedConcurrencyController`
3. 注意：需要保持优先级调度功能

### 阶段3：替换批处理（低风险）

1. 安装 `p-map`
2. 替换批处理逻辑

### 阶段4：增强功能（可选）

1. 添加 `p-retry` 统一重试逻辑
2. 添加 `mitt` 实现事件监控

---

## 不使用第三方库的理由

当前自行实现也有其优势：

1. **完全控制**: 可以根据具体需求定制
2. **无依赖**: 减少依赖树大小
3. **学习价值**: 深入理解算法实现
4. **性能调优**: 针对特定场景优化

建议：

- 如果团队有足够维护能力，可以保持自研
- 如果需要快速迭代，建议使用成熟库
- 可以混合使用：核心逻辑自研，通用功能用库

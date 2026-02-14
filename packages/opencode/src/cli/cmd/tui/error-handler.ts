import { Log } from "@/util/log"

const logger = Log.create({ component: "TUI" })

/**
 * 全局错误处理器 - 捕获所有未处理的错误并记录到 pino 日志
 */
export function setupGlobalErrorHandlers() {
  // 捕获未处理的 Promise 拒绝
  process.on("unhandledRejection", (reason, promise) => {
    logger.error({
      type: "unhandledRejection",
      reason: reason instanceof Error ? {
        message: reason.message,
        stack: reason.stack,
        name: reason.name,
      } : String(reason),
    }, "Unhandled Promise Rejection")
    
    // 继续抛出，让 ErrorBoundary 或其他处理器处理
    throw reason
  })

  // 捕获未捕获的异常
  process.on("uncaughtException", (error) => {
    logger.error({
      type: "uncaughtException",
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    }, "Uncaught Exception")
    
    // 给日志写入一点时间，然后退出
    setTimeout(() => {
      process.exit(1)
    }, 100)
  })

  // 捕获警告
  process.on("warning", (warning) => {
    logger.warn({
      type: "warning",
      warning: {
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      },
    }, "Process Warning")
  })
}

/**
 * 包装组件错误边界回调
 */
export function logErrorBoundary(error: Error, errorInfo?: string) {
  logger.error({
    type: "errorBoundary",
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    errorInfo,
  }, "React/Solid Error Boundary Caught Error")
}

/**
 * 包装渲染错误
 */
export function logRenderError(error: Error, componentName?: string) {
  logger.error({
    type: "renderError",
    componentName,
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
  }, "Component Render Error")
}

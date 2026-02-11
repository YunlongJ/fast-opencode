import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import pino, { type Logger as PinoLogger } from "pino"
import os from "os"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  /** 敏感信息脱敏配置 */
  const REDACT_KEYS = [
    "token",
    "key",
    "secret",
    "password",
    "authorization",
    "apiKey",
    "set-cookie",
    "cookie",
    "access_token",
    "refresh_token",
  ]

  let currentLevel: Level = "INFO"
  
  /** 
   * 暴露 Pino 原生 Logger 类型
   * 默认级别设为 silent，直到 init 被调用
   */
  export let Default: PinoLogger = createRootLogger({ level: "silent" })
  let rootDestination: pino.DestinationStream | undefined

  function createRootLogger(options: pino.LoggerOptions, destination?: pino.DestinationStream): PinoLogger {
    const isProd = process.env.NODE_ENV === "production" || !process.env.DEV
    return pino({
      // 生产环境保留 pid 和 hostname，方便在多实例/容器环境中追踪
      base: isProd ? { pid: process.pid, hostname: os.hostname() } : undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        // 增加对请求和响应的序列化支持，防止打印大对象
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
      },
      redact: {
        paths: REDACT_KEYS,
        censor: "***",
      },
      ...options,
    }, destination)
  }

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
    /** 是否开启异步写入（生产环境建议开启以提升性能） */
    async?: boolean
  }

  let logpath = ""
  export function file() {
    return logpath
  }

  let exitHandlerRegistered = false
  export async function init(options: Options) {
    if (options.level) currentLevel = options.level
    
    const pinoLevel = currentLevel.toLowerCase()
    
    if (options.print) {
      Default = createRootLogger({
        level: pinoLevel,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "SYS:standard",
          }
        }
      })
    } else {
      const logDir = Global.Path.log
      if (!(await fs.stat(logDir).catch(() => null))) {
        await fs.mkdir(logDir, { recursive: true })
      }
      logpath = path.join(
        logDir,
        options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
      )
      // 如果 options.async 为 true，则开启异步写入，提高吞吐量
      rootDestination = pino.destination({ dest: logpath, sync: !options.async })
      Default = createRootLogger(
        { level: pinoLevel },
        rootDestination
      )

      // 在设置好 logpath 并初始化好目录后再执行清理，避免误删当前文件或目录不存在报错
      await cleanup(logDir)
    }

    // 进程退出时确保日志刷入磁盘（确保只注册一次）
    if (!exitHandlerRegistered) {
      const flush = () => {
        Default.flush()
        if (rootDestination && "end" in rootDestination) {
          (rootDestination as any).end()
        }
      }
      process.on("exit", flush)
      process.on("SIGINT", () => {
        flush()
        process.exit(0)
      })
      process.on("SIGTERM", () => {
        flush()
        process.exit(0)
      })
      exitHandlerRegistered = true
    }
  }

  async function cleanup(dir: string) {
    const MAX_FILES = 30
    const MAX_AGE_DAYS = 7
    const msPerDay = 24 * 60 * 60 * 1000
    const now = Date.now()

    try {
      const glob = new Bun.Glob("*.log")
      const matches = await Array.fromAsync(
        glob.scan({
          cwd: dir,
          absolute: true,
        }),
      )

      if (matches.length === 0) return

      // 标准化当前日志路径，用于 Windows 下的准确对比
      const normalizedLogPath = path.resolve(logpath)

      // 获取文件详情并过滤掉当前正在使用的日志
      const files = await Promise.all(
        matches
          .filter((file) => path.resolve(file) !== normalizedLogPath)
          .map(async (file) => {
            const stats = await fs.stat(file).catch(() => null)
            return { file, mtime: stats?.mtimeMs ?? 0 }
          }),
      )

      // 1. 按时间清理（删除超过 MAX_AGE_DAYS 的文件）
      const expiredFiles = files.filter((f) => now - f.mtime > MAX_AGE_DAYS * msPerDay)
      for (const f of expiredFiles) {
        await fs.unlink(f.file).catch(() => {})
      }

      // 2. 按数量清理（保留最近的 MAX_FILES 个文件）
      const remainingFiles = files
        .filter((f) => now - f.mtime <= MAX_AGE_DAYS * msPerDay)
        .sort((a, b) => b.mtime - a.mtime)

      if (remainingFiles.length > MAX_FILES) {
        const toDelete = remainingFiles.slice(MAX_FILES)
        for (const f of toDelete) {
          await fs.unlink(f.file).catch(() => {})
        }
      }
    } catch (e) {
      // 生产环境建议至少记录到 stderr
      console.error("Failed to cleanup logs:", e)
    }
  }

  type Logger = PinoLogger & {
    time: (msg: string, metadata?: any) => { stop: () => void } & Disposable
    clone: () => Logger
    tag: (key: string, value: any) => Logger
  }

  /** 兼容旧的 create 接口，但直接返回 Pino child logger */
  export function create(tags?: Record<string, any>): Logger {
    // 使用 Proxy 包装 child logger，确保如果 Default 在 init 后被替换，已创建的 logger 依然有效
    // 实际上，更简单的方法是让 create 总是基于当前的 Default
    const getTarget = () => Default.child(tags || {}) as any

    const logger = getTarget()

    logger.time = (msg: string, metadata?: any) => {
      const start = performance.now()
      const stop = () => {
        const duration = performance.now() - start
        // 总是获取最新的 Default 发送日志
        const currentLogger = tags ? Default.child(tags) : Default
        currentLogger.info({ ...metadata, duration: `${duration.toFixed(2)}ms` }, msg)
      }
      return {
        stop,
        [Symbol.dispose]: stop,
      }
    }

    logger.clone = () => {
      return create(tags)
    }

    logger.tag = (key: string, value: any) => {
      return create({ ...tags, [key]: value })
    }

    // 关键：为了处理 Default 被重新赋值的情况（init 调用后）
    // 我们返回一个代理对象，它的大部分方法都会委托给最新的 Default.child(tags)
    return new Proxy(logger, {
      get(target, prop, receiver) {
        // 如果是特殊扩展的方法，直接返回
        if (prop === "time" || prop === "clone" || prop === "tag") {
          return target[prop]
        }
        // 对于标准 pino 方法（info, error 等），确保使用最新的 Default
        const currentDefault = Default
        if (typeof (currentDefault as any)[prop] === "function") {
          const currentChild = currentDefault.child(tags || {})
          const val = (currentChild as any)[prop]
          if (typeof val === "function") {
            return val.bind(currentChild)
          }
          return val
        }
        return Reflect.get(target, prop, receiver)
      }
    })
  }

  /** 兼容旧的 time 接口 */
  export function time(logger: PinoLogger, message: string, extra?: Record<string, any>) {
    const now = Date.now()
    logger.info(extra || {}, `${message} (started)`)
    const stop = () => {
      logger.info({
        ...extra,
        duration: Date.now() - now,
      }, `${message} (completed)`)
    }
    return {
      stop,
      [Symbol.dispose]: stop,
    }
  }
}

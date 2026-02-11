import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import pino, { type Logger as PinoLogger } from "pino"
import pretty from "pino-pretty"
import os from "os"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  /** 敏感信息脱敏配置 */
  const REDACT_KEYS = [
    "token", "**.token",
    "key", "**.key",
    "secret", "**.secret",
    "password", "**.password",
    "pass", "**.pass",
    "authorization", "**.authorization",
    "apiKey", "**.apiKey",
    "access_token", "**.access_token",
    "refresh_token", "**.refresh_token",
    "cookie", "**.cookie",
    "set-cookie", "**.set-cookie",
    "credentials", "**.credentials",
    "private_key", "**.private_key",
    "cert", "**.cert",
  ]

  let currentLevel: Level = "INFO"
  
  /** 
   * 默认级别设为 silent，直到 init 被调用
   */
  let rootLogger: PinoLogger = pino({ level: "silent" })
  let rootDestination: any | undefined

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
    
    // 初始化日志目录
    const logDir = Global.Path.log
    try {
      if (!(await fs.stat(logDir).catch(() => null))) {
        await fs.mkdir(logDir, { recursive: true })
      }
    } catch (e) {
      console.error("Failed to create log directory:", e)
    }

    const now = new Date()
    const timestamp = options.dev 
      ? "dev" 
      : `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}-${now.getHours().toString().padStart(2, "0")}`
    
    logpath = path.join(logDir, `${timestamp}.log`)

    // 如果已经存在旧的 destination，先关闭它
    if (rootDestination && typeof rootDestination.end === "function") {
      rootDestination.end()
    }

    // 如果 options.async 为 true，则开启异步写入，提高吞吐量
    rootDestination = pino.destination({ dest: logpath, sync: !options.async })
    
    const streams: pino.StreamEntry[] = [
      // 所有日志都写入文件
      { stream: rootDestination, level: pinoLevel as pino.Level },
    ]

    // 只有在明确要求打印日志时，才添加终端输出流
    if (options.print) {
      streams.push({
        stream: pretty({
          destination: process.stderr,
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "SYS:standard",
        }),
        level: pinoLevel as pino.Level,
      })
    }

    // 创建全局 Logger，使用 multistream 确保多路输出
    rootLogger = pino(
      {
        base: (process.env.NODE_ENV === "production" || !process.env.DEV) ? { pid: process.pid, hostname: os.hostname() } : undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: {
          err: pino.stdSerializers.err,
          error: pino.stdSerializers.err,
          req: pino.stdSerializers.req,
          res: pino.stdSerializers.res,
        },
        redact: {
          paths: REDACT_KEYS,
          censor: "***",
        },
        level: pinoLevel,
      },
      pino.multistream(streams)
    )

    // 在设置好 logpath 并初始化好目录后再执行清理，避免误删当前文件或目录不存在报错
    await cleanup(logDir)

    // 进程退出时确保日志刷入磁盘（确保只注册一次）
    if (!exitHandlerRegistered) {
      const flush = () => {
        // 使用 flushSync 确保在退出前同步写入磁盘
        if (rootDestination && "flushSync" in rootDestination) {
          (rootDestination as any).flushSync()
        }
        if (rootDestination && "end" in rootDestination) {
          (rootDestination as any).end()
        }
      }
      
      process.on("exit", flush)
      
      // 捕捉中断信号，手动调用 exit 触发 exit 事件
      const handleSignal = () => {
        flush()
        process.exit(0)
      }
      
      process.on("SIGINT", handleSignal)
      process.on("SIGTERM", handleSignal)
      
      exitHandlerRegistered = true
    }
  }

  async function cleanup(dir: string) {
    const MAX_FILES = 30
    const MAX_AGE_DAYS = 7
    const msPerDay = 24 * 60 * 60 * 1000
    const now = Date.now()

    if (!logpath) return

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
          .filter((file) => {
            try {
              return path.resolve(file) !== normalizedLogPath
            } catch {
              return false
            }
          })
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

  export type Logger = PinoLogger & {
    time: (msg: string, metadata?: any) => { stop: () => void } & Disposable
    clone: () => Logger
    tag: (key: string, value: any) => Logger
    error: { (msg: string, obj?: any): void } & PinoLogger['error']
    warn: { (msg: string, obj?: any): void } & PinoLogger['warn']
    info: { (msg: string, obj?: any): void } & PinoLogger['info']
    debug: { (msg: string, obj?: any): void } & PinoLogger['debug']
  }

  function wrap(getLogger: () => PinoLogger, tags?: Record<string, any>): Logger {
    const time = (msg: string, metadata?: any) => {
      const start = performance.now()
      const stop = () => {
        const duration = performance.now() - start
        const activeLogger = getLogger()
        activeLogger.info({ ...metadata, duration: `${duration.toFixed(2)}ms` }, msg)
      }
      return {
        stop,
        [Symbol.dispose]: stop,
      }
    }

    const wrapMethod = (method: string) => {
      return (msgOrObj: any, objOrMsg?: any, ...args: any[]) => {
        const logger = getLogger()
        if (typeof msgOrObj === "string") {
          if (objOrMsg !== undefined) {
            return (logger as any)[method](objOrMsg, msgOrObj, ...args)
          }
          return (logger as any)[method](msgOrObj, ...args)
        }
        return (logger as any)[method](msgOrObj, objOrMsg, ...args)
      }
    }

    return new Proxy({} as any, {
      get(target, prop, receiver) {
        if (prop === "time") return time
        if (prop === "clone") return () => wrap(getLogger, tags)
        if (prop === "tag") return (key: string, value: any) => wrap(getLogger, { ...tags, [key]: value })
        if (["error", "warn", "info", "debug"].includes(prop as string)) {
          return wrapMethod(prop as string)
        }

        const activeLogger = getLogger()
        const val = (activeLogger as any)[prop]
        if (typeof val === "function") {
          return val.bind(activeLogger)
        }
        return val
      },
    }) as Logger
  }

  export const Default: Logger = wrap(() => rootLogger)

  /** 兼容旧的 create 接口，但直接返回 Pino child logger */
  export function create(tags?: Record<string, any>): Logger {
    let currentParent: PinoLogger | undefined
    let cachedChild: PinoLogger

    const getLogger = () => {
      if (rootLogger !== currentParent) {
        currentParent = rootLogger
        cachedChild = currentParent.child(tags || {})
      }
      return cachedChild!
    }

    return wrap(getLogger, tags)
  }

  /** 兼容旧的 time 接口 */
  export function time(logger: PinoLogger, message: string, extra?: Record<string, any>) {
    const start = performance.now()
    logger.info(extra || {}, `${message} (started)`)
    const stop = () => {
      logger.info({
        ...extra,
        duration: `${(performance.now() - start).toFixed(2)}ms`,
      }, `${message} (completed)`)
    }
    return {
      stop,
      [Symbol.dispose]: stop,
    }
  }
}

/**
 * @fileoverview 性能监控与分析系统
 * @responsibility 监控工具调用性能，提供优化建议
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "performance-monitor" })

/**
 * 性能指标
 */
interface PerformanceMetrics {
  toolName: string
  callCount: number
  totalDuration: number
  avgDuration: number
  minDuration: number
  maxDuration: number
  cacheHitRate: number
  errorRate: number
}

/**
 * 会话性能报告
 */
interface SessionPerformanceReport {
  sessionID: string
  totalCalls: number
  totalDuration: number
  avgCallDuration: number
  toolBreakdown: PerformanceMetrics[]
  bottlenecks: string[]
  recommendations: string[]
}

/**
 * 性能监控器
 */
export class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetrics> = new Map()
  private sessionStartTime: number = Date.now()
  private sessionID: string = ""
  private cacheHits = 0
  private cacheMisses = 0
  private errors = 0

  /**
   * 开始会话监控
   */
  startSession(sessionID: string): void {
    this.sessionID = sessionID
    this.sessionStartTime = Date.now()
    this.metrics.clear()
    this.cacheHits = 0
    this.cacheMisses = 0
    this.errors = 0
  }

  /**
   * 记录工具调用
   */
  recordCall(toolName: string, duration: number, cached: boolean, error: boolean): void {
    // 更新缓存统计
    if (cached) {
      this.cacheHits++
    } else {
      this.cacheMisses++
    }

    if (error) {
      this.errors++
    }

    // 更新工具指标
    let metric = this.metrics.get(toolName)
    if (!metric) {
      metric = {
        toolName,
        callCount: 0,
        totalDuration: 0,
        avgDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
        cacheHitRate: 0,
        errorRate: 0,
      }
      this.metrics.set(toolName, metric)
    }

    metric.callCount++
    metric.totalDuration += duration
    metric.avgDuration = metric.totalDuration / metric.callCount
    metric.minDuration = Math.min(metric.minDuration, duration)
    metric.maxDuration = Math.max(metric.maxDuration, duration)
  }

  /**
   * 生成性能报告
   */
  generateReport(): SessionPerformanceReport {
    const totalCalls = Array.from(this.metrics.values()).reduce((sum, m) => sum + m.callCount, 0)
    const totalDuration = Date.now() - this.sessionStartTime
    const avgCallDuration =
      totalCalls > 0 ? Array.from(this.metrics.values()).reduce((sum, m) => sum + m.totalDuration, 0) / totalCalls : 0

    // 计算缓存命中率和错误率
    const totalCache = this.cacheHits + this.cacheMisses
    const cacheHitRate = totalCache > 0 ? this.cacheHits / totalCache : 0
    const errorRate = totalCalls > 0 ? this.errors / totalCalls : 0

    // 更新每个指标的缓存命中率和错误率
    for (const metric of this.metrics.values()) {
      metric.cacheHitRate = cacheHitRate
      metric.errorRate = errorRate
    }

    // 识别瓶颈
    const bottlenecks = this.identifyBottlenecks()

    // 生成建议
    const recommendations = this.generateRecommendations()

    return {
      sessionID: this.sessionID,
      totalCalls,
      totalDuration,
      avgCallDuration,
      toolBreakdown: Array.from(this.metrics.values()).sort((a, b) => b.totalDuration - a.totalDuration),
      bottlenecks,
      recommendations,
    }
  }

  /**
   * 识别性能瓶颈
   */
  private identifyBottlenecks(): string[] {
    const bottlenecks: string[] = []
    const sorted = Array.from(this.metrics.values()).sort((a, b) => b.totalDuration - a.totalDuration)

    // 找出耗时最长的工具
    if (sorted.length > 0 && sorted[0].totalDuration > 5000) {
      bottlenecks.push(`Slow tool: ${sorted[0].toolName} (${sorted[0].avgDuration.toFixed(0)}ms avg)`)
    }

    // 找出错误率高的工具
    const highErrorTools = sorted.filter((m) => m.errorRate > 0.1)
    if (highErrorTools.length > 0) {
      bottlenecks.push(`High error rate: ${highErrorTools.map((t) => t.toolName).join(", ")}`)
    }

    // 找出缓存命中率低的工具
    if (this.cacheHits + this.cacheMisses > 10 && this.cacheHits / (this.cacheHits + this.cacheMisses) < 0.3) {
      bottlenecks.push("Low cache hit rate - consider increasing cache size")
    }

    return bottlenecks
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(): string[] {
    const recommendations: string[] = []

    // 基于调用模式的建议
    const readCalls = this.metrics.get("read")
    if (readCalls && readCalls.callCount > 10) {
      recommendations.push("Consider using read_multiple for batch file reads")
    }

    // 基于缓存的建议
    if (this.cacheMisses > this.cacheHits * 2) {
      recommendations.push("Increase cache TTL or size to improve hit rate")
    }

    // 基于错误率的建议
    if (this.errors > 5) {
      recommendations.push("Review error patterns and add retry logic")
    }

    return recommendations
  }

  /**
   * 获取实时统计
   */
  getRealtimeStats(): {
    totalCalls: number
    avgDuration: number
    cacheHitRate: number
    errorRate: number
  } {
    const totalCalls = Array.from(this.metrics.values()).reduce((sum, m) => sum + m.callCount, 0)
    const totalDuration = Array.from(this.metrics.values()).reduce((sum, m) => sum + m.totalDuration, 0)
    const totalCache = this.cacheHits + this.cacheMisses

    return {
      totalCalls,
      avgDuration: totalCalls > 0 ? totalDuration / totalCalls : 0,
      cacheHitRate: totalCache > 0 ? this.cacheHits / totalCache : 0,
      errorRate: totalCalls > 0 ? this.errors / totalCalls : 0,
    }
  }

  /**
   * 导出报告
   */
  exportReport(): string {
    const report = this.generateReport()
    return JSON.stringify(report, null, 2)
  }
}

/**
 * 全局性能监控实例
 */
export const performanceMonitor = new PerformanceMonitor()

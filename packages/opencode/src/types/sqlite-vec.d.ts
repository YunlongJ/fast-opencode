/**
 * sqlite-vec 类型声明
 */
declare module "sqlite-vec" {
  import type { Database } from "bun:sqlite"

  /**
   * 加载 sqlite-vec 扩展到数据库
   */
  export function load(db: Database): void

  /**
   * 获取 sqlite-vec 版本
   */
  export function vec_version(): string

  /**
   * 计算向量长度
   */
  export function vec_length(vector: Float32Array): number

  /**
   * 计算向量距离
   */
  export function vec_distance(vector1: Float32Array, vector2: Float32Array): number

  /**
   * 量化向量
   */
  export function vec_quantize(vector: Float32Array, bits: number): Float32Array

  /**
   * 序列化向量
   */
  export function vec_serialize(vector: Float32Array): Uint8Array

  /**
   * 反序列化向量
   */
  export function vec_deserialize(data: Uint8Array): Float32Array
}

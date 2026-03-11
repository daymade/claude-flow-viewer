import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FeatureExtractionPipelineType } from '@xenova/transformers'

import type { SearchChunkRecord } from '../../src/lib/search'

const SEARCH_HOME_DIR = path.join(os.homedir(), '.claude-flow-viewer')
const DEFAULT_MODEL_ID = process.env.SEARCH_EMBED_MODEL_ID || 'Xenova/multilingual-e5-small'
const DEFAULT_CACHE_DIR = process.env.SEARCH_EMBED_CACHE_DIR || path.join(SEARCH_HOME_DIR, 'model-cache')
const DEFAULT_LOCAL_MODEL_PATH = process.env.SEARCH_EMBED_LOCAL_MODEL_PATH || path.join(SEARCH_HOME_DIR, 'models')
const DEFAULT_BATCH_SIZE = Math.max(1, Number(process.env.SEARCH_EMBED_BATCH_SIZE || 4))

export interface SearchEmbeddingProvider {
  readonly name: string
  readonly modelId: string
  readonly cacheDir: string
  readonly localModelPath: string
  embedQuery(query: string): Promise<Float32Array>
  embedChunks(chunks: SearchChunkRecord[]): Promise<Map<string, Float32Array>>
}

export interface TransformersEmbeddingProviderOptions {
  modelId?: string
  cacheDir?: string
  localModelPath?: string
  allowRemoteModels?: boolean
  batchSize?: number
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function toFloat32Array(values: number[]): Float32Array {
  return Float32Array.from(values)
}

function toEmbeddingRows(value: unknown): number[][] {
  if (!Array.isArray(value)) return []
  if (value.length === 0) return []
  if (typeof value[0] === 'number') {
    return [value as number[]]
  }
  return value as number[][]
}

export class TransformersEmbeddingProvider implements SearchEmbeddingProvider {
  readonly name = 'transformers-feature-extraction'
  readonly modelId: string
  readonly cacheDir: string
  readonly localModelPath: string
  private readonly allowRemoteModels: boolean
  private readonly batchSize: number
  private extractorPromise: Promise<FeatureExtractionPipelineType> | null = null

  constructor(options: TransformersEmbeddingProviderOptions = {}) {
    this.modelId = options.modelId || DEFAULT_MODEL_ID
    this.cacheDir = options.cacheDir || DEFAULT_CACHE_DIR
    this.localModelPath = options.localModelPath || DEFAULT_LOCAL_MODEL_PATH
    this.allowRemoteModels = options.allowRemoteModels ?? process.env.SEARCH_EMBED_ALLOW_REMOTE !== '0'
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)

    ensureDir(this.cacheDir)
    ensureDir(this.localModelPath)
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const rows = await this.embedTexts([`query: ${query}`])
    return rows[0] ?? new Float32Array()
  }

  async embedChunks(chunks: SearchChunkRecord[]): Promise<Map<string, Float32Array>> {
    if (chunks.length === 0) return new Map()

    const rows = await this.embedTexts(chunks.map((chunk) => `passage: ${chunk.text}`))
    return new Map(chunks.map((chunk, index) => [chunk.id, rows[index] ?? new Float32Array()]))
  }

  private async getExtractor(): Promise<FeatureExtractionPipelineType> {
    if (!this.extractorPromise) {
      this.extractorPromise = this.createExtractor()
    }
    return this.extractorPromise
  }

  private async createExtractor(): Promise<FeatureExtractionPipelineType> {
    const { env, pipeline } = await import('@xenova/transformers')

    env.useFS = true
    env.useFSCache = true
    env.allowLocalModels = true
    env.allowRemoteModels = this.allowRemoteModels
    env.cacheDir = this.cacheDir
    env.localModelPath = this.localModelPath

    return pipeline('feature-extraction', this.modelId)
  }

  private async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    const extractor = await this.getExtractor()
    const rows: Float32Array[] = []

    for (let index = 0; index < texts.length; index += this.batchSize) {
      const batch = texts.slice(index, index + this.batchSize)
      const tensor = await extractor(batch, {
        pooling: 'mean',
        normalize: true,
      })
      rows.push(...toEmbeddingRows(tensor.tolist()).map(toFloat32Array))
    }

    return rows
  }
}

export function createTransformersEmbeddingProvider(
  options: TransformersEmbeddingProviderOptions = {},
): SearchEmbeddingProvider {
  return new TransformersEmbeddingProvider(options)
}

export function createDefaultEmbeddingProvider(): SearchEmbeddingProvider | null {
  if (process.env.NODE_ENV === 'test' || process.env.SEARCH_EMBED_DISABLE === '1') {
    return null
  }
  return createTransformersEmbeddingProvider()
}

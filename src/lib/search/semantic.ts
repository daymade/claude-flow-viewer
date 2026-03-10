import type { SearchChunkRecord, SemanticSearchContext, SemanticSearchProvider } from './types'

type Neighbor = {
  token: string
  weight: number
}

const MAX_TOKENS_PER_CHUNK = 24
const MAX_NEIGHBORS_PER_TOKEN = 12

function roundWeight(value: number): number {
  return Number(value.toFixed(4))
}

function topNeighbors(weights: Map<string, number>): Neighbor[] {
  return [...weights.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_NEIGHBORS_PER_TOKEN)
    .map(([token, weight]) => ({ token, weight: roundWeight(weight) }))
}

export class CooccurrenceSemanticProvider implements SemanticSearchProvider {
  name = 'cooccurrence'

  private readonly neighbors: Map<string, Neighbor[]>

  constructor(chunks: SearchChunkRecord[]) {
    const weights = new Map<string, Map<string, number>>()

    for (const chunk of chunks) {
      const uniqueTokens = [...new Set(chunk.tokens)].slice(0, MAX_TOKENS_PER_CHUNK)
      if (uniqueTokens.length < 2) continue

      const proximityWeight = 1 / Math.log(uniqueTokens.length + 2)
      for (let leftIndex = 0; leftIndex < uniqueTokens.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < uniqueTokens.length; rightIndex += 1) {
          const left = uniqueTokens[leftIndex]
          const right = uniqueTokens[rightIndex]
          if (left === right) continue

          const leftMap = weights.get(left) ?? new Map<string, number>()
          leftMap.set(right, (leftMap.get(right) ?? 0) + proximityWeight)
          weights.set(left, leftMap)

          const rightMap = weights.get(right) ?? new Map<string, number>()
          rightMap.set(left, (rightMap.get(left) ?? 0) + proximityWeight)
          weights.set(right, rightMap)
        }
      }
    }

    this.neighbors = new Map<string, Neighbor[]>()
    for (const [token, relatedWeights] of weights) {
      const top = topNeighbors(relatedWeights)
      if (top.length > 0) {
        this.neighbors.set(token, top)
      }
    }
  }

  expandQuery(context: SemanticSearchContext): string[] {
    const expanded = new Set<string>()

    for (const token of context.queryTokens) {
      const neighbors = this.neighbors.get(token)
      if (!neighbors) continue

      for (const neighbor of neighbors) {
        if (neighbor.weight < 0.15) continue
        if (!context.queryTokens.includes(neighbor.token)) {
          expanded.add(neighbor.token)
        }
      }
    }

    return [...expanded]
  }

  score(chunk: SearchChunkRecord, context: SemanticSearchContext): number {
    if (context.queryTokens.length === 0 || chunk.tokens.length === 0) return 0

    const chunkTokenSet = new Set(chunk.tokens)
    let matchedWeight = 0
    let maxWeight = 0

    for (const token of context.queryTokens) {
      const neighbors = this.neighbors.get(token)
      if (!neighbors) continue

      for (const neighbor of neighbors) {
        if (context.queryTokens.includes(neighbor.token)) continue
        maxWeight += neighbor.weight
        if (chunkTokenSet.has(neighbor.token)) {
          matchedWeight += neighbor.weight
        }
      }
    }

    if (maxWeight === 0) return 0
    return Math.max(0, Math.min(1, roundWeight(matchedWeight / maxWeight)))
  }
}

export function createCooccurrenceSemanticProvider(chunks: SearchChunkRecord[]): SemanticSearchProvider {
  return new CooccurrenceSemanticProvider(chunks)
}

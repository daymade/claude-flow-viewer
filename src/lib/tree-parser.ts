export interface TreeAnalysis {
  /** uuid set of records on the active (final) path */
  activeUuids: Set<string>
  /** Map from fork parent uuid -> array of abandoned branch record groups */
  forkPoints: Map<string, Record<string, unknown>[][]>
  /** Plan mode transitions */
  planTransitions: Array<{ uuid: string; type: 'enter' | 'exit'; planPreview?: string }>
  /** Whether the JSONL has tree data (uuid/parentUuid fields) */
  hasTreeData: boolean
}

function detectPlanTransition(record: Record<string, unknown>, uuid: string): { uuid: string; type: 'enter' | 'exit'; planPreview?: string } | null {
  if (record.type !== 'assistant') return null
  const message = record.message as Record<string, unknown> | undefined
  if (!message) return null
  const content = message.content
  if (!Array.isArray(content)) return null

  for (const c of content) {
    if (typeof c !== 'object' || c === null) continue
    const item = c as Record<string, unknown>
    if (item.type !== 'tool_use') continue

    if (item.name === 'EnterPlanMode') {
      return { uuid, type: 'enter' }
    }
    if (item.name === 'ExitPlanMode') {
      const input = (item.input || {}) as Record<string, unknown>
      const plan = typeof input.plan === 'string' ? input.plan : ''
      return { uuid, type: 'exit', planPreview: plan.slice(0, 200) }
    }
  }
  return null
}

/**
 * Collect all descendant records of a given uuid via BFS through childrenOf,
 * sorted by timestamp (original order as proxy).
 */
function collectSubtree(
  rootUuid: string,
  childrenOf: Map<string, string[]>,
  byUuid: Map<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const queue = [rootUuid]

  while (queue.length > 0) {
    const current = queue.shift()!
    const rec = byUuid.get(current)
    if (rec) result.push(rec)
    const children = childrenOf.get(current)
    if (children) {
      for (const childUuid of children) {
        queue.push(childUuid)
      }
    }
  }

  return result
}

export function analyzeConversationTree(records: Record<string, unknown>[]): TreeAnalysis {
  const empty: TreeAnalysis = {
    activeUuids: new Set(),
    forkPoints: new Map(),
    planTransitions: [],
    hasTreeData: false,
  }

  // Step 1: Build indices — only user/assistant for content analysis
  const byUuid = new Map<string, Record<string, unknown>>()
  const childrenOf = new Map<string, string[]>()
  // parentOf includes ALL record types (progress, system, etc.) so the
  // active-path trace can walk through non-content records without breaking.
  const parentOf = new Map<string, string | null>()

  for (const rec of records) {
    const uuid = rec.uuid
    if (typeof uuid !== 'string') continue

    // Track parent chain for ALL record types
    // compact_boundary records have parentUuid: null but logicalParentUuid pointing
    // to the last pre-compact record. Use logicalParentUuid to connect the trees.
    const rawParent = rec.parentUuid
    const logicalParent = rec.logicalParentUuid
    const effectiveParent = (rawParent === null || rawParent === undefined) && typeof logicalParent === 'string'
      ? logicalParent
      : rawParent
    parentOf.set(uuid, typeof effectiveParent === 'string' ? effectiveParent : null)

    const recType = rec.type
    if (recType !== 'user' && recType !== 'assistant') continue

    byUuid.set(uuid, rec)

    const parentUuid = rec.parentUuid
    if (typeof parentUuid === 'string') {
      const siblings = childrenOf.get(parentUuid)
      if (siblings) {
        siblings.push(uuid)
      } else {
        childrenOf.set(parentUuid, [uuid])
      }
    }
  }

  if (byUuid.size === 0) {
    return empty
  }

  // Step 2: Find tips for each disconnected tree.
  // /clear creates disconnected components — pre-clear and post-clear records
  // form separate trees. We must trace the active path in EACH tree, not just
  // from a single global tip, or entire subtrees get excluded.

  // 2a: Identify root uuids of each disconnected component.
  // A root is a user/assistant record whose parent chain (through all record types)
  // leads to null (no parent) or to a uuid not present in parentOf.
  function findRoot(uuid: string): string {
    const visited = new Set<string>()
    let cur: string | null = uuid
    while (cur) {
      if (visited.has(cur)) break // cycle guard
      visited.add(cur)
      const parent = parentOf.get(cur)
      if (parent === undefined || parent === null) return cur
      cur = parent
    }
    return cur || uuid
  }

  // Group user/assistant records by their tree root
  const treesByRoot = new Map<string, string[]>()
  for (const [uuid] of byUuid) {
    const root = findRoot(uuid)
    const list = treesByRoot.get(root)
    if (list) {
      list.push(uuid)
    } else {
      treesByRoot.set(root, [uuid])
    }
  }

  // 2b: For each disconnected tree, find its tip (last user/assistant by array order)
  // and trace the active path from that tip.
  const activeUuids = new Set<string>()

  for (const [, members] of treesByRoot) {
    const memberSet = new Set(members)
    let tipUuid: string | null = null
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]
      if (typeof rec.uuid === 'string' && memberSet.has(rec.uuid as string)) {
        tipUuid = rec.uuid as string
        break
      }
    }
    if (!tipUuid) continue

    // Walk from tip back to root via parentOf (which covers ALL types)
    let current: string | null = tipUuid
    while (current) {
      activeUuids.add(current)
      const parent = parentOf.get(current)
      if (parent === undefined) break // uuid not found at all
      current = parent // null means root reached, loop ends naturally
    }
  }

  if (activeUuids.size === 0) {
    return empty
  }

  // Step 3: Include tool_result siblings of active-path nodes.
  // Claude Code chains content blocks within a single assistant turn linearly
  // (e.g. Bash_tool_use → ToolSearch_tool_use). Each tool_use's result arrives
  // as a separate user child. The active-path trace follows only the chain,
  // leaving sibling tool_results off the path — creating false "forks".
  // Fix: for every active node, add its user children that are tool_result-only
  // leaf records (no further conversation branching from them).
  for (const uuid of [...activeUuids]) {
    const children = childrenOf.get(uuid)
    if (!children) continue

    for (const childUuid of children) {
      if (activeUuids.has(childUuid)) continue
      if (childrenOf.has(childUuid)) continue // Must be leaf

      const rec = byUuid.get(childUuid)
      if (!rec || rec.type !== 'user') continue

      // Must contain only tool_result content
      const msg = rec.message as Record<string, unknown> | undefined
      const content = msg?.content
      if (!Array.isArray(content)) continue

      const allToolResults = content.every(
        (c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'tool_result'
      )
      if (allToolResults) {
        activeUuids.add(childUuid)
      }
    }
  }

  // Step 4: Detect fork points
  const forkPoints = new Map<string, Record<string, unknown>[][]>()
  for (const [parentUuid, children] of childrenOf) {
    if (children.length <= 1) continue
    // At least one child must be off the active path for this to be a fork
    const abandonedChildren = children.filter(childUuid => !activeUuids.has(childUuid))
    if (abandonedChildren.length === 0) continue

    const abandonedBranches: Record<string, unknown>[][] = []
    for (const abandonedRoot of abandonedChildren) {
      const subtree = collectSubtree(abandonedRoot, childrenOf, byUuid)
      abandonedBranches.push(subtree)
    }
    forkPoints.set(parentUuid, abandonedBranches)
  }

  // Step 5: Detect plan mode transitions in active path (preserve order)
  const planTransitions: TreeAnalysis['planTransitions'] = []
  for (const rec of records) {
    const uuid = rec.uuid
    if (typeof uuid !== 'string') continue
    if (!activeUuids.has(uuid)) continue
    const transition = detectPlanTransition(rec, uuid)
    if (transition) {
      planTransitions.push(transition)
    }
  }

  return {
    activeUuids,
    forkPoints,
    planTransitions,
    hasTreeData: true,
  }
}

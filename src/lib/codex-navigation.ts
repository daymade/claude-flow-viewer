import type { SessionMeta } from '../types/session'

export interface CodexThreadNode {
  session: SessionMeta
  children: CodexThreadNode[]
  depth: number
  descendantCount: number
  latestActivityTime: string
  hasMissingParent: boolean
}

export interface CodexThreadSummary {
  mainTaskCount: number
  delegatedCount: number
  unlinkedCount: number
}

export interface CodexSelectionContext {
  root: CodexThreadNode
  active: CodexThreadNode
  lineage: CodexThreadNode[]
}

function flattenSubtreeSessions(node: CodexThreadNode): SessionMeta[] {
  const sessions = [node.session]
  for (const child of node.children) {
    sessions.push(...flattenSubtreeSessions(child))
  }
  return sessions
}

function rootSessions(nodes: CodexThreadNode[]): SessionMeta[] {
  return nodes.map((node) => node.session)
}

function compareSessionTimeDesc(a: SessionMeta, b: SessionMeta): number {
  return b.startTime.localeCompare(a.startTime)
}

function compareNodeActivityDesc(a: CodexThreadNode, b: CodexThreadNode): number {
  return b.latestActivityTime.localeCompare(a.latestActivityTime)
}

function finalizeNode(node: CodexThreadNode, depth: number): CodexThreadNode {
  node.depth = depth

  let latestActivityTime = node.session.startTime
  let descendantCount = 0

  for (const child of node.children) {
    finalizeNode(child, depth + 1)
    descendantCount += child.descendantCount + 1
    if (child.latestActivityTime.localeCompare(latestActivityTime) > 0) {
      latestActivityTime = child.latestActivityTime
    }
  }

  node.children.sort(compareNodeActivityDesc)
  node.latestActivityTime = latestActivityTime
  node.descendantCount = descendantCount
  return node
}

function cloneNode(node: CodexThreadNode, children: CodexThreadNode[]): CodexThreadNode {
  let latestActivityTime = node.session.startTime
  let descendantCount = 0

  for (const child of children) {
    descendantCount += child.descendantCount + 1
    if (child.latestActivityTime.localeCompare(latestActivityTime) > 0) {
      latestActivityTime = child.latestActivityTime
    }
  }

  return {
    ...node,
    children,
    latestActivityTime,
    descendantCount,
  }
}

function searchLineage(nodes: CodexThreadNode[], sessionId: string, path: CodexThreadNode[] = []): CodexThreadNode[] | null {
  for (const node of nodes) {
    const nextPath = [...path, node]
    if (node.session.id === sessionId) return nextPath
    const childPath = searchLineage(node.children, sessionId, nextPath)
    if (childPath) return childPath
  }
  return null
}

export function buildCodexThreadForest(sessions: SessionMeta[]): CodexThreadNode[] {
  const codexSessions = sessions
    .filter((session) => session.source === 'codex')
    .slice()
    .sort(compareSessionTimeDesc)

  const nodes = new Map<string, CodexThreadNode>()
  for (const session of codexSessions) {
    nodes.set(session.id, {
      session,
      children: [],
      depth: 0,
      descendantCount: 0,
      latestActivityTime: session.startTime,
      hasMissingParent: Boolean(session.parentSessionId),
    })
  }

  const roots: CodexThreadNode[] = []
  for (const session of codexSessions) {
    const node = nodes.get(session.id)
    if (!node) continue

    const parentId = session.parentSessionId
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent && parent !== node) {
      node.hasMissingParent = false
      parent.children.push(node)
      continue
    }

    roots.push(node)
  }

  for (const root of roots) {
    finalizeNode(root, 0)
  }

  roots.sort(compareNodeActivityDesc)
  return roots
}

export function filterCodexThreadForest(
  nodes: CodexThreadNode[],
  predicate: (session: SessionMeta) => boolean,
): CodexThreadNode[] {
  const filtered: CodexThreadNode[] = []

  for (const node of nodes) {
    const children = filterCodexThreadForest(node.children, predicate)
    if (predicate(node.session) || children.length > 0) {
      filtered.push(cloneNode(node, children))
    }
  }

  return filtered
}

export function selectCodexDisplaySessions(sessions: SessionMeta[], rootLimit: number): SessionMeta[] {
  const roots = buildCodexThreadForest(sessions).slice(0, rootLimit)
  return roots
    .flatMap(flattenSubtreeSessions)
    .sort(compareSessionTimeDesc)
}

export function selectCodexRootSessions(sessions: SessionMeta[], rootLimit: number): SessionMeta[] {
  return rootSessions(buildCodexThreadForest(sessions).slice(0, rootLimit))
    .sort(compareSessionTimeDesc)
}

export function summarizeCodexThreadForest(nodes: CodexThreadNode[]): CodexThreadSummary {
  return nodes.reduce<CodexThreadSummary>((summary, node) => {
    if (node.hasMissingParent) summary.unlinkedCount += 1
    else summary.mainTaskCount += 1
    summary.delegatedCount += node.descendantCount
    return summary
  }, { mainTaskCount: 0, delegatedCount: 0, unlinkedCount: 0 })
}

export function findCodexSelectionContext(
  nodes: CodexThreadNode[],
  sessionId: string | null,
): CodexSelectionContext | null {
  if (!sessionId) return null
  const lineage = searchLineage(nodes, sessionId)
  if (!lineage || lineage.length === 0) return null

  return {
    root: lineage[0],
    active: lineage[lineage.length - 1],
    lineage,
  }
}

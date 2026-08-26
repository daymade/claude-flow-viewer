import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FileStore } from '../../lib/fs-access'
import { SOURCE_METADATA } from '../../lib/source-metadata'
import {
  buildFeedbackEvidenceMarkdown,
  type UserInputRecord,
} from '../../lib/user-inputs'

type Props = {
  fileStore: FileStore | null
  onClose: () => void
  onOpenSession: (input: UserInputRecord) => void
}

function localDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replaceAll('/', '-')
}

function inputTime(input: UserInputRecord): { primary: string; secondary: string | null } {
  if (input.timestamp) return { primary: localDateTime(input.timestamp), secondary: null }
  if (input.timeRangeStart && input.timeRangeEnd) {
    return {
      primary: `${localDateTime(input.timeRangeStart)} →`,
      secondary: `${localDateTime(input.timeRangeEnd)} · 单条时间未保留`,
    }
  }
  return { primary: localDateTime(input.sessionStartTime), secondary: '按会话时间排序' }
}

function downloadMarkdown(markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  anchor.href = url
  anchor.download = `feedback-evidence-${stamp}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function UserInputsWorkspace({ fileStore, onClose, onOpenSession }: Props) {
  const [inputs, setInputs] = useState<UserInputRecord[]>([])
  const [selected, setSelected] = useState(new Set<string>())
  const [expanded, setExpanded] = useState(new Set<string>())
  const [query, setQuery] = useState('')
  const [feedbackOnly, setFeedbackOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<Awaited<ReturnType<NonNullable<FileStore['listUserInputs']>>>['coverage']>()

  const load = useCallback(async () => {
    if (!fileStore?.listUserInputs) {
      setError('“我的输入”需要本地 dev/preview server；浏览器手动文件模式没有跨会话索引。')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = await fileStore.listUserInputs({ limit: 500 })
      setInputs(payload.inputs)
      setCoverage(payload.coverage)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [fileStore])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return inputs.filter((input) => {
      if (feedbackOnly && input.decision === 'none' && input.origin !== 'queued') return false
      if (!normalized) return true
      return [input.text, input.projectLabel, input.projectShortName, input.sessionId, input.source]
        .some((value) => value.toLowerCase().includes(normalized))
    })
  }, [feedbackOnly, inputs, query])

  const selectedInputs = useMemo(
    () => inputs.filter((input) => selected.has(input.id)),
    [inputs, selected],
  )

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectVisible = () => setSelected(new Set(visible.map((input) => input.id)))

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[#FAFAF8]" data-user-input-workspace>
      <div className="shrink-0 border-b border-stone-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">My inputs</div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-stone-900">我说过什么</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-500">
              只列人类输入，按新到旧。先忠实找回与选择证据，再显式交给 AgentZero；这里不自动蒸馏。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
          >
            返回会话
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛原话、项目或 Session ID"
            className="min-w-72 flex-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/10"
          />
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={feedbackOnly}
              onChange={(event) => setFeedbackOnly(event.target.checked)}
              className="accent-amber-700"
            />
            只看结构性打断／纠正
          </label>
          <button type="button" onClick={() => void load()} className="rounded-lg px-3 py-2 text-xs font-medium text-stone-500 hover:bg-stone-100">
            刷新
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-stone-500">{visible.length} 条可见 · {selected.size} 条已选</span>
          <button type="button" onClick={selectVisible} className="rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-600 hover:bg-stone-200">
            选择当前结果
          </button>
          {selected.size > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="rounded-full px-2.5 py-1 font-medium text-stone-500 hover:bg-stone-100">
              清空选择
            </button>
          )}
          <button
            type="button"
            disabled={selectedInputs.length === 0}
            onClick={() => downloadMarkdown(buildFeedbackEvidenceMarkdown(selectedInputs))}
            className="ml-auto rounded-full bg-amber-700 px-3.5 py-1.5 font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-35"
          >
            导出反馈证据包{selectedInputs.length > 0 ? `（${selectedInputs.length}）` : ''}
          </button>
        </div>
        {coverage && (
          coverage.claudeHistory === 'missing'
          || coverage.codexHistory === 'missing'
          || coverage.omittedClaudePasteInputs > 0
          || coverage.malformedHistoryLines > 0
        ) && (
          <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
            {coverage.claudeHistory === 'missing' && <span className="mr-3">Claude 输入历史不可用。</span>}
            {coverage.codexHistory === 'missing' && <span className="mr-3">Codex 输入历史不可用。</span>}
            {coverage.omittedClaudePasteInputs > 0 && (
              <span className="mr-3">另有 {coverage.omittedClaudePasteInputs} 条 Claude 粘贴输入只剩占位符，未冒充完整原话。</span>
            )}
            {coverage.malformedHistoryLines > 0 && (
              <span>{coverage.malformedHistoryLines} 条历史记录格式损坏，未纳入列表。</span>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-stone-500">正在更新本地索引并读取原话…</div>
      ) : error ? (
        <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1040px] table-fixed border-collapse text-left">
            <caption className="sr-only">按新到旧排列的本地 Claude、Codex 与 Cherry Studio 用户输入</caption>
            <colgroup>
              <col className="w-12" />
              <col className="w-48" />
              <col className="w-28" />
              <col className="w-60" />
              <col />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-stone-100/95 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-500 backdrop-blur">
              <tr>
                <th className="border-b border-stone-200 px-3 py-2.5"><span className="sr-only">选择</span></th>
                <th className="border-b border-stone-200 px-3 py-2.5">时间（本机时区）</th>
                <th className="border-b border-stone-200 px-3 py-2.5">来源</th>
                <th className="border-b border-stone-200 px-3 py-2.5">会话</th>
                <th className="border-b border-stone-200 px-3 py-2.5">我的原始输入</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200/70 bg-[#FAFAF8]">
              {visible.map((input) => {
                const when = inputTime(input)
                const isExpanded = expanded.has(input.id)
                const source = SOURCE_METADATA[input.source]
                return (
                  <tr key={input.id} className="align-top hover:bg-white/80">
                    <td className="px-3 py-3.5">
                      <input
                        type="checkbox"
                        checked={selected.has(input.id)}
                        onChange={() => toggleSelected(input.id)}
                        aria-label="选择这条原话"
                        className="accent-amber-700"
                      />
                    </td>
                    <td className="px-3 py-3.5 font-mono text-[11px] leading-relaxed text-stone-600">
                      <div>{when.primary}</div>
                      {when.secondary && <div className="mt-1 font-sans text-[10px] text-stone-400">{when.secondary}</div>}
                    </td>
                    <td className="px-3 py-3.5">
                      <span className={`rounded px-2 py-1 text-[10px] font-semibold ${source.badgeClass}`}>{source.label}</span>
                      {input.origin !== 'direct' && (
                        <div className="mt-1.5 text-[10px] text-stone-400">{input.origin === 'queued' ? '会中追加' : '压缩保留'}</div>
                      )}
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="truncate text-xs font-medium text-stone-700" title={input.projectLabel}>{input.projectShortName}</div>
                      <button
                        type="button"
                        onClick={() => onOpenSession(input)}
                        className="mt-1 font-mono text-[10px] text-amber-700 hover:underline"
                        title={input.sessionId}
                      >
                        {input.sessionId.slice(0, 8)}… · 打开
                      </button>
                    </td>
                    <td className="px-3 py-3.5">
                      <div className={`whitespace-pre-wrap break-words text-[13px] leading-6 text-stone-800 ${isExpanded ? '' : 'line-clamp-3'}`}>
                        {input.text}
                      </div>
                      {input.text.length > 180 && (
                        <button type="button" onClick={() => toggleExpanded(input.id)} className="mt-1 text-[10px] font-medium text-stone-400 hover:text-amber-700">
                          {isExpanded ? '收起' : '展开完整原话'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="px-5 py-12 text-center text-sm text-stone-400">当前筛选下没有原话。</div>
          )}
        </div>
      )}
    </section>
  )
}

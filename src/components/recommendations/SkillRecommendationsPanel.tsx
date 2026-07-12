import { useMemo, useState } from 'react'

import type { ClaudeSkillRecommendationsState } from '../../hooks/useClaudeSkillRecommendations'
import type { SkillRecommendationAnalyzeOptions, SkillRecommendationAnalyzeScope } from '../../lib/skill-recommendations'

function confidenceClass(confidence: 'high' | 'medium' | 'emerging'): string {
  if (confidence === 'high') return 'bg-stone-100 text-stone-800'
  if (confidence === 'medium') return 'bg-amber-100 text-amber-800'
  return 'bg-stone-100 text-stone-700'
}

export function SkillRecommendationsPanel({
  recommendations,
  activeProject,
  onAnalyze,
  onRecheck,
}: {
  recommendations: ClaudeSkillRecommendationsState
  activeProject: { encodedName: string; shortName: string } | null
  onAnalyze: (options: SkillRecommendationAnalyzeOptions) => void
  onRecheck: () => void
}) {
  const [selectedScope, setSelectedScope] = useState<SkillRecommendationAnalyzeScope>('smart')
  const [expanded, setExpanded] = useState(false)
  const lastAnalysis = recommendations.analysis

  const effectiveScope = activeProject || selectedScope !== 'project'
    ? selectedScope
    : 'smart'
  const analyzeOptions = useMemo<SkillRecommendationAnalyzeOptions>(() => {
    if (effectiveScope === 'project' && activeProject) {
      return { scope: 'project', projectEncoded: activeProject.encodedName }
    }

    if (effectiveScope === 'recent') {
      return { scope: 'recent' }
    }

    return {
      scope: 'smart',
      projectEncoded: activeProject?.encodedName,
    }
  }, [activeProject, effectiveScope])
  const analysisMatchesSelection = Boolean(
    lastAnalysis
    && lastAnalysis.scope === (analyzeOptions.scope ?? 'smart')
    && (lastAnalysis.requestedProjectEncoded ?? null) === (analyzeOptions.projectEncoded ?? null),
  )
  const analysis = analysisMatchesSelection ? lastAnalysis : null
  const selectionChangedSinceLastRun = Boolean(lastAnalysis && !analysisMatchesSelection)
  const items = analysis?.recommendations ?? []

  const scopeOptions: Array<{
    scope: SkillRecommendationAnalyzeScope
    label: string
    detail: string
    cost: 'low' | 'medium' | 'high'
    disabled?: boolean
  }> = [
    {
      scope: 'smart',
      label: 'Smart',
      detail: activeProject
        ? `Recommended. Prefer ${activeProject.shortName}, fall back to global recent history if context is too thin.`
        : 'Recommended. Use a low-cost recent-history slice across all projects.',
      cost: 'low',
    },
    {
      scope: 'project',
      label: 'This project',
      detail: activeProject
        ? `Only analyze recent sessions from ${activeProject.shortName}.`
        : 'Select a project first to use this scope.',
      cost: 'medium',
      disabled: !activeProject,
    },
    {
      scope: 'recent',
      label: 'Recent all',
      detail: 'Analyze the recent cross-project history. Broadest coverage, highest cost.',
      cost: 'high',
    },
  ]

  if (recommendations.status === 'idle') return null

  const backendUnavailable = Boolean(
    recommendations.status === 'unavailable' && recommendations.backend && !recommendations.backend.available,
  )
  // The "ready but nothing analyzed yet" promo (description + scope cards + CTA) is the only state
  // that dominates the sidebar rail. Collapse it to a one-line header by default so the session
  // navigation stays above the fold; states with real activity/results/errors stay expanded.
  const isFreshIdlePromo =
    recommendations.status !== 'checking' &&
    recommendations.status !== 'analyzing' &&
    !recommendations.error &&
    !analysis &&
    !selectionChangedSinceLastRun &&
    !backendUnavailable
  const collapsed = isFreshIdlePromo && !expanded

  const scopeControls = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">Scope</div>
      <div className="mt-2 grid gap-2">
        {scopeOptions.map((option) => {
          const selected = effectiveScope === option.scope
          return (
            <button
              key={option.scope}
              type="button"
              disabled={option.disabled}
              onClick={() => setSelectedScope(option.scope)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                option.disabled
                  ? 'cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400'
                  : selected
                    ? 'border-stone-200 bg-stone-50'
                    : 'border-stone-200 bg-white hover:border-stone-100 hover:bg-stone-50/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-stone-800">{option.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  option.cost === 'low'
                    ? 'bg-stone-100 text-stone-800'
                    : option.cost === 'medium'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-rose-100 text-rose-800'
                }`}>
                  {option.cost} cost
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-stone-600">{option.detail}</div>
            </button>
          )
        })}
      </div>
    </>
  )

  return (
    <div className="mt-2 rounded-xl border border-stone-100 bg-white shadow-sm shadow-stone-100/40">
      {isFreshIdlePromo ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className={`flex w-full items-center gap-2 px-3 py-2 text-[10px] hover:bg-stone-50/40 ${
            expanded ? 'border-b border-stone-50' : ''
          }`}
        >
          <span className="font-semibold uppercase tracking-[0.14em] text-stone-700">Skill ideas</span>
          <span className="text-stone-400">No strong pattern yet</span>
          <svg
            className={`ml-auto h-3 w-3 shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b border-stone-50 px-3 py-2 text-[10px]">
          <span className="font-semibold uppercase tracking-[0.14em] text-stone-700">Skill ideas</span>
          <span className="text-stone-400">
            {recommendations.status === 'checking'
              ? 'Checking local Claude'
              : recommendations.status === 'analyzing'
                ? 'Local Claude team is discussing'
                : selectionChangedSinceLastRun
                  ? 'Selection changed'
                : items.length > 0
                ? `${items.length} suggestion${items.length === 1 ? '' : 's'}`
                : 'No strong pattern yet'}
          </span>
          {analysis && (
            <span className="ml-auto text-stone-400">
              {analysis.analyzedSessionCount} recent sessions
            </span>
          )}
          {(recommendations.status === 'checking' || recommendations.status === 'analyzing') ? (
            <span className="h-1.5 w-1.5 rounded-full bg-stone-500 animate-pulse" />
          ) : null}
        </div>
      )}

      {!collapsed && (recommendations.status === 'checking' ? (
        <div className="px-3 py-2 text-xs text-stone-500">
          Checking whether the local server can run on-demand Claude Code analysis.
        </div>
      ) : recommendations.status === 'analyzing' ? (
        <div className="px-3 py-2 text-xs text-stone-500">
          Scout, skeptic, and writer agents are analyzing recent history with the local `claude` CLI. This usually takes tens of seconds.
        </div>
      ) : recommendations.status === 'unavailable' && recommendations.backend && !recommendations.backend.available ? (
        <div className="px-3 py-2">
          <div className="text-xs text-stone-500">
            {recommendations.backend.message}
          </div>
          <button
            type="button"
            onClick={onRecheck}
            className="mt-2 rounded-full bg-stone-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-stone-700"
          >
            Check local Claude again
          </button>
        </div>
      ) : recommendations.error ? (
        <div className="px-3 py-2">
          <div className="text-xs text-rose-600">{recommendations.error}</div>
          <div className="mt-3">
            {scopeControls}
          </div>
          <button
            type="button"
            onClick={() => onAnalyze(analyzeOptions)}
            className="mt-2 rounded-full bg-stone-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-stone-700"
          >
            Retry with local Claude
          </button>
        </div>
      ) : analysis ? (
        <>
          <div className="border-b border-stone-100 px-3 py-3">
            {scopeControls}
            <button
              type="button"
              onClick={() => onAnalyze(analyzeOptions)}
              className="mt-3 rounded-full bg-stone-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-stone-700"
            >
              Analyze with local Claude
            </button>
          </div>

          {analysis.discussion.length > 0 && (
            <div className="border-b border-stone-100 px-3 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">Team discussion</div>
              <div className="mt-1 text-[11px] text-stone-500">
                {analysis.scopeLabel}
                {analysis.targetLabel ? ` · ${analysis.targetLabel}` : ''}
                {` · ${analysis.analyzedSessionCount} session${analysis.analyzedSessionCount === 1 ? '' : 's'}`}
              </div>
              <div className="mt-2 space-y-2">
                {analysis.discussion.map((point) => (
                  <div key={`${point.agent}-${point.point}`} className="rounded-lg bg-stone-50 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-500">{point.agent}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-stone-600">{point.point}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.recommendations.length > 0 ? (
            <div className="max-h-[340px] space-y-2 overflow-y-auto px-2 py-2">
              {analysis.recommendations.map((recommendation) => (
                <article key={recommendation.id} className="rounded-lg border border-stone-200 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold text-stone-900">{recommendation.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceClass(recommendation.confidence)}`}>
                      {recommendation.confidence}
                    </span>
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">
                      {recommendation.name}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-stone-600">
                    {recommendation.summary}
                  </div>
                  <div className="mt-2 text-[11px] leading-relaxed text-stone-500">
                    {recommendation.rationale}
                  </div>
                  <div className="mt-2 text-[11px] leading-relaxed text-stone-600">
                    <span className="font-semibold text-stone-700">When to use:</span>{' '}
                    {recommendation.whenToUse}
                  </div>
                  {recommendation.steps.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-500">Suggested steps</div>
                      <div className="mt-1 space-y-1">
                        {recommendation.steps.map((step, index) => (
                          <div key={`${recommendation.id}-${index}`} className="text-[11px] leading-relaxed text-stone-600">
                            {index + 1}. {step}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {recommendation.evidence.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {recommendation.evidence.map((entry) => (
                        <span key={entry} className="rounded-full bg-stone-50 px-2 py-0.5 text-[10px] text-stone-700">
                          {entry}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-stone-500">
              Local Claude did not find a strong enough repeated workflow in the recent history.
            </div>
          )}
        </>
      ) : (
        <div className="px-3 py-3">
          <div className="text-xs leading-relaxed text-stone-500">
            {selectionChangedSinceLastRun
              ? 'The selected scope changed after the last run. Re-run analysis to refresh the results for the current selection.'
              : 'Run a local Claude Code team analysis over recent history. This is on-demand, server-only, and uses Claude to do the abstraction instead of heuristics.'}
          </div>
          <div className="mt-3">
            {scopeControls}
          </div>
          <button
            type="button"
            onClick={() => onAnalyze(analyzeOptions)}
            className="mt-3 rounded-full bg-stone-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-stone-700"
          >
            Analyze with local Claude
          </button>
        </div>
      ))}
    </div>
  )
}

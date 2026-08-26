// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileStore } from '../../lib/fs-access'
import type { UserInputRecord } from '../../lib/user-inputs'
import { UserInputsWorkspace } from './UserInputsWorkspace'

const inputs: UserInputRecord[] = [
  {
    id: 'codex:session-1:compacted-1',
    source: 'codex',
    projectEncoded: 'codex:/Users/test/project',
    projectLabel: '/Users/test/project',
    projectShortName: 'project',
    sessionId: '01a039be-f86d-7203-b821-1d72370e1b69',
    sessionStartTime: '2026-08-26T00:26:51.000Z',
    text: '不要擅自开启新一轮试错，先看以前做过的事情',
    timestamp: null,
    timeRangeStart: '2026-08-26T00:26:51.000Z',
    timeRangeEnd: '2026-08-26T02:42:07.000Z',
    origin: 'compacted',
    decision: 'correction',
    promptNum: null,
    sortTimestamp: '2026-08-26T02:42:07.000Z',
    ordinal: 3,
  },
  {
    id: 'claude:session-2:prompt-1',
    source: 'claude',
    projectEncoded: '-Users-test-project',
    projectLabel: '/Users/test/project',
    projectShortName: 'project',
    sessionId: '3e71e245-a8cd-4703-b954-b0b52e593604',
    sessionStartTime: '2026-08-23T07:51:33.000Z',
    text: '优先复用我们已经做过的经验',
    timestamp: '2026-08-23T07:51:43.000Z',
    timeRangeStart: null,
    timeRangeEnd: null,
    origin: 'direct',
    decision: 'none',
    promptNum: 2,
    sortTimestamp: '2026-08-23T07:51:43.000Z',
    ordinal: null,
  },
]

afterEach(() => cleanup())

describe('UserInputsWorkspace', () => {
  it('renders exact inputs and keeps compacted timestamps honest', async () => {
    const listUserInputs = vi.fn().mockResolvedValue({
      generatedAt: '2026-08-26T10:00:00.000Z',
      inputs,
    })

    render(
      <UserInputsWorkspace
        fileStore={{ listUserInputs } as unknown as FileStore}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    )

    expect(await screen.findByText(inputs[0].text)).toBeTruthy()
    expect(screen.getByText(inputs[1].text)).toBeTruthy()
    expect(screen.getByText(/单条时间未保留/)).toBeTruthy()
    expect(screen.getByText('压缩保留')).toBeTruthy()
    expect(listUserInputs).toHaveBeenCalledWith({ limit: 500 })
  })

  it('filters to structural feedback and opens the source session', async () => {
    const onOpenSession = vi.fn()
    render(
      <UserInputsWorkspace
        fileStore={{
          listUserInputs: vi.fn().mockResolvedValue({ generatedAt: '2026-08-26T10:00:00.000Z', inputs }),
        } as unknown as FileStore}
        onClose={() => {}}
        onOpenSession={onOpenSession}
      />,
    )

    await screen.findByText(inputs[0].text)
    fireEvent.click(screen.getByRole('checkbox', { name: '只看结构性打断／纠正' }))
    expect(screen.getByText(inputs[0].text)).toBeTruthy()
    expect(screen.queryByText(inputs[1].text)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /01a039be.*打开/ }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(inputs[0]))
  })
})

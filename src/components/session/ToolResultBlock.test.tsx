// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react'
import {ToolResultBlock} from './MessageRenderers'
import {SessionResources, type ReadToolResult} from './SessionResources'
import type {SessionMessage} from '../../types/session'

afterEach(cleanup)

type ToolResultMessage = Extract<SessionMessage,{kind:'tool-result'}>
const msg = (externalFile:string,content:string): ToolResultMessage =>
  ({kind:'tool-result',content,isError:false,externalFile,totalSize:'1 KB'})

function deferred<T>() {
  let resolve!: (value:T) => void
  let reject!: (error:unknown) => void
  const promise = new Promise<T>((res,rej) => {resolve=res;reject=rej})
  return {promise,resolve,reject}
}

const flush = () => act(async () => {await new Promise(resolve => setTimeout(resolve,0))})

const preText = (container:HTMLElement) => container.querySelector('pre')?.textContent

it('ignores a late success reply for a resource the slot no longer shows (same filename, new session scope)',async()=>{
  const a = deferred<string>()
  const readA = vi.fn(() => a.promise)
  const readB = vi.fn(async () => 'B_FULL')
  const {container,rerender} = render(
    <SessionResources.Provider value={{readToolResult:readA,scope:'claude/proj/session-a'}}>
      <ToolResultBlock msg={msg('tool-results/same.txt','A_PREVIEW')}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  expect(readA).toHaveBeenCalledWith('tool-results/same.txt')

  // The mounted slot switches to session B before A replies.
  rerender(
    <SessionResources.Provider value={{readToolResult:readB,scope:'claude/proj/session-b'}}>
      <ToolResultBlock msg={msg('tool-results/same.txt','B_PREVIEW')}/>
    </SessionResources.Provider>)
  expect(preText(container)).toBe('B_PREVIEW')

  a.resolve('A_FULL_SENTINEL')
  await flush()
  expect(preText(container)).toBe('B_PREVIEW')
  expect(screen.queryByText('A_FULL_SENTINEL')).toBeNull()

  // The slot still works for the new resource.
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  expect(readB).toHaveBeenCalledWith('tool-results/same.txt')
  await flush()
  expect(preText(container)).toBe('B_FULL')
})

it('ignores a late error reply for a resource the slot no longer shows',async()=>{
  const a = deferred<string>()
  const readA = vi.fn(() => a.promise)
  const {rerender} = render(
    <SessionResources.Provider value={{readToolResult:readA,scope:'claude/proj/session-a'}}>
      <ToolResultBlock msg={msg('tool-results/a.txt','A_PREVIEW')}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  rerender(
    <SessionResources.Provider value={{readToolResult:vi.fn(async()=> 'B_FULL'),scope:'claude/proj/session-b'}}>
      <ToolResultBlock msg={msg('tool-results/a.txt','B_PREVIEW')}/>
    </SessionResources.Provider>)
  a.reject(new Error('synthetic failure'))
  await flush()
  expect(screen.queryByText('Failed to load full content')).toBeNull()
})

it('drops already loaded output when the slot switches to another session with the same filename',async()=>{
  const readA = vi.fn(async () => 'A_FULL')
  const {container,rerender} = render(
    <SessionResources.Provider value={{readToolResult:readA,scope:'claude/proj/session-a'}}>
      <ToolResultBlock msg={msg('tool-results/same.txt','A_PREVIEW')}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  await flush()
  expect(preText(container)).toBe('A_FULL')

  rerender(
    <SessionResources.Provider value={{readToolResult:vi.fn(async()=> 'B_FULL'),scope:'claude/proj/session-b'}}>
      <ToolResultBlock msg={msg('tool-results/same.txt','B_PREVIEW')}/>
    </SessionResources.Provider>)
  expect(preText(container)).toBe('B_PREVIEW')
})

it('keeps loaded output when the same scope only supplies a fresh loader callback',async()=>{
  const readA1 = vi.fn(async () => 'A_FULL')
  const message = msg('tool-results/a.txt','A_PREVIEW')
  const {container,rerender} = render(
    <SessionResources.Provider value={{readToolResult:readA1,scope:'claude/proj/session-a'}}>
      <ToolResultBlock msg={message}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  await flush()
  expect(preText(container)).toBe('A_FULL')

  const readA2 = vi.fn(async () => 'A_FULL_AGAIN')
  rerender(
    <SessionResources.Provider value={{readToolResult:readA2,scope:'claude/proj/session-a'}}>
      <ToolResultBlock msg={message}/>
    </SessionResources.Provider>)
  expect(preText(container)).toBe('A_FULL')
  expect(readA2).not.toHaveBeenCalled()
})

it('probe shape: a pending unscoped load of A never lands under B',async()=>{
  const a = deferred<string>()
  const readA: ReadToolResult = () => a.promise
  const readB: ReadToolResult = async () => 'B_FULL'
  const {container,rerender} = render(
    <SessionResources.Provider value={readA}>
      <ToolResultBlock msg={msg('tool-results/a.txt','A_PREVIEW')}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  rerender(
    <SessionResources.Provider value={readB}>
      <ToolResultBlock msg={msg('tool-results/b.txt','B_PREVIEW')}/>
    </SessionResources.Provider>)
  expect(preText(container)).toBe('B_PREVIEW')
  a.resolve('A_FULL_SENTINEL')
  await flush()
  expect(preText(container)).toBe('B_PREVIEW')
  expect(screen.queryByText('A_FULL_SENTINEL')).toBeNull()
})

it('conservatively invalidates unscoped loaded output when the loader identity changes',async()=>{
  const readA: ReadToolResult = async () => 'A_FULL'
  const message = msg('tool-results/a.txt','A_PREVIEW')
  const {container,rerender} = render(
    <SessionResources.Provider value={readA}>
      <ToolResultBlock msg={message}/>
    </SessionResources.Provider>)
  fireEvent.click(screen.getByRole('button',{name:/load full output/i}))
  await flush()
  expect(preText(container)).toBe('A_FULL')

  const readB: ReadToolResult = async () => 'B_FULL'
  rerender(
    <SessionResources.Provider value={readB}>
      <ToolResultBlock msg={message}/>
    </SessionResources.Provider>)
  expect(preText(container)).toBe('A_PREVIEW')
})

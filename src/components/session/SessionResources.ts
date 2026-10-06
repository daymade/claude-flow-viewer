import { createContext, useContext } from 'react'

export type ReadToolResult = (relativePath: string) => Promise<string>
export const SessionResources = createContext<ReadToolResult | null>(null)
export const useSessionResources = () => useContext(SessionResources)

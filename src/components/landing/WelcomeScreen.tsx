import { useRef, useEffect, useState, type DragEvent } from 'react'
import { useFileLoader } from '../../hooks/useFileLoader'
import { useAppState } from '../../hooks/useSessionStore'
import { supportsDirectoryPicker } from '../../lib/fs-access'

export function WelcomeScreen() {
  const { loadDirectory, loadFromFiles, loadFromHandle, switchDirectory } = useFileLoader()
  const { state } = useAppState()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.setAttribute('webkitdirectory', '')
      inputRef.current.setAttribute('directory', '')
    }
  }, [])

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)

    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return

    // Try File System Access API (getAsFileSystemHandle)
    const item = items[0]
    if ('getAsFileSystemHandle' in item) {
      const handle = await (item as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle> }).getAsFileSystemHandle()
      if (handle?.kind === 'directory') {
        await loadFromHandle(handle as FileSystemDirectoryHandle)
        return
      }
    }

    // Fallback: use files
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      await loadFromFiles(files)
    }
  }

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-violet-50/40 flex items-center justify-center p-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`max-w-lg w-full bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 p-10 text-center transition-all duration-300 ${
          dragging ? 'ring-2 ring-violet-400 ring-offset-4 scale-[1.02] shadow-violet-100' : ''
        }`}
      >
        {/* Logo mark */}
        <div className="mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center mb-5 shadow-lg shadow-violet-200">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mb-1.5 tracking-tight font-sans">Decision Flow Viewer</h1>
        <p className="text-slate-500 text-sm mb-8 leading-relaxed max-w-xs mx-auto font-sans">
          Visualize Claude Code sessions. User prompts and decisions take center stage.
        </p>

        {state.loading && (
          <div className="text-violet-600 text-sm mb-4 animate-pulse font-medium">Loading sessions...</div>
        )}

        {state.error && (
          <div className="text-red-600 text-sm mb-4 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{state.error}</div>
        )}

        {dragging ? (
          <div className="py-10 text-violet-600 font-semibold text-lg border-2 border-dashed border-violet-300 rounded-xl bg-violet-50/50">
            Drop folder here
          </div>
        ) : (
          <>
            <button
              onClick={switchDirectory}
              disabled={state.loading}
              className="w-full py-3.5 px-5 bg-violet-600 text-white rounded-xl font-semibold hover:bg-violet-700 active:bg-violet-800 disabled:opacity-50 transition-all duration-150 mb-3 cursor-pointer shadow-md shadow-violet-200 hover:shadow-lg hover:shadow-violet-200"
            >
              Load Sessions
            </button>

            {supportsDirectoryPicker() && (
              <button
                onClick={loadDirectory}
                disabled={state.loading}
                className="w-full py-3.5 px-5 rounded-xl font-semibold disabled:opacity-50 transition-all duration-150 cursor-pointer bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200"
              >
                Or Select Folder Manually
              </button>
            )}

            <input
              type="file"
              ref={inputRef}
              className="hidden"
              onChange={(e) => e.target.files && loadFromFiles(e.target.files)}
            />

            <div className="mt-8 pt-5 border-t border-slate-100">
              <p className="text-slate-400 text-xs leading-relaxed">
                Select your home directory or <code className="text-violet-500 bg-violet-50 px-1.5 py-0.5 rounded text-[11px] font-mono">.claude</code> folder.
                Sessions are discovered automatically.
              </p>
              <p className="text-slate-300 text-xs mt-2">
                You can also drag & drop the folder here.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

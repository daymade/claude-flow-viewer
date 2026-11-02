import { useState, type DetailsHTMLAttributes, type ReactNode } from 'react'

type DeferredDetailsProps = Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children' | 'onToggle'> & {
  children: [ReactNode, () => ReactNode]
  forceMount?: boolean
}

export function DeferredDetails({children, forceMount = false, ...props}: DeferredDetailsProps) {
  const [hasOpened, setHasOpened] = useState(false)
  return <details {...props} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open) setHasOpened(true)
  }}>
    {children[0]}
    {(hasOpened || forceMount) ? children[1]() : null}
  </details>
}

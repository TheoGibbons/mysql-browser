import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useDialogDrag } from './useDialogDrag'

interface ModalProps {
  title: string
  width?: number | string
  height?: number | string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  /** Enter triggers this; disabled while it returns false. */
  onSubmit?(): void
}

export function Modal({
  title,
  width = 560,
  height,
  onClose,
  children,
  footer,
  onSubmit
}: ModalProps): JSX.Element {
  const drag = useDialogDrag()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Enter' && onSubmit && !(e.target as HTMLElement)?.closest('textarea')) {
        e.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onSubmit])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={drag.ref}
        className="modal"
        style={{ width, height, ...drag.style }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title drag-handle" {...drag.handleProps}>
          {title}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

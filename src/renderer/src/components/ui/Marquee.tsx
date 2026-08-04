import { useEffect, useRef, type ReactNode } from 'react'

interface MarqueeProps {
  children: ReactNode
}

/**
 * Single-line text that is clipped when it does not fit, then slides its tail
 * into view while the pointer is over the surrounding card. Used for values
 * that are routinely too long for their card - RDS hostnames especially.
 *
 * The travel distance is measured rather than guessed, so text that already
 * fits never animates.
 */
export function Marquee({ children }: MarqueeProps): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = (): void => {
      const overflow = Math.max(0, el.scrollWidth - el.clientWidth)
      el.classList.toggle('overflowing', overflow > 0)
      el.style.setProperty('--marquee-x', `${-overflow}px`)
      // A constant reading speed, so a long host does not whip past.
      el.style.setProperty('--marquee-ms', `${Math.round(200 + overflow * 22)}ms`)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [children])

  return (
    <span className="marquee" ref={ref}>
      <span>{children}</span>
    </span>
  )
}

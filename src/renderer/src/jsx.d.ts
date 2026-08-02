/**
 * React 19 removed the ambient global `JSX` namespace in favour of `React.JSX`.
 * Re-exporting it globally keeps `: JSX.Element` return annotations working.
 */
import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
  }
}

export {}

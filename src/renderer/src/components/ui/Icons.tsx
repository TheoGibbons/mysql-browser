/** Inline SVG icons — no network requests, crisp at 12-16px. */

interface IconProps {
  size?: number
  color?: string
  title?: string
}

function svg(size: number, children: JSX.Element, title?: string): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

export const HomeIcon = ({ size = 14, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <path
      d="M8 1.8 1.8 7h1.6v6.4h3.1V9.8h3v3.6h3.1V7h1.6L8 1.8Z"
      fill={color}
    />
  )

export const SchemaIcon = ({ size = 13, color = '#6f7f92' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <ellipse cx="8" cy="3.6" rx="5.4" ry="2.1" fill={color} />
      <path d="M2.6 5.6v3c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1v-3c0 1.16-2.42 2.1-5.4 2.1s-5.4-.94-5.4-2.1Z" fill={color} opacity=".75" />
      <path d="M2.6 9.5v2.9c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1V9.5c0 1.16-2.42 2.1-5.4 2.1s-5.4-.94-5.4-2.1Z" fill={color} opacity=".55" />
    </>
  )

export const TableIcon = ({ size = 13, color = '#5b7fa6' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1" fill="#fff" stroke={color} strokeWidth="1" />
      <path d="M1.8 5.6h12.4M1.8 8.5h12.4M1.8 11.4h12.4M6 5.6v7.8M10.2 5.6v7.8" stroke={color} strokeWidth=".8" />
      <rect x="1.8" y="2.6" width="12.4" height="3" fill={color} opacity=".55" />
    </>
  )

export const ViewIcon = ({ size = 13, color = '#7a6aa6' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1" fill="#fff" stroke={color} strokeWidth="1" />
      <path d="M1.8 5.6h12.4M6 5.6v7.8" stroke={color} strokeWidth=".8" strokeDasharray="2 1.5" />
      <rect x="1.8" y="2.6" width="12.4" height="3" fill={color} opacity=".45" />
    </>
  )

export const ColumnIcon = ({ size = 12, color = '#8a8a8a' }: IconProps): JSX.Element =>
  svg(size, <circle cx="8" cy="8" r="3.2" fill="none" stroke={color} strokeWidth="1.4" />)

export const KeyIcon = ({ size = 12, color = '#d1a318' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="5.4" cy="6" r="2.6" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="M7.4 7.8 12.6 13M10.6 11l1.4-1.4M12.1 12.5l1.3-1.3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </>
  )

export const RefreshIcon = ({ size = 13, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <path
      d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4V5.4H10"
      stroke={color}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  )

export const SearchIcon = ({ size = 12, color = '#7a7a7a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="m10.2 10.2 3 3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </>
  )

export const PlusIcon = ({ size = 14, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.2" />
      <path d="M8 4.8v6.4M4.8 8h6.4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </>
  )

/** A folder with a plus — "add a group" on the home screen. */
export const NewGroupIcon = ({ size = 14, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path
        d="M1.6 3.4h4.3l1.2 1.5h7.3v7.7H1.6V3.4Z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8.4 6.6v4M6.4 8.6h4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </>
  )

export const SettingsIcon = ({ size = 12, color = '#5a5a5a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="2.2" fill="none" stroke={color} strokeWidth="1.3" />
      <path
        d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </>
  )

/** Execute the whole script. */
export const BoltIcon = ({ size = 14, color = '#d99a1e' }: IconProps): JSX.Element =>
  svg(size, <path d="M9.4 1.2 3.4 9h3.4l-1.2 5.8L12.6 6.6H8.8l.6-5.4Z" fill={color} stroke="#a8740f" strokeWidth=".7" strokeLinejoin="round" />)

/** Execute the statement under the caret. */
export const BoltCursorIcon = ({ size = 14, color = '#d99a1e' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="M7.6 1.2 2.6 8h2.8l-1 4.8L10.2 6.2H7.1l.5-5Z" fill={color} stroke="#a8740f" strokeWidth=".7" strokeLinejoin="round" />
      <path d="M12 3.2h2.6M13.3 3.2v9.6M12 12.8h2.6" stroke="#333" strokeWidth="1" strokeLinecap="round" />
    </>
  )

/** Explain the statement under the caret. */
export const BoltExplainIcon = ({ size = 14, color = '#d99a1e' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="M6.8 1.2 2 7.6h2.7l-1 4.6 5.4-6.4H6.3l.5-4.6Z" fill={color} stroke="#a8740f" strokeWidth=".7" strokeLinejoin="round" />
      <circle cx="11.2" cy="9.6" r="3" fill="#fff" stroke="#333" strokeWidth="1.1" />
      <path d="m13.4 11.8 1.8 1.8" stroke="#333" strokeWidth="1.3" strokeLinecap="round" />
    </>
  )

export const StopIcon = ({ size = 14, color = '#c62828' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="6.2" fill={color} />
      <rect x="5.4" y="5.4" width="5.2" height="5.2" rx=".6" fill="#fff" />
    </>
  )

export const BroomIcon = ({ size = 14, color = '#6b8f3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="m12.8 2.2-5 5" stroke="#8a6a3a" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.4 6.6 4 10l2.4 2.4L9.8 9 7.4 6.6Z" fill={color} />
      <path d="m3.4 10.6-1.6 3.6 3.6-1.6" fill={color} opacity=".6" />
    </>
  )

export const ExportIcon = ({ size = 13, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="M8 10.4V2.2M5.2 5l2.8-2.8L10.8 5" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M2.6 10v3.4h10.8V10" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  )

export const ImportIcon = ({ size = 13, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="M8 2.2v8.2M5.2 7.6 8 10.4l2.8-2.8" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M2.6 10v3.4h10.8V10" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  )

export const PlugIcon = ({ size = 13, color = '#3a3a3a' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <path d="M6 1.6v3.6M10 1.6v3.6" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3.6 5.2h8.8v2.2a4.4 4.4 0 0 1-8.8 0V5.2Z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 11.8v2.6" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </>
  )

export const QueryIcon = ({ size = 12, color = '#4a7ab5' }: IconProps): JSX.Element =>
  svg(
    size,
    <>
      <circle cx="7" cy="7" r="4.4" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="m10.4 10.4 3.2 3.2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5.2 7h3.6" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </>
  )

/**
 * Crisp monochrome stroke SVG icons shared across thread responses, reasoning disclosures,
 * tool-use stream rows, slash commands, attachments, and pill menus (t1426).
 *
 * ⛔ Decorative only (`aria-hidden="true"`): every interactive control keeps its accessible label
 * or visible text so screen readers and L3 checks never depend on icon glyphs.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 14, children, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 4-point sparkle for AI reasoning, thinking states, and intermediate activity. */
export function SparkleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 1.75L9.45 6.55L14.25 8L9.45 9.45L8 14.25L6.55 9.45L1.75 8L6.55 6.55L8 1.75Z" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 6L8 10L12 6" />
    </Icon>
  )
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4V9A1.5 1.5 0 0 0 4 10.5H5.5" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.25 8.5L6.5 11.75L12.75 4.5" />
    </Icon>
  )
}

export function PromptDocIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.5 2.5H9.5L12.5 5.5V13A1 1 0 0 1 11.5 14H4.5A1 1 0 0 1 3.5 13V3.5A1 1 0 0 1 4.5 2.5Z" />
      <path d="M9.5 2.5V5.5H12.5" />
      <path d="M5.75 8.25H10.25M5.75 10.75H8.75" />
    </Icon>
  )
}

export function CodeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5L2 8L5.5 11.5" />
      <path d="M10.5 4.5L14 8L10.5 11.5" />
      <path d="M9 3.5L7 12.5" />
    </Icon>
  )
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.25V8.5" />
      <circle cx="8" cy="10.75" r="0.6" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5V11" />
      <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function PaperclipIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M11.5 7.25L6.8 11.95A2.5 2.5 0 0 1 3.25 8.4L8.55 3.1A1.65 1.65 0 0 1 10.9 5.45L5.6 10.75A0.85 0.85 0 0 1 4.4 9.55L9.1 4.85" />
    </Icon>
  )
}

export function SlashCommandIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.5 4.5L6.5 8L3.5 11.5" />
      <path d="M8.25 11.5H12.5" />
    </Icon>
  )
}

export function ReturnKeyIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12.5 4.5V8.5A1.5 1.5 0 0 1 11 10H4" />
      <path d="M6.5 7.5L4 10L6.5 12.5" />
    </Icon>
  )
}

export function SendArrowIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 12.5V3.5" />
      <path d="M4.25 7.25L8 3.5L11.75 7.25" />
    </Icon>
  )
}

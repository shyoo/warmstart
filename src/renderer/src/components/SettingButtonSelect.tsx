import React, { useEffect, useRef, useState } from 'react'

export interface SettingOption {
  value: string
  label: string
}

export interface SettingButtonSelectProps {
  value: string
  options: SettingOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  className?: string
  style?: React.CSSProperties
  editIcon?: React.ReactNode
}

/**
 * Encapsulated setting selector:
 * Shows the current value and an edit icon (✏️) in a rounded, darker button.
 * Clicking the button reveals the dropdown options menu for the user to choose an option.
 */
export function SettingButtonSelect({
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  className,
  style,
  editIcon = '✏️'
}: SettingButtonSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const currentOption = options.find((opt) => opt.value === value)
  const displayLabel = currentOption ? currentOption.label : value

  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      ref={wrapRef}
      className={`setting-btn-select-wrap ${className ?? ''}`}
      style={style}
    >
      <button
        type="button"
        className={`setting-btn-select ${open ? 'setting-btn-select--open' : ''}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev)
          }
        }}
      >
        <span className="setting-btn-select-value">{displayLabel}</span>
        <span className="setting-btn-select-icon" aria-hidden="true">
          {editIcon}
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="setting-btn-select-menu"
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`setting-btn-select-option ${isSelected ? 'setting-btn-select-option--selected' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (opt.value !== value) {
                    onChange(opt.value)
                  }
                }}
              >
                <span className="setting-btn-select-option-label">{opt.label}</span>
                {isSelected && <span className="setting-btn-select-check">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

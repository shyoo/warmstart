import { describe, expect, it } from 'vitest'
import { applicationMenuTemplate } from './applicationmenu.js'

describe('the native application menu', () => {
  it('keeps macOS application and Edit roles for standard clipboard shortcuts', () => {
    expect(applicationMenuTemplate('darwin')?.map((item) => item.role)).toEqual(['appMenu', 'editMenu'])
  })

  it('removes the unused menu on platforms whose window chrome supplies the controls', () => {
    expect(applicationMenuTemplate('win32')).toBeNull()
    expect(applicationMenuTemplate('linux')).toBeNull()
  })
})

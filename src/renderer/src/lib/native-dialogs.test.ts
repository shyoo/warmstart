import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const browserDialogs = new Set(['confirm', 'alert', 'prompt'])
const nativeMessages = new Set(['showMessageBox', 'showMessageBoxSync', 'showErrorBox'])
const globals = new Set(['window', 'globalThis', 'self'])

/** Parse code so comments, UI copy and hostile text fixtures cannot trigger the guard. */
function violations(code: string): string[] {
  const file = ts.createSourceFile('source.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && browserDialogs.has(node.expression.text)) {
      found.push(node.expression.text)
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null
      if (name && (nativeMessages.has(name) ||
        (browserDialogs.has(name) && ts.isIdentifier(node.expression) && globals.has(node.expression.text)))) found.push(name)
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
      ts.isIdentifier(node.initializer) && globals.has(node.initializer.text)) {
      for (const element of node.name.elements) {
        const name = (element.propertyName ?? element.name).getText(file).replace(/['"]/g, '')
        if (browserDialogs.has(name)) found.push(name)
      }
    }
    if (ts.isIdentifier(node) && nativeMessages.has(node.text)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...new Set(found)]
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? sources(path)
      : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name) ? [path] : []
  })
}

describe('desktop confirmations stay inside the app', () => {
  it('rejects browser dialogs, aliases and Electron message boxes', () => {
    for (const code of [
      'confirm("Delete?")', 'alert("Oops")', 'prompt("Name")',
      'window.confirm("Delete?")', 'globalThis["alert"]("Oops")',
      'const ask = window.confirm; ask("Delete?")', 'const { confirm: ask } = window;',
      'dialog.showMessageBox({})', 'dialog["showMessageBoxSync"]({})',
      'const { showErrorBox: report } = dialog;'
    ]) expect(violations(code), code).not.toEqual([])
    expect(violations('// window.confirm("x")\nconst prompt = "alert(1)"; dialog.showOpenDialog({})')).toEqual([])
  })

  it('has no native confirmation, alert or prompt API in desktop production source', () => {
    const root = resolve(import.meta.dirname, '../../..')
    const failures = ['main', 'preload', 'renderer'].flatMap((dir) => sources(resolve(root, dir)))
      .flatMap((path) => violations(readFileSync(path, 'utf8')).map((api) => `${relative(root, path)}: ${api}`))
    expect(failures).toEqual([])
  })
})

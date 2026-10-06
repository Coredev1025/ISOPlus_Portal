// Interactive prompts.
//
// node:readline/promises works the same in PowerShell, cmd, bash and zsh, so
// there is no platform-specific input handling here. Every prompt has a
// non-interactive equivalent flag — see `worktree new --help` — because CI and
// scripted runs have no TTY and must never hang waiting for input.

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export const isInteractive = () => Boolean(stdin.isTTY && stdout.isTTY)

async function withReadline(fn) {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await fn(rl)
  } finally {
    rl.close()
  }
}

/**
 * Free-text question.
 *
 * `validate` returns an error string to re-ask, or null/undefined to accept.
 */
export async function ask(question, { def = '', validate } = {}) {
  return withReadline(async (rl) => {
    for (;;) {
      const shown = def ? `${question} [${def}]: ` : `${question}: `
      const raw = (await rl.question(shown)).trim()
      const value = raw || def
      const error = validate?.(value)
      if (error) {
        console.log(`  ${error}`)
        continue
      }
      return value
    }
  })
}

/** Numbered single-choice list. `choices` is [{value, label, hint}]. */
export async function choose(question, choices, { def = 0 } = {}) {
  return withReadline(async (rl) => {
    console.log(`\n${question}`)
    choices.forEach((c, i) => {
      const marker = i === def ? '>' : ' '
      console.log(`  ${marker} ${i + 1}) ${c.label}${c.hint ? `  — ${c.hint}` : ''}`)
    })
    for (;;) {
      const raw = (await rl.question(`Choose 1-${choices.length} [${def + 1}]: `)).trim()
      if (!raw) return choices[def].value
      const index = Number(raw) - 1
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value
      console.log(`  Enter a number between 1 and ${choices.length}.`)
    }
  })
}

export async function confirm(question, { def = false } = {}) {
  return withReadline(async (rl) => {
    const hint = def ? 'Y/n' : 'y/N'
    const raw = (await rl.question(`${question} [${hint}] `)).trim()
    if (!raw) return def
    return /^y(es)?$/i.test(raw)
  })
}

// Console output.
//
// Colour is disabled when not writing to a TTY, when NO_COLOR is set, or on a
// legacy Windows console that does not understand ANSI escapes.

const useColor =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  !(process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM)

const wrap = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)

const dim = wrap('2')
const c = { cyan: wrap('36'), yellow: wrap('33'), red: wrap('31'), green: wrap('32') }

export const cyan = (msg) => console.log(`${c.cyan('==>')} ${msg}`)
export const green = (msg) => console.log(`${c.green('==>')} ${msg}`)
export const yellow = (msg) => console.warn(`${c.yellow('warning:')} ${msg}`)
export const red = (msg) => console.error(`${c.red('error:')} ${msg}`)
export const note = (msg) => console.log(`    ${dim(msg)}`)

export function table(rows) {
  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows) {
    console.log(`    ${label.padEnd(width)}  ${value}`)
  }
}

export function fail(message) {
  red(message)
  process.exit(1)
}

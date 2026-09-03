export const GREEN = '\u001b[32m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const RED = '\u001b[31m'
export const DIM = '\u001b[2m'
export const RESET = '\u001b[0m'

let quiet = false

/** Hook shells have no one watching, so --quiet silences everything except failures. */
export function setQuiet(value: boolean) {
  quiet = value
}

export function log(message: string) {
  if (!quiet) {
    console.log(message)
  }
}

export function ok(message: string) {
  log(`${GREEN}..${RESET} ${message}`)
}

export function step(message: string) {
  log(`${CYAN}..${RESET} ${message}`)
}

export function note(message: string) {
  log(`${DIM}   ${message}${RESET}`)
}

export function warn(message: string) {
  console.warn(`${YELLOW}!!${RESET} ${message}`)
}

export function fail(message: string): never {
  console.error(`${RED}!!${RESET} ${message}`)
  process.exit(1)
}

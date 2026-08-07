// Branch naming, derived from what the repository actually does.
//
// Observed on origin: feature/ (7), bugfix/ (10), hotfix/ (8), and snake_case
// descriptions outnumbering kebab-case 20 to 6. Ticket numbers appear nowhere,
// so requiring one is a NEW convention this tooling introduces rather than an
// existing rule it enforces.
//
// Generated names look like:
//
//   feature/ISO-412_time_tracking
//   bugfix/ISO-98_login_spinner
//
// The ticket keeps its own hyphen verbatim; the description is snake_case.

export const TYPES = [
  {
    value: 'feature',
    label: 'feature',
    hint: 'new functionality',
    base: 'develop',
  },
  {
    value: 'bugfix',
    label: 'bugfix',
    hint: 'a defect in develop, not yet in production',
    base: 'develop',
  },
  {
    value: 'hotfix',
    label: 'hotfix',
    hint: 'urgent fix for production — branches from main',
    base: 'main',
  },
]

export const TICKET_PATTERN = /^[A-Z][A-Z0-9]{1,5}-\d+$/

/** Accepts `iso-412`, normalises to `ISO-412`. */
export function normaliseTicket(input) {
  return input.trim().toUpperCase().replace(/\s+/g, '')
}

export function validateTicket(input) {
  const ticket = normaliseTicket(input)
  if (!ticket) return 'A ticket is required, e.g. ISO-412.'
  if (!TICKET_PATTERN.test(ticket)) {
    return `"${input}" is not a ticket reference. Expected PREFIX-NUMBER, e.g. ISO-412.`
  }
  return null
}

/** snake_case, matching the majority of existing branch names. */
export function snake(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

export function validateDescription(input) {
  const value = snake(input)
  if (!value) return 'A short description is required, e.g. "time tracking".'
  if (value.length < 3) return 'Too short — use a few words describing the work.'
  return null
}

export function composeBranch({ type, ticket, description }) {
  return `${type}/${normaliseTicket(ticket)}_${snake(description)}`
}

/** Default base ref for a branch type. Hotfixes come off production. */
export function defaultBase(type) {
  return TYPES.find((t) => t.value === type)?.base ?? 'develop'
}

/**
 * Pull the ticket back out of a branch name, for reuse in commit messages and
 * PR bodies. Returns null for branches created before this convention.
 */
export function ticketFromBranch(branch) {
  const match = /^[^/]+\/([A-Z][A-Z0-9]{1,5}-\d+)/.exec(branch ?? '')
  return match ? match[1] : null
}

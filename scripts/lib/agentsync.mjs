// Keeping agent tooling consistent across every assistant, not just one.
//
// Two separate problems, solved the same way — one source of truth, everything
// else a link to it.
//
// 1. INSTRUCTIONS. CLAUDE.md is the real file; AGENTS.md (the cross-tool
//    convention used by Codex, opencode, Cursor and others) is a symlink to it.
//    This one IS tracked by git, which matters on Windows — see checkAgentsMd.
//
// 2. SKILLS. Each assistant reads its own directory (.claude/skills,
//    .agents/skills, …). Copying between them lets them drift: this repo
//    already had isoplus-local-env in .claude/skills and nowhere else, so
//    Cursor and opencode never saw it. Instead every tool directory becomes a
//    symlink to one canonical directory, which means a skill installed by ANY
//    tool is immediately visible to ALL of them — no sync step to remember.
//
//    These directories are gitignored, so unlike AGENTS.md the symlinks are
//    purely local and never travel through a git checkout.

import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Real file holding the instructions, and the cross-tool alias for it. */
export const INSTRUCTIONS_REAL = 'CLAUDE.md'
export const INSTRUCTIONS_ALIAS = 'AGENTS.md'

/** The one true skills directory. Tool directories below all point here. */
export const CANONICAL_SKILLS = join('.agents', 'skills')

/**
 * Per-assistant skill directories to keep unified.
 *
 * Add a row when adopting a new assistant. Cursor is deliberately absent:
 * `.cursor/rules/*.mdc` is a different format, not a skills directory, and
 * pretending otherwise would silently produce files Cursor cannot read.
 */
export const TOOL_SKILL_DIRS = [
  { tool: 'Claude Code', dir: join('.claude', 'skills') },
  { tool: 'opencode', dir: join('.opencode', 'skill') },
]

/**
 * Windows without Developer Mode cannot create symlinks, so `git checkout`
 * writes the link's TARGET PATH into a regular file. AGENTS.md then contains
 * the literal text "CLAUDE.md" — 9 bytes where the instructions should be, and
 * every assistant reading it silently gets nothing.
 *
 * Detected by: a regular file that is not a symlink and whose content is short
 * enough to be a path rather than the instructions.
 */
export function checkAgentsMd(root) {
  const alias = join(root, INSTRUCTIONS_ALIAS)
  const real = join(root, INSTRUCTIONS_REAL)

  if (!existsSync(real)) return { state: 'missing-source' }
  if (!existsSync(alias)) return { state: 'absent' }

  const stat = lstatSync(alias)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(alias)
    return target === INSTRUCTIONS_REAL
      ? { state: 'ok' }
      : { state: 'wrong-target', detail: target }
  }

  const content = readFileSync(alias, 'utf8')
  if (content.trim() === INSTRUCTIONS_REAL) {
    return { state: 'broken-on-windows' }
  }
  return content === readFileSync(real, 'utf8')
    ? { state: 'copy-in-sync' }
    : { state: 'copy-diverged' }
}

/**
 * Repair the alias.
 *
 * Prefers a symlink; falls back to a copy where symlinks are unavailable,
 * because a correct copy beats a file containing the word "CLAUDE.md".
 */
export function repairAgentsMd(root) {
  const alias = join(root, INSTRUCTIONS_ALIAS)
  if (existsSync(alias) || lstatSafe(alias)) rmSync(alias, { force: true })
  try {
    symlinkSync(INSTRUCTIONS_REAL, alias, 'file')
    return 'symlink'
  } catch {
    cpSync(join(root, INSTRUCTIONS_REAL), alias)
    return 'copy'
  }
}

function lstatSafe(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

const isLinkTo = (path, expectedAbs) => {
  const stat = lstatSafe(path)
  if (!stat?.isSymbolicLink()) return false
  const target = readlinkSync(path)
  return resolve(join(path, '..'), target) === expectedAbs
}

export function listSkills(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort()
}

/** What each tool directory currently is, without changing anything. */
export function inspectSkills(root) {
  const canonicalAbs = resolve(root, CANONICAL_SKILLS)
  const canonical = listSkills(canonicalAbs)

  const tools = TOOL_SKILL_DIRS.map(({ tool, dir }) => {
    const abs = resolve(root, dir)
    const stat = lstatSafe(abs)
    if (!stat) return { tool, dir, state: 'absent', skills: [], missing: [], extra: [] }
    if (isLinkTo(abs, canonicalAbs)) return { tool, dir, state: 'linked', skills: canonical, missing: [], extra: [] }
    if (stat.isSymbolicLink()) return { tool, dir, state: 'linked-elsewhere', skills: listSkills(abs), missing: [], extra: [] }

    const skills = listSkills(abs)
    return {
      tool,
      dir,
      state: 'independent',
      skills,
      // Present here but not canonical — these would be LOST by a naive link,
      // so they must be adopted into canonical first.
      extra: skills.filter((s) => !canonical.includes(s)),
      missing: canonical.filter((s) => !skills.includes(s)),
    }
  })

  return { canonical, canonicalAbs, tools }
}

/**
 * Make every tool directory a link to canonical, adopting anything unique first.
 *
 * Order matters: adopt, then link. Linking first would delete skills that exist
 * only in one tool's directory.
 */
export function unifySkills(root, { dryRun = false } = {}) {
  const { canonicalAbs, tools } = inspectSkills(root)
  const actions = []

  if (!existsSync(canonicalAbs)) {
    actions.push({ kind: 'create-canonical', path: relative(root, canonicalAbs) })
    if (!dryRun) mkdirSync(canonicalAbs, { recursive: true })
  }

  for (const tool of tools) {
    if (tool.state === 'linked') continue

    for (const skill of tool.extra) {
      actions.push({ kind: 'adopt', tool: tool.tool, skill })
      if (!dryRun) {
        cpSync(join(root, tool.dir, skill), join(canonicalAbs, skill), {
          recursive: true,
          errorOnExist: false,
        })
      }
    }

    actions.push({ kind: 'link', tool: tool.tool, dir: tool.dir, state: tool.state })
    if (!dryRun) {
      const abs = resolve(root, tool.dir)
      mkdirSync(join(abs, '..'), { recursive: true })
      if (lstatSafe(abs)) rmSync(abs, { recursive: true, force: true })
      // 'junction' is what makes this work on Windows without Developer Mode;
      // it is ignored on POSIX, where a normal dir symlink is created.
      symlinkSync(canonicalAbs, abs, 'junction')
    }
  }

  return actions
}

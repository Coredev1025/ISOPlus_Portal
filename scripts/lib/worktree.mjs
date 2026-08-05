// Creating, listing and removing git worktrees with their own dev stack.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.error) throw res.error
  return { code: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

export function repoRoot(from = process.cwd()) {
  const { code, stdout } = git(['rev-parse', '--show-toplevel'], from)
  if (code !== 0) throw new Error('not inside a git repository')
  return resolve(stdout)
}

/**
 * The main clone, even when invoked from inside a linked worktree.
 *
 * `git rev-parse --git-common-dir` points at the shared .git directory, whose
 * parent is the original checkout — that is where Backend/.env lives and where
 * new worktrees are anchored.
 */
export function mainWorktree(from = process.cwd()) {
  const { code, stdout } = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], from)
  if (code !== 0) throw new Error('could not locate the main worktree')
  return resolve(stdout, '..')
}

/** Worktrees live beside the main clone, never inside it. */
export function worktreesDir(from = process.cwd()) {
  return join(resolve(mainWorktree(from), '..'), 'worktrees')
}

export function listWorktrees(from = process.cwd()) {
  const { stdout } = git(['worktree', 'list', '--porcelain'], from)
  const entries = []
  let current = {}
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current)
      current = { path: resolve(line.slice('worktree '.length)) }
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line === 'detached') {
      current.branch = '(detached)'
    }
  }
  if (current.path) entries.push(current)
  return entries
}

/**
 * A filesystem- and Docker-safe slug. Compose project names must be lowercase
 * alphanumeric with dashes, so `feature/ABC-123` becomes `feature-abc-123`.
 */
export function slugify(branch) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function ensureWorktreesDir(from = process.cwd()) {
  const dir = worktreesDir(from)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function branchExists(branch, from = process.cwd()) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], from).code === 0
}

export function remoteBranchExists(branch, from = process.cwd()) {
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], from).code === 0
}

export function worktreePathFor(branch, from = process.cwd()) {
  return join(worktreesDir(from), slugify(branch))
}

export function nameOf(path) {
  return basename(resolve(path))
}

// Docker Compose invocation and health gating.

import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { cyan, yellow } from './log.mjs'

export const INFRA_FILE = 'docker-compose.infra.yml'

// `docker` resolves to docker.exe on Windows without any special handling, but
// spawning through a shell would then need quoting rules that differ per
// platform. Always spawn the binary directly.
function run(args, { cwd, capture = false, input }) {
  if (capture) {
    const res = spawnSync('docker', args, { cwd, encoding: 'utf8' })
    if (res.error) throw res.error
    return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd,
      stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1 }))
    if (input) input.pipe(child.stdin)
  })
}

export function assertDockerAvailable() {
  const res = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  })
  if (res.error) {
    throw new Error(
      'docker was not found on PATH. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux).',
    )
  }
  if (res.status !== 0) {
    throw new Error(
      'the Docker daemon is not responding. Start Docker Desktop, or on Linux: sudo systemctl start docker',
    )
  }
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (compose.status !== 0) {
    throw new Error(
      'docker compose v2 is required (the `docker compose` subcommand, not the legacy `docker-compose` binary).',
    )
  }
}

/** Compose bound to the app stack (docker-compose.yml, per worktree). */
export const app = (root) => ({
  exec: (args, opts = {}) => run(['compose', ...args], { cwd: root, ...opts }),
  label: 'app',
})

/** Compose bound to the shared infra stack (one per machine). */
export const infra = (root) => ({
  exec: (args, opts = {}) =>
    run(['compose', '-f', INFRA_FILE, ...args], { cwd: root, ...opts }),
  label: 'infra',
})

export async function containerIds(stack) {
  const { code, stdout } = await stack.exec(['ps', '-q'], { capture: true })
  if (code !== 0) return []
  return stdout.split(/\r?\n/).filter(Boolean)
}

function inspect(ids, format) {
  const res = spawnSync('docker', ['inspect', '--format', format, ...ids], {
    encoding: 'utf8',
  })
  return (res.stdout ?? '').split(/\r?\n/).filter(Boolean)
}

/**
 * Block until every container in the stack is healthy.
 *
 * `docker compose up` exiting 0 proves only that containers were created — the
 * app inside may still be booting or crash-looping. Containers with no
 * healthcheck only need to be running. Always bounded: a crash-looping
 * container never becomes healthy, and hanging forever is worse than failing.
 */
export async function waitHealthy(stack, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastReport = 'no containers found'

  while (Date.now() < deadline) {
    const ids = await containerIds(stack)
    if (ids.length) {
      const lines = inspect(
        ids,
        '{{.Name}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      )
      const pending = lines
        .map((line) => line.split('\t'))
        .filter(([, status, health]) =>
          health === 'none' ? status !== 'running' : health !== 'healthy',
        )
        .map(([name, status, health]) =>
          `${name.replace(/^\//, '')} (${health === 'none' ? status : health})`,
        )

      if (!pending.length) return { ok: true }
      lastReport = pending.join(', ')
    }
    await sleep(3000)
  }
  return { ok: false, report: lastReport }
}

/**
 * A container can be Up (healthy) while publishing NO host port: the bind
 * silently lost a race with another publisher, leaving the service unreachable
 * from the host. Only --force-recreate fixes it, so it is worth detecting
 * explicitly rather than leaving the user to wonder why curl refuses.
 */
export async function unpublishedServices(stack) {
  const { code, stdout } = await stack.exec(
    ['ps', '--format', '{{.Service}}\t{{.Ports}}'],
    { capture: true },
  )
  if (code !== 0) return []
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, ports]) => !(ports ?? '').includes('->'))
    .map(([service]) => service)
}

export async function reportUnpublished(stack) {
  const missing = await unpublishedServices(stack)
  if (!missing.length) return true
  yellow(`running but publishing no host port: ${missing.join(', ')}`)
  cyan(`fix with: docker compose up -d --force-recreate ${missing.join(' ')}`)
  return false
}

// Host port probing.
//
// `ss`/`netstat`/`lsof` all differ across Linux, macOS and Windows, so we bind
// a socket instead: the OS itself is the authority on whether a port is free,
// and node:net behaves identically everywhere.

import net from 'node:net'

/**
 * Resolves true if nothing is listening on `port`.
 *
 * Binds 0.0.0.0 rather than 127.0.0.1 on purpose — Docker publishes on all
 * interfaces, so a container holding 0.0.0.0:3100 must count as a conflict even
 * though 127.0.0.1:3100 would still bind on some platforms.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '0.0.0.0')
  })
}

/**
 * First offset step (of `stride`) at which every port in `bases` is free.
 *
 * Ports are allocated in matched pairs so a worktree's frontend and backend
 * stay a predictable distance apart: 3110/4011, 3120/4021, and so on.
 */
export async function findFreePortSet(bases, { stride = 10, maxSteps = 40 } = {}) {
  for (let step = 0; step < maxSteps; step += 1) {
    const candidate = bases.map((base) => base + step * stride)
    const results = await Promise.all(candidate.map(isPortFree))
    if (results.every(Boolean)) return candidate
  }
  throw new Error(
    `no free port set found after ${maxSteps} attempts starting at ${bases.join(', ')}`,
  )
}

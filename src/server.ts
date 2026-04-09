// src/server.ts
import { spawn, type ChildProcess } from 'child_process'
import { AUTO_SERVER_PORT } from './constants'

export async function isServerRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return false
  }
}

export async function startServer(): Promise<{ url: string; process: ChildProcess | null }> {
  const url = `http://localhost:${AUTO_SERVER_PORT}`
  if (await isServerRunning(url)) return { url, process: null }

  console.log(`  Starting dev server on port ${AUTO_SERVER_PORT}...`)
  const proc = spawn('npx', ['vite', '--port', String(AUTO_SERVER_PORT)], {
    cwd: process.cwd(),
    stdio: 'pipe',
  })

  const start = Date.now()
  while (Date.now() - start < 15000) {
    if (await isServerRunning(url)) return { url, process: proc }
    await new Promise(r => setTimeout(r, 500))
  }
  proc.kill()
  throw new Error(`Dev server failed to start on port ${AUTO_SERVER_PORT}`)
}

// tests/cli.test.ts
import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

const OUT_DIR = join(__dirname, '../.test-audit')
const FIXTURE = `file://${join(__dirname, '../fixtures/sample-page.html')}`

describe('CLI integration', () => {
  it('capture produces fingerprint.yaml + full-page screenshot', () => {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true })
    execSync(`npx tsx src/cli.ts capture --url "${FIXTURE}" --out ${OUT_DIR}`, {
      cwd: join(__dirname, '..'),
      timeout: 30000,
    })
    expect(existsSync(join(OUT_DIR, 'fingerprint.yaml'))).toBe(true)
    expect(existsSync(join(OUT_DIR, 'full-page.png'))).toBe(true)

    const yaml = readFileSync(join(OUT_DIR, 'fingerprint.yaml'), 'utf-8')
    expect(yaml).toContain('version: 2')
    expect(yaml).toContain('role: banner')
  })

  it('capture with --state produces fingerprint-{state}.yaml', () => {
    execSync(`npx tsx src/cli.ts capture --url "${FIXTURE}" --out ${OUT_DIR} --state loaded`, {
      cwd: join(__dirname, '..'),
      timeout: 30000,
    })
    expect(existsSync(join(OUT_DIR, 'fingerprint-loaded.yaml'))).toBe(true)
  })

  it('verify against own baseline produces report', () => {
    try {
      execSync(`npx tsx src/cli.ts verify --url "${FIXTURE}" --baseline ${OUT_DIR}`, {
        cwd: join(__dirname, '..'),
        timeout: 30000,
      })
    } catch {
      // May exit non-zero on invariant checks — that's OK
    }
    expect(existsSync(join(OUT_DIR, 'report.json'))).toBe(true)
    const report = JSON.parse(readFileSync(join(OUT_DIR, 'report.json'), 'utf-8'))
    expect(report).toHaveProperty('pass')
    expect(report).toHaveProperty('failures')
  })
})

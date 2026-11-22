#!/usr/bin/env node
/**
 * Set or check the single release version.
 *
 * The version is stamped in two places so help output and
 * `window.__dshSplitPanels.health()` report the release:
 * - package.json `version`
 * - src/client.ts `PLUGIN_VERSION`
 *
 * Only plain SemVer `x.y.z` is accepted. Releases are cut by pushing the
 * matching annotated `vX.Y.Z` tag; `.github/workflows/release.yml` fails when
 * the tag and package.json disagree, and there is no date-counter version any
 * more.
 *
 * Usage:
 *   node scripts/set-version.mjs 1.0.1
 *   node scripts/set-version.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = join(ROOT, 'package.json')
const CLIENT = join(ROOT, 'src/client.ts')
const CLIENT_VERSION_RE = /(const PLUGIN_VERSION = ")([^"]*)(";)/

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function validate(version) {
  if (!SEMVER_RE.test(version)) throw new Error(`expected plain SemVer x.y.z, got ${version}`)
}

const check = process.argv.includes('--check')
const requested = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'))

if (check) {
  validate(String(pkg.version))
  const client = readFileSync(CLIENT, 'utf8')
  const match = CLIENT_VERSION_RE.exec(client)
  if (match === null) throw new Error('PLUGIN_VERSION constant not found in src/client.ts')
  if (match[2] !== pkg.version) {
    throw new Error(`package.json version ${pkg.version} and src/client.ts PLUGIN_VERSION ${match[2]} differ`)
  }
  console.log(`version ok: ${pkg.version}`)
  process.exit(0)
}
if (requested === undefined) {
  console.error('usage: node scripts/set-version.mjs <version> | --check')
  process.exit(1)
}
validate(requested)
pkg.version = requested
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`)
const client = readFileSync(CLIENT, 'utf8')
if (CLIENT_VERSION_RE.exec(client) === null) throw new Error('PLUGIN_VERSION constant not found in src/client.ts')
writeFileSync(CLIENT, client.replace(CLIENT_VERSION_RE, `$1${requested}$3`))
console.log(`version set: ${requested}`)

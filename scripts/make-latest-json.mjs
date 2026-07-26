// Builds the updater manifest from the artifacts a release build just produced.
//
// The manifest is what an installed Envy fetches to decide whether a newer
// version exists. It has to carry the *signature* of the exact file it points
// at, so writing it by hand means copying a base64 blob between files by eye —
// which is both tedious and the kind of thing that fails silently: a mismatched
// signature is rejected by the client with no clue as to why.
//
//   node scripts/make-latest-json.mjs [--notes "What changed"]
//
// Writes target/release/bundle/latest.json. Upload that alongside the installer
// on the GitHub release; the endpoint in tauri.conf.json points at
// releases/latest/download/latest.json, which GitHub resolves to whichever
// release is newest.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const version = conf.version
const bundle = join(root, 'target/release/bundle')

const notesFlag = process.argv.indexOf('--notes')
const notes = notesFlag > -1 ? process.argv[notesFlag + 1] : `Envy ${version}`

// The NSIS installer is what the updater consumes. The MSI is published too,
// for anyone deploying it centrally, but Tauri's Windows updater installs via
// NSIS and pointing it at the .msi would hand it a file it cannot apply.
const installer = `Envy_${version}_x64-setup.exe`
const exe = join(bundle, 'nsis', installer)
const sig = `${exe}.sig`

for (const p of [exe, sig]) {
  if (!existsSync(p)) {
    console.error(`missing: ${p}`)
    console.error(
      sig.endsWith('.sig') && !existsSync(sig)
        ? 'No signature — the build ran without TAURI_SIGNING_PRIVATE_KEY set, so this release cannot be updated to.'
        : 'Run `npm run tauri build` first.',
    )
    process.exit(1)
  }
}

const manifest = {
  version,
  notes,
  // Fixed at generation time rather than left to the reader: the updater
  // compares versions, not dates, so this is for humans reading the release.
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/skuthus/Envy-Windows/releases/download/v${version}/${installer}`,
    },
  },
}

const out = join(bundle, 'latest.json')
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${out}`)
console.log(`  version ${version} -> ${manifest.platforms['windows-x86_64'].url}`)

#!/usr/bin/env node
// Dependency-free sanity checks for the Alma Lab site.
// Usage: node scripts/check.mjs
import { readFileSync } from "node:fs"
import vm from "node:vm"

const html = readFileSync("index.html", "utf8")
let failed = false
const ok = (msg) => console.log(`OK  ${msg}`)
const fail = (msg) => {
  failed = true
  console.error(`FAIL  ${msg}`)
}

// 1. Inline <script> blocks parse cleanly.
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
blocks.forEach((block, i) => {
  try {
    new vm.Script(block[1], { filename: `index.html#inline-${i + 1}` })
    ok(`inline script block #${i + 1} parses`)
  } catch (error) {
    fail(`inline script block #${i + 1}: ${error.message}`)
  }
})

// 2. RU/EN locale keys stay in sync.
const start = html.indexOf("const copy = {")
const end = html.indexOf("let lang=")
if (start === -1 || end === -1 || end <= start) {
  fail("could not locate the `const copy = {…}` block in index.html")
} else {
  const copy = new Function(`${html.slice(start, end)}; return copy;`)()
  const ru = Object.keys(copy.ru ?? {})
  const en = Object.keys(copy.en ?? {})
  const missingInEn = ru.filter((k) => !(k in (copy.en ?? {})))
  const missingInRu = en.filter((k) => !(k in (copy.ru ?? {})))
  if (missingInEn.length) fail(`missing in en: ${missingInEn.join(", ")}`)
  else ok(`en locale complete (${en.length} keys)`)
  if (missingInRu.length) fail(`missing in ru: ${missingInRu.join(", ")}`)
  else ok(`ru locale complete (${ru.length} keys)`)

  const used = [
    ...html.matchAll(/data-i18n="([^"]+)"/g),
    ...html.matchAll(/data-i18n-html="([^"]+)"/g),
    ...html.matchAll(/data-i18n-placeholder="([^"]+)"/g),
  ].map((m) => m[1])
  const missing = [...new Set(used)].filter((k) => !(k in (copy.ru ?? {})) || !(k in (copy.en ?? {})))
  if (missing.length) fail(`used in markup but absent from copy: ${missing.join(", ")}`)
  else ok("all markup i18n keys present in copy")
}

// 3. Worker source parses as an ES module shape (basic syntax screen).
//    For a real check deploy and run /health, or `npx wrangler deploy --dry-run`.
const worker = readFileSync("worker/src/index.js", "utf8")
if (/export\s+default/.test(worker) && /fetch/.test(worker)) ok("worker/src/index.js looks like a valid Worker module")
else fail("worker/src/index.js does not look like a Worker module")

process.exit(failed ? 1 : 0)

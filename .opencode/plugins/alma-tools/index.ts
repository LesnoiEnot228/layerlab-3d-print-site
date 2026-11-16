import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8")

function checkI18n(root: string): string {
  const html = read(root, "index.html")
  const start = html.indexOf("const copy = {")
  const end = html.indexOf("let lang=")
  if (start === -1 || end === -1 || end <= start) {
    return "FAIL: could not locate the `const copy = {…}` block in index.html"
  }
  const snippet = html.slice(start, end)
  // The snippet only declares the `copy` object and Object.assign() calls on it.
  const copy = new Function(`${snippet}; return copy;`)() as Record<string, Record<string, string>>
  const ru = new Set(Object.keys(copy.ru ?? {}))
  const en = new Set(Object.keys(copy.en ?? {}))
  const missingInEn = [...ru].filter((k) => !en.has(k)).sort()
  const missingInRu = [...en].filter((k) => !ru.has(k)).sort()

  const used = {
    i18n: [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
    html: [...html.matchAll(/data-i18n-html="([^"]+)"/g)].map((m) => m[1]),
    placeholder: [...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map((m) => m[1]),
  }
  const missingKeys = [...new Set([...used.i18n, ...used.html, ...used.placeholder])]
    .filter((k) => !ru.has(k) || !en.has(k))
    .sort()

  const lines = [
    `copy.ru keys: ${ru.size}, copy.en keys: ${en.size}`,
    missingInEn.length ? `missing in en: ${missingInEn.join(", ")}` : "en: complete",
    missingInRu.length ? `missing in ru: ${missingInRu.join(", ")}` : "ru: complete",
    missingKeys.length
      ? `used in markup but absent from copy: ${missingKeys.join(", ")}`
      : "all markup keys present in copy",
  ]
  const ok = !missingInEn.length && !missingInRu.length && !missingKeys.length
  return `${ok ? "OK" : "FAIL"}\n${lines.join("\n")}`
}

function checkInlineJs(root: string): string {
  const html = read(root, "index.html")
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  if (!blocks.length) return "FAIL: no inline <script> blocks found"
  const errors: string[] = []
  blocks.forEach((block, i) => {
    try {
      new vm.Script(block[1], { filename: `index.html#inline-${i + 1}` })
    } catch (error) {
      errors.push(`block #${i + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return errors.length ? `FAIL\n${errors.join("\n")}` : `OK: ${blocks.length} inline <script> block(s) parse cleanly`
}

async function workerHealth(root: string): Promise<string> {
  const config = read(root, "assets/config.js")
  const match = config.match(/orderApiUrl:\s*["']([^"']+)["']/)
  if (!match) return "FAIL: orderApiUrl not found in assets/config.js"
  const health = new URL("/health", new URL(match[1]).origin).toString()
  try {
    const response = await fetch(health, { signal: AbortSignal.timeout(10_000) })
    const body = (await response.text()).slice(0, 500)
    return `GET ${health}\nHTTP ${response.status}\n${body}`
  } catch (error) {
    return `FAIL: GET ${health} — ${error instanceof Error ? error.message : String(error)}`
  }
}

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const

export default Plugin.define({
  id: "alma-tools",
  async setup(ctx) {
    const root = ctx.location.directory
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "alma", description: "Read-only checks for the Alma Lab site" })
      editor.add({
        name: "i18n_check",
        description:
          "Compare RU/EN keys in the `copy` object in index.html and verify every data-i18n/data-i18n-html/data-i18n-placeholder key used in markup exists in both locales. Read-only.",
        input: emptyInput,
        execute: async () => ({ content: checkI18n(root) }),
      })
      editor.add({
        name: "inline_js_check",
        description:
          "Syntax-check every inline <script> block in index.html (without executing it). Run this after editing the page's inline JavaScript. Read-only.",
        input: emptyInput,
        execute: async () => ({ content: checkInlineJs(root) }),
      })
      editor.add({
        name: "worker_health",
        description:
          "GET the Cloudflare Worker /health endpoint derived from assets/config.js and report HTTP status and body. Performs no order submission. Read-only.",
        input: emptyInput,
        execute: async () => ({ content: await workerHealth(root) }),
      })
    })
  },
})

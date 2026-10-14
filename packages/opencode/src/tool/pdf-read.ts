import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as Tool from "./tool"

const exec = promisify(execFile)
const MAX_BYTES = 25 * 1024 * 1024
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_PAGES = 50
const MAX_TEXT = 250_000

type Result = {
  status: "ok" | "partial" | "needs_ocr"
  source: string
  page_count: number
  pages: { page: number; text: string }[]
  text: string
  warnings: string[]
  extraction: { engine: "poppler"; ocr_used: false }
}

async function safePath(file: string) {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) throw new Error("path required")
  const root = await fs.realpath(process.env.PDF_READ_ROOT || process.env.WORK_DIR || process.cwd())
  const rootStat = await fs.stat(root)
  if (!rootStat.isDirectory()) throw new Error("PDF root is not a directory")
  const target = await fs.realpath(path.resolve(root, file))
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("path outside allowed root")
  const s = await fs.stat(target)
  if (!s.isFile() || s.size > MAX_BYTES) throw new Error("not a regular PDF or exceeds 25 MiB")
  const fh = await fs.open(target, "r")
  try {
    const b = Buffer.alloc(1024)
    const n = await fh.read(b, 0, b.length, 0)
    if (!b.subarray(0, n.bytesRead).includes(Buffer.from("%PDF-"))) throw new Error("not a PDF")
  } finally {
    await fh.close()
  }
  return target
}

async function call(command: string, args: string[]) {
  try {
    return (await exec(command, args, { timeout: 30000, maxBuffer: MAX_BUFFER, encoding: "utf8" })).stdout
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string }
    if (err.code === "ENOENT") throw new Error(`Missing ${command}: install poppler-utils`)
    throw new Error(`${command} failed: ${String(err.stderr || err.message).slice(0, 250)}`)
  }
}

async function readPdf(input: { path: string; start_page?: number; end_page?: number; max_pages?: number }) {
  const source = await safePath(input.path)
  const info = await call("pdfinfo", [source])
  const found = /^Pages:\s*(\d+)\s*$/m.exec(info)
  if (!found) throw new Error("Cannot read PDF page count")
  const page_count = Number(found[1])
  const start_page = input.start_page ?? 1
  const end_page = input.end_page
  const max_pages = input.max_pages ?? MAX_PAGES
  for (const [k, v] of Object.entries({ start_page, end_page, max_pages })) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1)) throw new Error(`${k} must be positive integer`)
  }
  if (max_pages > MAX_PAGES || start_page > page_count || (end_page !== undefined && (end_page < start_page || end_page > page_count))) {
    throw new Error("Invalid page range")
  }
  const requestedEnd = end_page ?? page_count
  const last = Math.min(requestedEnd, start_page + max_pages - 1)
  const pages: { page: number; text: string }[] = []
  let size = 0
  let clipped = false
  for (let p = start_page; p <= last; p++) {
    const raw = await call("pdftotext", ["-f", String(p), "-l", String(p), "-enc", "UTF-8", source, "-"])
    const normalized = raw.replace(/\f+$/, "").trim()
    const remaining = MAX_TEXT - size
    if (normalized.length > remaining) {
      pages.push({ page: p, text: normalized.slice(0, remaining) })
      clipped = true
      break
    }
    pages.push({ page: p, text: normalized })
    size += normalized.length
  }
  const hasText = pages.some((p) => p.text.length)
  const partial = clipped || last < requestedEnd
  const warnings: string[] = []
  if (!hasText) warnings.push("No selectable text on selected pages; OCR may be required")
  if (partial) warnings.push("Page or text extraction limit reached")
  return {
    status: !hasText ? "needs_ocr" : partial ? "partial" : "ok",
    source,
    page_count,
    pages,
    text: pages.map((p) => p.text).join("\n\n"),
    warnings,
    extraction: { engine: "poppler", ocr_used: false },
  } satisfies Result
}

export const Parameters = Schema.Struct({
  path: Schema.String,
  start_page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  end_page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  max_pages: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
})

export const PdfReadTool = Tool.define(
  "pdf_read",
  Effect.gen(function* () {
    return {
      description:
        "Чтение PDF с текстовым слоем, страницы и текст через Poppler, без LLM/OCR. Скан возвращает needs_ocr. Разрешён только локальный PDF_READ_ROOT или WORK_DIR.",
      parameters: Parameters,
      execute: (params) =>
        Effect.promise(async () => {
          const result = await readPdf(params as any)
          return {
            title: `pdf_read ${result.source}`,
            metadata: { status: result.status, pages: result.pages.length },
            output: JSON.stringify(result, null, 2),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, {}>
  }),
)

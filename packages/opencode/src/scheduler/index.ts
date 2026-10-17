export type Job = {
  id: string
  schedule: string // cron 5 fields
  command: string
  workdir?: string
  timeoutSeconds?: number
}

export function cronToCalendar(cron: string): Array<Record<string, number>> {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("cron must have 5 fields")
  const [min, hour, day, month, weekday] = parts
  const expand = (field: string, max: number): number[] => {
    if (field === "*") return []
    const out: number[] = []
    for (const chunk of field.split(",")) {
      if (chunk.includes("-")) {
        const [a, b] = chunk.split("-").map(Number)
        for (let i = a; i <= b; i++) out.push(i)
      } else if (chunk.includes("/")) {
        const [base, step] = chunk.split("/")
        const start = base === "*" ? 0 : Number(base)
        for (let i = start; i <= max; i += Number(step)) out.push(i)
      } else {
        out.push(Number(chunk))
      }
    }
    return out
  }
  const mins = expand(min, 59)
  const hours = expand(hour, 23)
  const days = expand(day, 31)
  const months = expand(month, 12)
  const wdays = expand(weekday, 7).map((d) => (d === 7 ? 0 : d))
  const result: Array<Record<string, number>> = []
  const combos = (arrs: number[][]) => {
    if (arrs.length === 0) return [[]]
    const [head, ...rest] = arrs
    const r = combos(rest)
    const values = head.length ? head : [undefined as any]
    const out: number[][] = []
    for (const v of values) for (const c of r) out.push([v, ...c])
    return out
  }
  const fields = [mins, hours, days, months, wdays]
  const nonEmpty = fields.map((f) => (f.length ? f : [undefined])) as number[][]
  for (const combo of combos(nonEmpty)) {
    const entry: Record<string, number> = {}
    if (combo[0] !== undefined) entry.Minute = combo[0]
    if (combo[1] !== undefined) entry.Hour = combo[1]
    if (combo[2] !== undefined) entry.Day = combo[2]
    if (combo[3] !== undefined) entry.Month = combo[3]
    if (combo[4] !== undefined) entry.Weekday = combo[4]
    result.push(entry)
  }
  return result
}

export function generateLaunchdPlist(job: Job, uid: number): string {
  const calendars = cronToCalendar(job.schedule)
  const calXml = calendars
    .map((c) => {
      const keys = Object.keys(c)
        .map((k) => `      <key>${k}</key>\n      <integer>${c[k]}</integer>`)
        .join("\n")
      return `    <dict>\n${keys}\n    </dict>`
    })
    .join("\n")
  const label = `com.opencode.job.default.${job.id}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${job.command}</string>
  </array>
  ${job.workdir ? `<key>WorkingDirectory</key>\n  <string>${job.workdir}</string>` : ""}
  <key>StartCalendarInterval</key>
  <array>
${calXml}
  </array>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`
}

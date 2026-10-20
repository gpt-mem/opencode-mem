import { serveWorker, Transfer, type Method } from "./worker-rpc"

// The worker end of `worker-rpc.test.ts`, run in a Bun worker.

/** The methods the test calls, each recording that it ran. */
export type FixtureMethods = {
  readonly echo: Method<string, string>
  readonly sleep: Method<number, undefined>
  /** Holds the worker without yielding until the caller releases it after cancelling. */
  readonly spin: Method<{ port: MessagePort; release: Int32Array }, ArrayBuffer>
  /** Runs until its caller aborts it. */
  readonly hold: Method<MessagePort, undefined>
  /** Returns a bitmap only after the caller explicitly releases the handler. */
  readonly paint: Method<MessagePort, ImageBitmap>
  readonly log: Method<
    undefined,
    { readonly ran: readonly string[]; readonly aborted: readonly string[]; readonly closed: number }
  >
}

type Log = { ran: string[]; aborted: string[]; closed: number }

const log: Log = { ran: [], aborted: [], closed: 0 }

// Bun's workers have no ImageBitmap. This stand-in counts the bitmaps the server closes; it cannot be posted.
class StandInBitmap {
  close() {
    log.closed += 1
  }
}

Object.assign(globalThis, { ImageBitmap: StandInBitmap })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

serveWorker<FixtureMethods>({
  echo: (input) => {
    log.ran.push(`echo:${input}`)

    return input
  },
  sleep: async (input) => {
    log.ran.push("sleep")
    await sleep(input)

    return undefined
  },
  spin: (input) => {
    log.ran.push("spin")

    input.port.postMessage("started")
    // Block message delivery until cancellation is queued in the parent. The reply must cross it.
    Atomics.wait(input.release, 0, 0)
    input.port.close()

    const buffer = new ArrayBuffer(8)

    return new Transfer(buffer, [buffer])
  },
  hold: (port, signal) => {
    log.ran.push("hold")
    port.postMessage("started")
    port.close()

    return new Promise((resolve) =>
      signal.addEventListener("abort", () => {
        log.aborted.push("hold")
        resolve(undefined)
      }),
    )
  },
  paint: async (input, signal) => {
    log.ran.push("paint")
    await Promise.all([
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      new Promise<void>((resolve) => {
        input.onmessage = () => resolve()
        input.postMessage("started")
      }),
    ])
    input.close()

    const bitmap = new ImageBitmap()

    return new Transfer(bitmap, [bitmap])
  },
  log: () => log,
})

import fs from "node:fs/promises"
import path from "node:path"
import { startFakeLlm } from "./fake-llm"
import { CONTENT, directory, FILE, home, PASSWORD, PORT, REPLY, root, serverURL } from "./fixture"

// Starts the compiled server with a scripted model behind it. The server serves the app build it embeds from
// its own origin, so the browser talks to the same API a user's server answers.
const binary = compiledBinary()

if (!(await Bun.file(binary).exists())) {
  throw new Error(
    `The compiled CLI is missing at ${binary}. Run \`bun run script/build.ts --single --skip-install\` in packages/cli first.`,
  )
}

await fs.rm(root, { recursive: true, force: true })

await fs.mkdir(directory, { recursive: true })

await fs.mkdir(home, { recursive: true })

const llm = startFakeLlm({ file: FILE, content: CONTENT, reply: REPLY })

await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify(config(llm.url)))

await fs.writeFile(path.join(root, "models.json"), "{}")

// The server runs in the workspace, so the location it owns is the one the session writes into.
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  cwd: directory,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_CONFIG: path.join(root, "opencode.json"),
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_PASSWORD: PASSWORD,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  },
  stdout: "inherit",
  stderr: "inherit",
})

process.on("SIGTERM", () => child.kill())

process.on("SIGINT", () => child.kill())

await waitForServer()

const exited = await child.exited

await llm.stop()

process.exit(exited)

function compiledBinary() {
  const platform = process.platform === "win32" ? "windows" : process.platform

  return path.join(
    import.meta.dir,
    "../../../cli/dist",
    `cli-${platform}-${process.arch}`,
    "bin",
    `opencode${platform === "windows" ? ".exe" : ""}`,
  )
}

// A provider that speaks the OpenAI-compatible protocol, so the server drives the same client a real model does.
function config(baseURL: string) {
  return {
    update: "disable",
    model: "test/test-model",
    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    providers: {
      test: {
        name: "Test",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "test-key", baseURL },
        models: {
          "test-model": {
            name: "Test Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: { input: 0, output: 0 },
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    },
  }
}

async function waitForServer() {
  const headers = { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}` }

  for (let attempt = 0; attempt < 600; attempt++) {
    const response = await fetch(new URL("/api/info", serverURL), {
      headers,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)

    if (response?.status === 200) return

    await Bun.sleep(100)
  }

  throw new Error("The real server did not answer on its own port")
}

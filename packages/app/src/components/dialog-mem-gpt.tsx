import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

const PROVIDER_ID = "mem-gpt"
const MCP_URL = "https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp"
const MODELS = ["build", "build advanced", "plan", "explore", "general", "review", "conversation", "research", "doctor", "free"]

export function MemGPTConnectForm() {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [key, setKey] = createSignal("")
  const [enableMcp, setEnableMcp] = createSignal(true)

  const mutation = useMutation(() => ({
    mutationFn: async () => {
      const token = key().trim()
      if (!token) throw new Error(language.t("provider.connect.apiKey.required"))
      if ((await serverSDK().protocol) !== "v1") throw new Error(language.t("provider.custom.unavailable"))

      const current = serverSync().data.config
      const mcp = { ...current.mcp }
      if (enableMcp()) {
        mcp["mem-gpt"] = {
          type: "remote",
          url: MCP_URL,
          oauth: false,
          authProviderID: PROVIDER_ID,
          timeout: 60_000,
        }
      } else delete mcp["mem-gpt"]

      await serverSDK().client.auth.set({
        providerID: PROVIDER_ID,
        auth: { type: "api", key: token },
      })
      await serverSync().updateConfig({
        provider: {
          ...current.provider,
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mem-GPT",
            options: { baseURL: "https://llm-ladder.trainedassist.store/v1" },
            models: Object.fromEntries(MODELS.map((id) => [id, { name: id }])) as Record<string, { name: string }>,
          },
        },
        mcp,
        model: `${PROVIDER_ID}/build`,
        small_model: `${PROVIDER_ID}/explore`,
        disabled_providers: (current.disabled_providers ?? []).filter((id) => id !== PROVIDER_ID),
      })
    },
    onSuccess: () => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
          title: language.t("provider.connect.toast.connected.title", { provider: "Mem-GPT" }),
          description: language.t("provider.connect.toast.connected.description", { provider: "Mem-GPT" }),
      })
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  return (
    <form
      class="flex flex-col gap-5 overflow-y-auto px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate()
      }}
    >
      <div class="text-14-regular text-text-base">
        {language.t("provider.connect.apiKey.description", { provider: "Mem-GPT" })}
      </div>
      <TextField
        type="password"
        autofocus
        label={language.t("provider.connect.apiKey.label", { provider: "Mem-GPT" })}
        placeholder={language.t("provider.connect.apiKey.placeholder")}
        value={key()}
        onChange={setKey}
      />
      <label class="flex items-start gap-2 text-14-regular text-text-base">
        <input type="checkbox" checked={enableMcp()} onChange={(event) => setEnableMcp(event.currentTarget.checked)} />
        <span>{language.t("common.connect")} MCP</span>
      </label>
      <Button type="submit" disabled={mutation.isPending} class="self-end">
        {mutation.isPending ? language.t("common.loading") : language.t("common.connect")}
      </Button>
    </form>
  )
}

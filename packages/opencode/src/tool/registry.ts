export * as ToolRegistry from "@opencode-ai/core/tool/registry"

import { ProviderV2 } from "@opencode-ai/core/provider"

export function webSearchEnabled(providerID: any, flags = { exa: false, parallel: false }) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel
  )
}

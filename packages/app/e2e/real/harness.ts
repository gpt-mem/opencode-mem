import { type Page } from "@playwright/test"
import { draftHref, seed } from "../utils/app"
import { directory, DRAFT, PASSWORD, serverURL } from "./fixture"

// Opens the app on a draft of the real server. The server credentials and the draft tab are seeded the way
// the app stores them, so the app talks to the server the harness started.
export async function openDraft(page: Page) {
  await seed(page, {
    storage: {
      "opencode.global.dat:server": { list: [{ type: "http", http: { url: serverURL, password: PASSWORD } }] },
    },
    tabs: [{ draft: DRAFT, directory, server: serverURL }],
  })

  await page.goto(draftHref(DRAFT))
}

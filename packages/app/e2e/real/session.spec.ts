import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { CONTENT, directory, FILE, REPLY } from "./fixture"
import { openDraft } from "./harness"

test("the app runs a prompt against the real server and shows what the model did", async ({ page }) => {
  await openDraft(page)

  const editor = page.locator('[data-component="composer-editor"]')

  await expect(editor).toBeEditable()

  // The composer only shows its model once the location's agents and models are loaded. The send needs the
  // agent that model belongs to, so the control is the readiness signal for the prompt.
  await expect(page.locator('[data-action="composer-model"]')).toBeVisible()

  // The file the model writes must not exist before the prompt, so the read below proves the run wrote it.
  await fs.rm(path.join(directory, FILE), { force: true })

  await editor.fill("Write note.txt")
  await editor.press("Enter")

  await expect(page.locator('[data-component="user-message"] [data-slot="user-message-text"]')).toHaveText(
    "Write note.txt",
  )
  // The turn groups the tools it ran, and the group names them.
  await expect(page.locator('[data-component="context-tool-group-trigger"]')).toHaveAttribute(
    "aria-label",
    "Used 1 Write",
  )
  await expect(page.locator('[data-component="text-part"]').filter({ hasText: REPLY })).toBeVisible()

  expect(await fs.readFile(path.join(directory, FILE), "utf8")).toBe(CONTENT)
})

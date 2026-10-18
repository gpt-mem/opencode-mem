export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  inline_lines: PositiveInt.pipe(Schema.optional),
  inline_bytes: PositiveInt.pipe(Schema.optional),
  preview_lines: PositiveInt.pipe(Schema.optional),
  preview_bytes: PositiveInt.pipe(Schema.optional),
  max_lines: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
}) {}

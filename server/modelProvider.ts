/** Provider routing helpers shared by sessions, models API, and the UI. */

export type ModelProvider = "claude" | "cursor" | "openai";

/** Cursor models are stored as `cursor:<id>` so they never collide with Claude IDs. */
export const CURSOR_MODEL_PREFIX = "cursor:";

export function getModelProvider(model: string): ModelProvider {
  if (model.startsWith(CURSOR_MODEL_PREFIX)) return "cursor";
  if (model.startsWith("claude-")) return "claude";
  return "openai";
}

export function isCursorModel(model: string): boolean {
  return getModelProvider(model) === "cursor";
}

export function isClaudeModel(model: string): boolean {
  return getModelProvider(model) === "claude";
}

export function isOpenAIModel(model: string): boolean {
  return getModelProvider(model) === "openai";
}

/** Strip the `cursor:` prefix for the cursor-agent CLI `--model` flag. */
export function cursorNativeModelId(model: string): string {
  return model.startsWith(CURSOR_MODEL_PREFIX)
    ? model.slice(CURSOR_MODEL_PREFIX.length)
    : model;
}

export function toCursorModelId(nativeId: string): string {
  return nativeId.startsWith(CURSOR_MODEL_PREFIX)
    ? nativeId
    : `${CURSOR_MODEL_PREFIX}${nativeId}`;
}

export interface ProviderModel {
  id: string;
  label: string;
  provider: ModelProvider;
  contextWindow?: number;
}

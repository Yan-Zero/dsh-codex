/** Image-generation routes accepted by the current Codex subscription backend. */

export const OPENAI_CODEX_IMAGE_MODELS = [
  { id: "gpt-image-2", name: "GPT Image 2 (Codex default)" },
  { id: "gpt-image-2.5", name: "GPT Image 2.5" },
  { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst" },
  { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare" },
] as const;

export type OpenAICodexImageModel =
  (typeof OPENAI_CODEX_IMAGE_MODELS)[number]["id"];

/** Follow the model hard-coded by the current official Codex image extension. */
export const DEFAULT_OPENAI_CODEX_IMAGE_MODEL: OpenAICodexImageModel =
  "gpt-image-2";

/** Validate a browser, TUI, or configuration value against tested routes. */
export function isOpenAICodexImageModel(
  value: unknown
): value is OpenAICodexImageModel {
  return (
    typeof value === "string" &&
    OPENAI_CODEX_IMAGE_MODELS.some((model) => model.id === value)
  );
}

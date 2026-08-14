import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Require the current conversation model to accept the image block a tool returns. */
export async function assertImageCapable(
  ctx: Context,
  exec: ToolExecution,
  action: string,
): Promise<void> {
  const configured = exec.agent?.session.requestHeader()?.config
  const provider = configured?.provider ?? exec.agent?.options.provider
  const model = configured?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) {
    throw new Error(`cannot ${action}: the current model route is unavailable`)
  }
  const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`cannot ${action}: model "${model}" does not declare image input`)
  }
}

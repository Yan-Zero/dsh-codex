/** Shared image-input capability guard for portable tools. */

import type { ToolExecutionContext } from '@dsh-std/tool'

/** Reject image-producing tool work before bytes enter a text-only model's history. */
export function assertImageCapable(
  context: ToolExecutionContext,
  action: string,
): void {
  if (context.model === undefined) {
    throw new Error(`cannot ${action}: the current model route is unavailable`)
  }
  if (!context.model.inputModalities?.includes('image')) {
    throw new Error(`cannot ${action}: model ${JSON.stringify(context.model.model)} does not declare image input`)
  }
}

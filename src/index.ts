/** Ordinary DSH node half. Portable Host work is loaded from ./standard. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-codex'
export const inject: readonly string[] = []
export function apply(_ctx: Context): void {}

export default { name, inject, apply }

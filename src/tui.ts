/** Optional dsh-tui completion adapter for the standard Codex command. */

import type { Context } from '@deepseek-ai/cordis'

interface TuiMarkerRuntime {}

interface TuiSubcommandNode {
  name: string
  aliases?: readonly string[]
  description: string
  descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
  tag?: string
}

interface TuiCommandTreeRuntime {
  register(provider: {
    root: string
    descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
    children(canonicalPath: readonly string[]): readonly TuiSubcommandNode[]
  }): () => void
}

interface TuiContext extends Context { tuiCommandTrees: TuiCommandTreeRuntime }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Empty marker published while the Codex terminal completion adapter is active. */
    openAICodexTui: object
  }
}

export const name = 'dsh-codex-tui'
export const inject: readonly string[] = []

function translatedNode(name: string, en: string, zh: string): TuiSubcommandNode {
  return { name, description: en, descriptions: { en, zh } }
}

const CODEX_ACTIONS: readonly TuiSubcommandNode[] = [
  translatedNode('status', 'Show the ChatGPT sign-in state', '查看 ChatGPT 登录状态'),
  translatedNode('login', 'Sign in with ChatGPT', '登录 ChatGPT'),
  translatedNode('logout', 'Remove the dsh Codex credential', '移除 dsh Codex 登录凭据'),
  translatedNode('usage', 'Show current Codex usage limits', '查看当前 Codex 用量限制'),
  translatedNode('config', 'Show live Codex settings', '查看 Codex 实时配置'),
  translatedNode('set', 'Change one live Codex setting', '修改一项 Codex 实时配置'),
]

const CODEX_SETTINGS: readonly TuiSubcommandNode[] = [
  translatedNode('read-image', 'Enhance read_image with HTTP(S) input', '为 read_image 增加 HTTP(S) 图片输入'),
  translatedNode('imagegen-other-models', 'Allow other vision models to call imagegen', '允许其他视觉模型调用 imagegen'),
  translatedNode('websocket-context', 'Reuse Codex WebSocket response context', '复用 Codex WebSocket 响应上下文'),
  translatedNode('native-compaction', 'Use Codex V2 Responses compaction', '使用 Codex V2 Responses 压缩'),
]

const CODEX_LOGIN_METHODS: readonly TuiSubcommandNode[] = [
  translatedNode('browser', 'Sign in with a browser authorization page', '通过浏览器授权页面登录'),
  translatedNode('device', 'Sign in with a device code', '通过设备码登录'),
]

const BOOLEAN_VALUES: readonly TuiSubcommandNode[] = [
  translatedNode('on', 'Enable this setting', '启用此设置'),
  translatedNode('off', 'Disable this setting', '关闭此设置'),
]

function codexSubcommands(path: readonly string[]): readonly TuiSubcommandNode[] {
  if (path.length === 1 && path[0] === 'codex') return CODEX_ACTIONS
  if (path.length === 2 && path[0] === 'codex' && path[1] === 'login') return CODEX_LOGIN_METHODS
  if (path.length === 2 && path[0] === 'codex' && path[1] === 'set') return CODEX_SETTINGS
  if (path.length === 3 && path[0] === 'codex' && path[1] === 'set'
    && CODEX_SETTINGS.some(setting => setting.name === path[2])) return BOOLEAN_VALUES
  return []
}

export function apply(ctx: Context): void {
  ctx.inject(['tuiCommandTrees'], registerTuiCommandTree)
}

function registerTuiCommandTree(ctx: Context): void {
  const tui = ctx as TuiContext
  const disposeTree = tui.tuiCommandTrees.register({
    root: 'codex',
    descriptions: {
      en: 'Manage the OpenAI Codex account and provider settings',
      zh: '管理 OpenAI Codex 账号与提供方设置',
    },
    children: codexSubcommands,
  })
  ctx.provide('openAICodexTui', {} as TuiMarkerRuntime)
  ctx.effect(() => disposeTree, 'OpenAI Codex TUI completion adapter')
}

export default apply

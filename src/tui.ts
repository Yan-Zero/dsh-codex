/** dsh-tui local-module scene for the portable Codex provider. */

import type React from 'react'

export const TUI_API_VERSION = 'x-ccch1mneyyy.tui/v1alpha1'
export const TUI_SCENE_KIND = 'Scene'
export const OPENAI_CODEX_TUI_SCENE = 'openai_codex'

type TuiElement = React.ComponentType<Record<string, unknown>>

interface TuiKey {
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly return?: boolean
  readonly escape?: boolean
}

interface TuiSceneProps {
  readonly React: typeof React
  readonly ui: {
    readonly Box: TuiElement
    readonly Text: TuiElement
    readonly useInput: (
      handler: (input: string, key: TuiKey) => void,
      options?: { readonly isActive?: boolean },
    ) => void
  }
  readonly channel: {
    runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  }
  close(): void
}

interface CodexTuiSnapshot {
  readonly status: string
  readonly usage: string
  readonly preferences: Readonly<Record<PreferenceName, boolean>>
}

type PreferenceName = 'read-image' | 'imagegen-other-models' | 'websocket-context' | 'native-compaction'

const PREFERENCES: readonly { readonly name: PreferenceName; readonly label: string }[] = [
  { name: 'read-image', label: 'Enhance read_image for HTTP(S) images' },
  { name: 'imagegen-other-models', label: 'Allow other vision models to use imagegen' },
  { name: 'websocket-context', label: 'Reuse the Responses WebSocket context' },
  { name: 'native-compaction', label: 'Use native Responses compaction' },
]

const ACTIONS = ['Browser sign in', 'Device-code sign in', 'Sign out', 'Refresh'] as const

function configSnapshot(text: string): Readonly<Record<PreferenceName, boolean>> {
  const values = new Map(text.split(/\r?\n/u).map(line => line.split(': ', 2) as [string, string]))
  const read = (name: PreferenceName): boolean => {
    const value = values.get(name)
    if (value !== 'on' && value !== 'off') throw new Error(`OpenAI Codex returned an invalid ${name} setting`)
    return value === 'on'
  }
  return Object.freeze({
    'read-image': read('read-image'),
    'imagegen-other-models': read('imagegen-other-models'),
    'websocket-context': read('websocket-context'),
    'native-compaction': read('native-compaction'),
  })
}

async function command(props: TuiSceneProps, rawInput: string): Promise<string> {
  const result = await props.channel.runExternalCommand('codex', rawInput)
  if (result === undefined) throw new Error('The /codex command is unavailable in this session')
  return result
}

async function loadSnapshot(props: TuiSceneProps): Promise<CodexTuiSnapshot> {
  const [status, config] = await Promise.all([
    command(props, ' status'),
    command(props, ' config'),
  ])
  const authenticated = status.includes('is signed in')
  const usage = authenticated ? await command(props, ' usage') : ''
  return Object.freeze({ status, usage, preferences: configSnapshot(config) })
}

/** Local renderer value bound to the RFC 0006 Scene contribution. */
export const openAICodexTuiScene = Object.freeze({
  component(props: TuiSceneProps): React.ReactElement {
    const { React: runtime, ui } = props
    const { Box, Text } = ui
    const h = runtime.createElement
    const [snapshot, setSnapshot] = runtime.useState<CodexTuiSnapshot | undefined>()
    const [selected, setSelected] = runtime.useState(0)
    const [busy, setBusy] = runtime.useState(false)
    const [message, setMessage] = runtime.useState<string | undefined>()
    const itemCount = ACTIONS.length + PREFERENCES.length

    const refresh = runtime.useCallback(async () => {
      setBusy(true)
      try {
        setSnapshot(await loadSnapshot(props))
        setMessage(undefined)
      } catch (error: unknown) {
        setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    }, [props.channel])

    runtime.useEffect(() => { void refresh() }, [refresh])

    const activate = runtime.useCallback(async () => {
      setBusy(true)
      try {
        if (selected === 0) setMessage(await command(props, ' login browser'))
        else if (selected === 1) setMessage(await command(props, ' login device'))
        else if (selected === 2) setMessage(await command(props, ' logout'))
        else if (selected === 3) setMessage(undefined)
        else {
          const preference = PREFERENCES[selected - ACTIONS.length]
          if (preference === undefined || snapshot === undefined) return
          const next = snapshot.preferences[preference.name] ? 'off' : 'on'
          setMessage(await command(props, ` set ${preference.name} ${next}`))
        }
        setSnapshot(await loadSnapshot(props))
      } catch (error: unknown) {
        setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    }, [props.channel, selected, snapshot])

    ui.useInput((input, key) => {
      if (key.escape || input === 'q') props.close()
      else if (key.upArrow || input === 'k') setSelected(value => (value + itemCount - 1) % itemCount)
      else if (key.downArrow || input === 'j') setSelected(value => (value + 1) % itemCount)
      else if (key.return || input === ' ') void activate()
      else if (input === 'r') void refresh()
    }, { isActive: !busy })

    const actionRows = ACTIONS.map((label, index) => h(
      Text,
      { key: `action-${label}`, color: selected === index ? 'suggestion' : undefined },
      `${selected === index ? '›' : ' '} ${label}`,
    ))
    const preferenceRows = PREFERENCES.map((preference, index) => {
      const row = ACTIONS.length + index
      const enabled = snapshot?.preferences[preference.name]
      return h(
        Text,
        { key: preference.name, color: selected === row ? 'suggestion' : undefined },
        `${selected === row ? '›' : ' '} ${enabled === undefined ? '…' : enabled ? '●' : '○'} ${preference.label}`,
      )
    })

    return h(
      Box,
      { flexDirection: 'column', paddingX: 1, gap: 1 },
      h(Text, { bold: true, color: 'success' }, 'OpenAI Codex'),
      h(Text, { dimColor: true }, busy ? 'Working…' : snapshot?.status ?? 'Loading account status…'),
      snapshot?.usage === '' ? null : h(Text, {}, snapshot?.usage),
      h(Box, { flexDirection: 'column' }, ...actionRows),
      h(Text, { bold: true }, 'Provider settings'),
      h(Box, { flexDirection: 'column' }, ...preferenceRows),
      message === undefined ? null : h(Text, { color: 'warning' }, message),
      h(Text, { dimColor: true }, '↑/↓ select · Enter toggle/run · r refresh · Esc/q close'),
    )
  },
})

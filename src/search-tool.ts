/** Provider-scoped `web_search` shadow for OpenAI Codex agents. */

import type {
  ExecutableToolDefinition,
  ToolExecutionResult,
  ToolJsonValue,
  ToolOverrideHandler,
} from '@dsh-std/tool'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from './search.ts'
import type { OpenAICodexSearchContextSize, OpenAICodexSearchMode } from './search.ts'
import { OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT } from './search-event.ts'
import type { OpenAICodexCredentialStore } from './store.ts'

export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const OPENAI_CODEX_WEB_SEARCH_MAX_RESULTS = 8

export interface OpenAICodexSearchToolOptions {
  readonly model?: string
  readonly mode?: OpenAICodexSearchMode
  readonly contextSize?: OpenAICodexSearchContextSize
  readonly maxOutputTokens?: number
  readonly maxResults?: number
}

function queryOf(input: Readonly<Record<string, ToolJsonValue>>): string {
  const query = input.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query must be a non-empty string')
  }
  return query
}

function sourceLabel(source: WebSearchSource): string {
  if (source.title !== undefined && source.title.length > 0) return source.title
  try { return new URL(source.url).hostname } catch { return source.url }
}

/** Match `@deepseek-ai/dsh-tool-web`'s model-facing search result text. */
function formatSearchOutput(result: WebSearchResult): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)
  if (result.sources.length > 0) {
    const lines = result.sources.map(source => {
      const metadata: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) metadata.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) metadata.push(`(${source.publishedAt})`)
      return `- [${sourceLabel(source)}](${source.url})${metadata.length === 0 ? '' : ` — ${metadata.join(' ')}`}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }
  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

function jsonSource(source: WebSearchSource): ToolJsonValue {
  return {
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  }
}

function capSources(result: WebSearchResult, maxResults: number): WebSearchResult {
  if (result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

/** Replace the inherited web tool only in agent scopes selected by the Manifest. */
export function openAICodexSearchTool(
  credentials: OpenAICodexCredentialStore,
  options: OpenAICodexSearchToolOptions = {},
): ToolOverrideHandler {
  const maxResults = options.maxResults ?? OPENAI_CODEX_WEB_SEARCH_MAX_RESULTS
  if (!Number.isInteger(maxResults) || maxResults <= 0) throw new TypeError('maxResults must be a positive integer')
  return {
    resolve(original: ExecutableToolDefinition): ExecutableToolDefinition {
      return {
        name: original.name,
        description: original.description,
        parameters: original.parameters,
        output: original.output,
        isConcurrencySafe: () => true,
        async execute(input, context): Promise<ToolExecutionResult> {
          const session = context.session
          if (session === undefined) throw new Error('OpenAI Codex web_search requires an initiating session')
          const search = new OpenAICodexSearchProvider({
            credentials,
            model: options.model ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
            mode: options.mode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
            contextSize: options.contextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
            maxOutputTokens: options.maxOutputTokens ?? DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
            resolveRequestId: () => session.id,
            recordRequest: request => session.appendEvent(
              OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
              request as unknown as ToolJsonValue,
            ),
          })
          const result = capSources(await search.search({ query: queryOf(input), maxResults }, context.signal), maxResults)
          const sources = result.sources.map(jsonSource)
          const data: ToolJsonValue = {
            ...(result.content === undefined ? {} : { content: result.content }),
            sources,
            truncated: result.truncated,
          }
          return {
            data,
            content: [{ type: 'text', text: formatSearchOutput(result) }],
            presentation: {
              sources,
              truncated: result.truncated,
              ...(result.content === undefined ? {} : { answer: result.content }),
            },
          }
        },
      }
    },
  }
}

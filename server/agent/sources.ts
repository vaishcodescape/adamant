import { type SourceExcerpt } from './deps.ts'
import { redactText } from './recorder.ts'
import { findLocations, type FailureContext } from './triage.ts'

/**
 * The code the failure points at. A unified diff only applies if its context
 * lines match the file, and the model cannot match a file it has never seen,
 * so the files named in the parsed log are read once, in retrieve, and shown
 * to every later step. Bounded so the prompt stays small and cacheable.
 */
const MAX_FILES = 3
const LINES_BEFORE = 60
const LINES_AFTER = 60
const MAX_EXCERPT_CHARS = 8_000

type FileReader = (fromLog: string) => Promise<{ path: string; text: string } | null>

function excerpt(path: string, text: string, line: number): SourceExcerpt {
  // A final newline ends the last line; it does not start another one.
  const lines = text.replace(/\n$/, '').split('\n')
  const start = Math.max(1, line - LINES_BEFORE)
  const end = Math.min(lines.length, line + LINES_AFTER)
  let window = lines.slice(start - 1, end).join('\n')
  if (window.length > MAX_EXCERPT_CHARS) window = window.slice(0, MAX_EXCERPT_CHARS)

  return { path, startLine: start, text: redactText(window) }
}

/** Reads run concurrently; a file that cannot be found or read is skipped. */
export async function readSources(
  readFile: FileReader,
  failure: FailureContext,
): Promise<SourceExcerpt[]> {
  const text = [failure.location ?? '', failure.excerpt].join('\n')
  const locations = findLocations(text, MAX_FILES)

  const read = await Promise.all(
    locations.map(async ({ file, line }) => {
      const found = await readFile(file).catch(() => null)
      return found ? excerpt(found.path, found.text, line) : null
    }),
  )

  const seen = new Set<string>()
  return read.filter((source): source is SourceExcerpt => {
    if (!source || seen.has(source.path)) return false
    seen.add(source.path)
    return true
  })
}

/** Stable text block for the prompt. Same input, same text, so it caches. */
export function describeSources(sources: readonly SourceExcerpt[]): string {
  if (sources.length === 0) return 'Source: no file from the log was found in the checkout.'

  return sources
    .map((source) => {
      const end = source.startLine + source.text.split('\n').length - 1
      return [`Source ${source.path} (lines ${source.startLine}-${end}):`, source.text].join('\n')
    })
    .join('\n\n')
}

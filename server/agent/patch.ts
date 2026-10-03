/**
 * Turns a model reply into something `git apply` reads. Models wrap diffs in
 * Markdown fences and lead with a sentence even when told not to, and the
 * reply is trimmed, which drops the newline git needs after the last hunk.
 */
export function normalizePatch(reply: string): string {
  const fenced = /```(?:diff|patch)?[^\n]*\n([\s\S]*?)```/.exec(reply)
  const body = fenced?.[1] ?? reply
  const start = body.search(/^(?:diff --git |--- )/m)
  const diff = start > 0 ? body.slice(start) : body

  return diff.endsWith('\n') ? diff : `${diff}\n`
}

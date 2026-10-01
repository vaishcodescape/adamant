import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { format } from 'prettier'
import {
  createEvaluationScorecard,
  parseEvaluationSuite,
  renderScorecardJson,
  renderScorecardMarkdown,
} from '../server/evaluation/scorecard.ts'

const DEFAULT_INPUT = 'evaluation/fixtures/phase-1-three-case-results.json'
const DEFAULT_JSON_OUTPUT = 'evaluation/results/phase-1-scorecard.json'
const DEFAULT_MARKDOWN_OUTPUT = 'evaluation/results/phase-1-scorecard.md'

async function writeOutput(path, contents) {
  const absolutePath = resolve(path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, 'utf8')
  return absolutePath
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: DEFAULT_INPUT },
      json: { type: 'string', default: DEFAULT_JSON_OUTPUT },
      markdown: { type: 'string', default: DEFAULT_MARKDOWN_OUTPUT },
    },
  })

  const inputPath = resolve(values.input)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const scorecard = createEvaluationScorecard(parseEvaluationSuite(input))
  const jsonPath = await writeOutput(values.json, renderScorecardJson(scorecard))
  const markdown = await format(renderScorecardMarkdown(scorecard), { parser: 'markdown' })
  const markdownPath = await writeOutput(values.markdown, markdown)

  console.log(`Recorded ${scorecard.summary.totalCases} evaluation cases.`)
  console.log(`JSON: ${jsonPath}`)
  console.log(`Markdown: ${markdownPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fetchPullRequest } from "./github.js"
import {
  generateScriptHeuristic,
  generateScriptWithAgent,
  parseExplainerScript,
} from "./script.js"
import { renderSlides } from "./slides.js"
import { synthesizeNarration } from "./tts.js"
import type { CliArgs, PullRequestData, TtsBackend } from "./types.js"
import { assembleVideo } from "./video.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, "..")

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const outDir = resolve(args.outDir)
  await mkdir(outDir, { recursive: true })

  const pr = await loadPullRequest(args)
  await writeFile(join(outDir, "pr.json"), JSON.stringify(pr, null, 2), "utf8")
  process.stdout.write(
    `[pr] ${pr.owner}/${pr.repo}#${pr.number} — ${pr.title} (${pr.files.length} files)\n`
  )

  const script = await loadOrGenerateScript(args, pr, outDir)
  process.stdout.write(`[script] ${script.scenes.length} scenes — ${script.title}\n`)

  process.stdout.write("[slides] rendering…\n")
  const scenes = await renderSlides(script, outDir)

  process.stdout.write("[tts] synthesizing narration…\n")
  const { clips, backend } = await synthesizeNarration(scenes, outDir, args.tts)

  process.stdout.write("[video] assembling mp4…\n")
  const { mp4Path, srtPath } = await assembleVideo({
    script,
    scenes,
    clips,
    outDir,
  })

  process.stdout.write("\nDone.\n")
  process.stdout.write(`  video:  ${mp4Path}\n`)
  process.stdout.write(`  subs:   ${srtPath}\n`)
  process.stdout.write(`  tts:    ${backend}\n`)
  process.stdout.write(`  script: ${join(outDir, "explainer-script.json")}\n`)
}

async function loadPullRequest(args: CliArgs): Promise<PullRequestData> {
  if (args.prFile) {
    const raw = await readFile(resolve(args.prFile), "utf8")
    return JSON.parse(raw) as PullRequestData
  }
  if (args.prUrl) {
    return fetchPullRequest(args.prUrl)
  }
  throw new Error("Provide a PR URL, --pr <url>, or --from-pr-file <path>")
}

async function loadOrGenerateScript(
  args: CliArgs,
  pr: PullRequestData,
  outDir: string
) {
  if (args.scriptFile) {
    const raw = await readFile(resolve(args.scriptFile), "utf8")
    return parseExplainerScript(raw)
  }

  if (args.skipAgent) {
    process.stdout.write("[script] --skip-agent: using heuristic script\n")
    const script = generateScriptHeuristic(pr)
    await writeFile(
      join(outDir, "explainer-script.json"),
      JSON.stringify(script, null, 2),
      "utf8"
    )
    return script
  }

  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is required to generate the script with the Cursor SDK. " +
        "Set it, or pass --skip-agent / --from-script <file>."
    )
  }

  const workDir = join(outDir, "agent-workspace")
  return generateScriptWithAgent({
    pr,
    workDir,
    apiKey,
    model: args.model,
  })
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outDir: join(PACKAGE_ROOT, "output", "run"),
    model: process.env.CURSOR_MODEL ?? "composer-2",
    skipAgent: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") continue
    if (a === "-h" || a === "--help") {
      args.help = true
      continue
    }
    if (a === "--pr" || a === "--url") {
      args.prUrl = needValue(argv, ++i, a)
      continue
    }
    if (a === "--from-pr-file") {
      args.prFile = needValue(argv, ++i, a)
      continue
    }
    if (a === "--from-script") {
      args.scriptFile = needValue(argv, ++i, a)
      continue
    }
    if (a === "--out") {
      args.outDir = needValue(argv, ++i, a)
      continue
    }
    if (a === "--model") {
      args.model = needValue(argv, ++i, a)
      continue
    }
    if (a === "--skip-agent") {
      args.skipAgent = true
      continue
    }
    if (a === "--tts") {
      args.tts = parseTts(needValue(argv, ++i, a))
      continue
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`)
    }
    if (!args.prUrl) {
      args.prUrl = a
      continue
    }
    throw new Error(`Unexpected argument: ${a}`)
  }

  if (!args.help && !args.prUrl && !args.prFile) {
    throw new Error("Missing PR URL. Pass a URL or --from-pr-file <path>.")
  }

  return args
}

function needValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parseTts(value: string): TtsBackend {
  if (value === "openai" || value === "edge" || value === "espeak" || value === "silence") {
    return value
  }
  throw new Error(`Unknown --tts backend: ${value} (openai|edge|espeak|silence)`)
}

function printHelp() {
  process.stdout.write(`PR Explainer Video

Turn a GitHub pull request into a short narrated explainer MP4.

Usage:
  pnpm dev -- <github-pr-url> [--out output/run]
  pnpm dev -- --from-pr-file fixtures/sample-pr.json --skip-agent
  pnpm dev -- --from-script path/to/script.json --from-pr-file fixtures/sample-pr.json

Options:
  --pr, --url <url>       GitHub pull request URL
  --from-pr-file <path>   Use saved PR JSON instead of calling GitHub
  --from-script <path>    Skip script generation; use an existing explainer JSON
  --skip-agent            Build a heuristic script without CURSOR_API_KEY
  --out <dir>             Output directory (default: output/run)
  --model <id>            Cursor model id (default: composer-2)
  --tts <backend>         openai | edge | espeak | silence
  -h, --help              Show help

Environment:
  CURSOR_API_KEY          Required unless --skip-agent or --from-script
  CURSOR_MODEL            Optional default model
  OPENAI_API_KEY          Optional; enables OpenAI TTS
  EDGE_TTS_VOICE          Optional Edge voice (default en-US-JennyNeural)
  GITHUB_TOKEN / GH_TOKEN Optional; raises GitHub API rate limits
`)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Error: ${message}\n`)
  process.exitCode = 1
})

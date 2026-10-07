import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Agent } from "@cursor/sdk"
import type { ExplainerScript, PullRequestData } from "./types.js"

const SCRIPT_FILENAME = "explainer-script.json"

export async function generateScriptWithAgent(options: {
  pr: PullRequestData
  workDir: string
  apiKey: string
  model: string
}): Promise<ExplainerScript> {
  const { pr, workDir, apiKey, model } = options
  await mkdir(workDir, { recursive: true })

  const contextPath = join(workDir, "pr-context.json")
  await writeFile(contextPath, JSON.stringify(pr, null, 2), "utf8")
  await writeFile(
    join(workDir, "README-CONTEXT.md"),
    buildContextMarkdown(pr),
    "utf8"
  )

  const agent = await Agent.create({
    apiKey,
    name: "PR explainer video",
    model: { id: model },
    local: { cwd: workDir },
  })

  const prompt = [
    "You are writing a short narrated explainer for a GitHub pull request.",
    "Read pr-context.json and README-CONTEXT.md in this workspace.",
    `Write ${SCRIPT_FILENAME} in this workspace with ONLY valid JSON (no markdown fences) matching:`,
    `{`,
    `  "title": string,`,
    `  "summary": string,`,
    `  "scenes": [`,
    `    {`,
    `      "id": string,`,
    `      "headline": string,`,
    `      "bullets": string[] (optional, max 4 short bullets),`,
    `      "narration": string (spoken voice-over, 1-3 sentences),`,
    `      "code": { "filename": string, "snippet": string } | null`,
    `    }`,
    `  ]`,
    `}`,
    "",
    "Guidelines:",
    "- 4 to 7 scenes total.",
    "- Scene 1: what the PR is and why it exists.",
    "- Middle scenes: walk through the important changes (group related files).",
    "- Final scene: outcome / how to try it.",
    "- Narration should sound natural when spoken aloud (no URLs, no camelCase dumps).",
    "- Keep code snippets under 12 lines and only when they help.",
    "- Prefer clarity over completeness; this is a ~60-90 second explainer.",
    `- PR: ${pr.owner}/${pr.repo}#${pr.number} — ${pr.title}`,
  ].join("\n")

  process.stdout.write("[agent] generating explainer script…\n")
  const run = await agent.send(prompt)

  for await (const event of run.stream()) {
    if (event.type !== "assistant") continue
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text)
    }
  }
  process.stdout.write("\n")
  await run.wait()

  const scriptPath = join(workDir, SCRIPT_FILENAME)
  const raw = await readFile(scriptPath, "utf8")
  return parseExplainerScript(raw)
}

/** Deterministic fallback when CURSOR_API_KEY is missing or --skip-agent is set. */
export function generateScriptHeuristic(pr: PullRequestData): ExplainerScript {
  const topFiles = [...pr.files]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 3)

  const scenes = [
    {
      id: "intro",
      headline: pr.title,
      bullets: [
        `${pr.owner}/${pr.repo}#${pr.number}`,
        `by @${pr.author}`,
        `${pr.files.length} file(s) changed`,
      ],
      narration: `This pull request, ${spokenTitle(pr.title)}, updates ${pr.owner} ${pr.repo}. Here's what changed and why.`,
      code: null,
    },
    {
      id: "why",
      headline: "Why it exists",
      bullets: summarizeBody(pr.body),
      narration:
        pr.body.trim().length > 0
          ? `The author describes the motivation like this: ${clipSpoken(stripMarkdown(pr.body), 280)}`
          : `There's no long description, so we'll focus on the diff itself.`,
      code: null,
    },
    ...topFiles.map((file, index) => ({
      id: `file-${index + 1}`,
      headline: shortName(file.filename),
      bullets: [`${file.status}`, `+${file.additions} / -${file.deletions}`],
      narration: `Next, ${shortName(file.filename)} was ${pastStatus(file.status)}, with ${file.additions} additions and ${file.deletions} deletions.`,
      code: file.patch
        ? {
            filename: file.filename,
            snippet: pickSnippet(file.patch),
          }
        : null,
    })),
    {
      id: "outro",
      headline: "Try it",
      bullets: [`Base: ${pr.base}`, `Head: ${pr.head}`, pr.url],
      narration: `That's the tour of pull request ${pr.number}. Check the full discussion on GitHub for review notes and follow-ups.`,
      code: null,
    },
  ]

  return {
    title: `Explainer: ${pr.title}`,
    summary: clipSpoken(stripMarkdown(pr.body || pr.title), 200),
    scenes,
  }
}

export function parseExplainerScript(raw: string): ExplainerScript {
  const jsonText = extractJson(raw)
  const parsed = JSON.parse(jsonText) as ExplainerScript
  if (!parsed?.title || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("Explainer script must include title and a non-empty scenes array")
  }
  for (const [i, scene] of parsed.scenes.entries()) {
    if (!scene.id || !scene.headline || !scene.narration) {
      throw new Error(`Scene ${i} needs id, headline, and narration`)
    }
  }
  return parsed
}

function extractJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{")) return trimmed
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  throw new Error("Could not find JSON object in explainer script")
}

function buildContextMarkdown(pr: PullRequestData): string {
  const fileLines = pr.files
    .map(
      (f) =>
        `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\n\`\`\`diff\n${f.patch ?? "(no patch)"}\n\`\`\``
    )
    .join("\n\n")

  return [
    `# ${pr.title}`,
    "",
    `- URL: ${pr.url}`,
    `- Author: @${pr.author}`,
    `- Branches: ${pr.head} → ${pr.base}`,
    "",
    "## Description",
    "",
    pr.body || "(none)",
    "",
    "## Files",
    "",
    fileLines,
  ].join("\n")
}

function shortName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

function pastStatus(status: string): string {
  switch (status) {
    case "added":
      return "added"
    case "removed":
      return "removed"
    case "renamed":
      return "renamed"
    default:
      return "modified"
  }
}

function summarizeBody(body: string): string[] {
  const lines = body
    .split(/\r?\n/)
    .map((l) => stripMarkdown(l.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim()))
    .filter((l) => l.length > 0 && !l.startsWith("```"))
  return (lines.length > 0 ? lines : ["See the diff for details"]).slice(0, 3).map((l) => clip(l, 64))
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function pickSnippet(patch: string): string {
  const lines = patch.split(/\r?\n/).filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
  return lines.slice(0, 12).join("\n")
}

function clipSpoken(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max).replace(/[,:;]?\s+\S*$/, "")}…`
}

function spokenTitle(title: string): string {
  return title.replace(/[_/]/g, " ").replace(/\s+/g, " ").trim()
}

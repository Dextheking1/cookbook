import { spawn } from "node:child_process"
import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TtsBackend } from "./types.js"
import type { RenderedScene } from "./slides.js"

export type NarrationClip = {
  sceneId: string
  audioPath: string
  backend: TtsBackend
}

export async function synthesizeNarration(
  scenes: RenderedScene[],
  outDir: string,
  preferred?: TtsBackend
): Promise<{ clips: NarrationClip[]; backend: TtsBackend }> {
  const audioDir = join(outDir, "audio")
  await mkdirp(audioDir)

  const backend = preferred ?? (await detectDefaultBackend())
  process.stdout.write(`[tts] using backend: ${backend}\n`)

  const clips: NarrationClip[] = []
  for (const scene of scenes) {
    const audioPath = join(audioDir, `${String(scene.index + 1).padStart(2, "0")}-${scene.id}.mp3`)
    await synthesizeOne(backend, scene.narration, audioPath)
    clips.push({ sceneId: scene.id, audioPath, backend })
  }
  return { clips, backend }
}

async function detectDefaultBackend(): Promise<TtsBackend> {
  if (process.env.OPENAI_API_KEY) return "openai"
  if (await canRunEdgeTts()) return "edge"
  if (await commandExists("espeak-ng") || await commandExists("espeak")) return "espeak"
  return "silence"
}

async function synthesizeOne(
  backend: TtsBackend,
  text: string,
  audioPath: string
): Promise<void> {
  switch (backend) {
    case "openai":
      await synthesizeOpenAI(text, audioPath)
      return
    case "edge":
      await synthesizeEdge(text, audioPath)
      return
    case "espeak":
      await synthesizeEspeak(text, audioPath)
      return
    case "silence":
      await synthesizeSilence(text, audioPath)
      return
  }
}

async function synthesizeOpenAI(text: string, audioPath: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --tts openai")

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? "tts-1",
      voice: process.env.OPENAI_TTS_VOICE ?? "alloy",
      input: text,
      response_format: "mp3",
    }),
  })
  if (!res.ok) {
    throw new Error(`OpenAI TTS failed (${res.status}): ${await res.text()}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(audioPath, buf)
}

async function synthesizeEdge(text: string, audioPath: string): Promise<void> {
  const voice = process.env.EDGE_TTS_VOICE ?? "en-US-JennyNeural"
  // Prefer the installed CLI; fall back to python -m
  const attempts: Array<{ cmd: string; args: string[] }> = [
    {
      cmd: "edge-tts",
      args: ["--voice", voice, "--text", text, "--write-media", audioPath],
    },
    {
      cmd: "python3",
      args: [
        "-m",
        "edge_tts",
        "--voice",
        voice,
        "--text",
        text,
        "--write-media",
        audioPath,
      ],
    },
  ]

  let lastError: Error | undefined
  for (const attempt of attempts) {
    try {
      await run(attempt.cmd, attempt.args)
      return
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error("edge-tts failed")
}

async function synthesizeEspeak(text: string, audioPath: string): Promise<void> {
  const wavPath = audioPath.replace(/\.mp3$/i, ".wav")
  const bin = (await commandExists("espeak-ng")) ? "espeak-ng" : "espeak"
  await run(bin, ["-w", wavPath, text])
  await run("ffmpeg", ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioPath])
}

async function synthesizeSilence(text: string, audioPath: string): Promise<void> {
  // ~2.5 words/sec resting estimate, clamped for short scenes
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const seconds = Math.min(18, Math.max(3, words / 2.5))
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    seconds.toFixed(2),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    audioPath,
  ])
}

async function canRunEdgeTts(): Promise<boolean> {
  if (await commandExists("edge-tts")) return true
  try {
    await run("python3", ["-c", "import edge_tts"])
    return true
  } catch {
    return false
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await run("sh", ["-c", `command -v ${shellQuote(cmd)} >/dev/null`])
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))
    })
  })
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(dir, { recursive: true })
}

/** Used by tests / callers that want to force PATH checks without synthesizing. */
export async function probeTtsAvailability(): Promise<Record<TtsBackend, boolean>> {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    edge: await canRunEdgeTts(),
    espeak: (await commandExists("espeak-ng")) || (await commandExists("espeak")),
    silence: await commandExists("ffmpeg"),
  }
}

export async function assertFile(path: string): Promise<void> {
  await access(path)
}

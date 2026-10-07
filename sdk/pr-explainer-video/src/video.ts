import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExplainerScript } from "./types.js"
import type { RenderedScene } from "./slides.js"
import type { NarrationClip } from "./tts.js"

export async function assembleVideo(options: {
  script: ExplainerScript
  scenes: RenderedScene[]
  clips: NarrationClip[]
  outDir: string
}): Promise<{ mp4Path: string; srtPath: string }> {
  const { script, scenes, clips, outDir } = options
  const partsDir = join(outDir, "parts")
  await mkdir(partsDir, { recursive: true })

  const partPaths: string[] = []
  let cursorSeconds = 0
  const srtChunks: string[] = []

  for (const scene of scenes) {
    const clip = clips.find((c) => c.sceneId === scene.id)
    if (!clip) throw new Error(`Missing audio for scene ${scene.id}`)

    const duration = await probeDurationSeconds(clip.audioPath)
    const partPath = join(
      partsDir,
      `${String(scene.index + 1).padStart(2, "0")}-${scene.id}.mp4`
    )

    await run("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      scene.pngPath,
      "-i",
      clip.audioPath,
      "-c:v",
      "libx264",
      "-tune",
      "stillimage",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      "-fflags",
      "+shortest",
      "-t",
      duration.toFixed(3),
      partPath,
    ])

    partPaths.push(partPath)
    srtChunks.push(
      formatSrtCue(
        scene.index + 1,
        cursorSeconds,
        cursorSeconds + duration,
        scene.narration
      )
    )
    cursorSeconds += duration
  }

  const listPath = join(partsDir, "concat.txt")
  await writeFile(
    listPath,
    partPaths.map((p) => `file '${p.replaceAll("'", `'\\''`)}'`).join("\n"),
    "utf8"
  )

  const mp4Path = join(outDir, "explainer.mp4")
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    mp4Path,
  ])

  const srtPath = join(outDir, "explainer.srt")
  await writeFile(srtPath, srtChunks.join("\n"), "utf8")
  await writeFile(
    join(outDir, "explainer-script.json"),
    JSON.stringify(script, null, 2),
    "utf8"
  )

  return { mp4Path, srtPath }
}

function formatSrtCue(
  index: number,
  start: number,
  end: number,
  text: string
): string {
  return `${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text.trim()}\n`
}

function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0")
}

async function probeDurationSeconds(audioPath: string): Promise<number> {
  const output = await runCapture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ])
  const value = Number.parseFloat(output.trim())
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Could not probe duration for ${audioPath}`)
  }
  return value
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
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-800)}`))
    })
  })
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))
    })
  })
}

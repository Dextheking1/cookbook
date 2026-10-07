import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"
import type { ExplainerScene, ExplainerScript } from "./types.js"

const WIDTH = 1280
const HEIGHT = 720

export type RenderedScene = {
  id: string
  index: number
  pngPath: string
  narration: string
  headline: string
}

export async function renderSlides(
  script: ExplainerScript,
  outDir: string
): Promise<RenderedScene[]> {
  const slidesDir = join(outDir, "slides")
  await mkdir(slidesDir, { recursive: true })

  const rendered: RenderedScene[] = []
  for (const [index, scene] of script.scenes.entries()) {
    const svg = sceneToSvg(script, scene, index)
    const pngPath = join(slidesDir, `${String(index + 1).padStart(2, "0")}-${scene.id}.png`)
    await sharp(Buffer.from(svg)).png().toFile(pngPath)
    await writeFile(pngPath.replace(/\.png$/, ".svg"), svg, "utf8")
    rendered.push({
      id: scene.id,
      index,
      pngPath,
      narration: scene.narration,
      headline: scene.headline,
    })
  }
  return rendered
}

function sceneToSvg(
  script: ExplainerScript,
  scene: ExplainerScene,
  index: number
): string {
  const bullets = (scene.bullets ?? []).slice(0, 4)
  const bulletText = bullets
    .map((b, i) => {
      const y = 250 + i * 48
      return `
        <circle cx="96" cy="${y - 6}" r="5" fill="#3DDC97"/>
        <text x="118" y="${y}" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="28" fill="#E8F1F2">${escapeXml(clip(b, 64))}</text>
      `
    })
    .join("")

  const codeBlock = scene.code
    ? `
      <rect x="720" y="180" width="500" height="440" rx="16" fill="#0B1220" stroke="#243044"/>
      <text x="744" y="220" font-family="IBM Plex Mono, Menlo, monospace" font-size="18" fill="#7FDBCA">${escapeXml(clip(scene.code.filename, 42))}</text>
      ${codeLines(scene.code.snippet)}
    `
    : sidePanel(script, scene)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#07111F"/>
      <stop offset="55%" stop-color="#0C1B2E"/>
      <stop offset="100%" stop-color="#123048"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="1180" cy="80" r="180" fill="#1B6B93" opacity="0.18"/>
  <circle cx="80" cy="640" r="160" fill="#3DDC97" opacity="0.10"/>

  <text x="72" y="64" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="18" letter-spacing="3" fill="#7FDBCA">PR EXPLAINER</text>
  <text x="72" y="150" font-family="IBM Plex Serif, Georgia, serif" font-size="46" font-weight="600" fill="#F4FBFA">${escapeXml(clip(scene.headline, 42))}</text>
  ${bulletText}
  ${codeBlock}

  <text x="72" y="680" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="18" fill="#6E8499">${index + 1} / ${script.scenes.length}</text>
  <text x="1208" y="680" text-anchor="end" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="18" fill="#6E8499">${escapeXml(clip(script.title, 48))}</text>
</svg>`
}

function sidePanel(script: ExplainerScript, scene: ExplainerScene): string {
  const narrationLines = wrapText(scene.narration, 36).slice(0, 10)
  const narrationSvg = narrationLines
    .map((line, i) => {
      const y = 280 + i * 32
      return `<text x="744" y="${y}" font-family="IBM Plex Serif, Georgia, serif" font-size="22" fill="#D7E4EA">${escapeXml(line)}</text>`
    })
    .join("\n")

  return `
    <rect x="720" y="180" width="500" height="440" rx="16" fill="#102033" stroke="#243044"/>
    <text x="744" y="230" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="16" letter-spacing="2" fill="#7FDBCA">NARRATION</text>
    ${narrationSvg}
    <text x="744" y="580" font-family="IBM Plex Sans, Segoe UI, sans-serif" font-size="16" fill="#6E8499">${escapeXml(clip(script.summary, 48))}</text>
  `
}

function wrapText(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function codeLines(snippet: string): string {
  return snippet
    .split(/\r?\n/)
    .slice(0, 14)
    .map((line, i) => {
      const y = 256 + i * 24
      const color = line.startsWith("+")
        ? "#3DDC97"
        : line.startsWith("-")
          ? "#FF6B6B"
          : "#C7D2DE"
      return `<text x="744" y="${y}" font-family="IBM Plex Mono, Menlo, monospace" font-size="16" fill="${color}">${escapeXml(clip(line, 52))}</text>`
    })
    .join("\n")
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

export type PullRequestFile = {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export type PullRequestData = {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  body: string
  author: string
  base: string
  head: string
  files: PullRequestFile[]
}

export type SceneCode = {
  filename: string
  snippet: string
}

export type ExplainerScene = {
  id: string
  headline: string
  bullets?: string[]
  narration: string
  code?: SceneCode | null
}

export type ExplainerScript = {
  title: string
  summary: string
  scenes: ExplainerScene[]
}

export type TtsBackend = "openai" | "edge" | "espeak" | "silence"

export type CliArgs = {
  prUrl?: string
  prFile?: string
  scriptFile?: string
  outDir: string
  model: string
  skipAgent: boolean
  tts?: TtsBackend
  help: boolean
}

import { IncomingMessage } from 'node:http'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

type DebateRequest = {
  subject: {
    name: string
    question: string
    subtitle: string
  }
  winningOption: {
    person: string
    stance: 'for' | 'against'
    viewpoint: string
    angle: string
    prompt: string
    votes: number
  }
  options: Array<{
    person: string
    stance: 'for' | 'against'
    viewpoint: string
    angle: string
    votes: number
  }>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function debateApiPlugin(openAiApiKey: string | undefined): Plugin {
  return {
    name: 'debate-api',
    configureServer(server) {
      server.middlewares.use('/api/generate-debate', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        res.setHeader('Content-Type', 'application/json')

        if (!openAiApiKey) {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Add it to your environment before generating debates.',
            }),
          )
          return
        }

        try {
          const rawBody = await readBody(req)
          const payload = JSON.parse(rawBody) as DebateRequest

          const prompt = [
            'Create a sharp, intriguing debate transcript in JSON.',
            `Subject: ${payload.subject.name}`,
            `Question: ${payload.subject.question}`,
            `Winning speaker: ${payload.winningOption.person}`,
            `Winning stance: ${payload.winningOption.viewpoint}`,
            `Winning angle: ${payload.winningOption.angle}`,
            `Winning prompt: ${payload.winningOption.prompt}`,
            'Available speakers:',
            ...payload.options.map(
              (option) =>
                `- ${option.person} | ${option.stance} | ${option.viewpoint} | ${option.angle} | ${option.votes} votes`,
            ),
            'Return valid JSON with this exact shape: {"transcript":[{"speaker":"string","role":"string","text":"string"}]}.',
            'Write 6 transcript segments.',
            'Make it feel like an intelligent modern debate show.',
            'Include the winning speaker prominently, but also include tension from the opposite side.',
            'Do not include markdown fences.',
          ].join('\n')

          const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openAiApiKey}`,
            },
            body: JSON.stringify({
              model: 'gpt-5',
              input: prompt,
              text: {
                format: {
                  type: 'json_object',
                },
              },
            }),
          })

          const data = (await response.json()) as {
            error?: { message?: string }
            output_text?: string
          }

          if (!response.ok || !data.output_text) {
            throw new Error(data.error?.message || 'OpenAI generation failed.')
          }

          const parsed = JSON.parse(data.output_text) as {
            transcript?: Array<{ speaker?: string; role?: string; text?: string }>
          }

          const transcript = Array.isArray(parsed.transcript)
            ? parsed.transcript
                .filter(
                  (line) =>
                    typeof line.speaker === 'string' &&
                    typeof line.role === 'string' &&
                    typeof line.text === 'string',
                )
                .map((line) => ({
                  speaker: line.speaker as string,
                  role: line.role as string,
                  text: line.text as string,
                }))
            : []

          if (transcript.length === 0) {
            throw new Error('The model returned an empty transcript.')
          }

          res.statusCode = 200
          res.end(JSON.stringify({ transcript }))
        } catch (error) {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unexpected error while generating debate.',
            }),
          )
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), debateApiPlugin(env.OPENAI_API_KEY)],
  }
})

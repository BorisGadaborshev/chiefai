import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT || 8787)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, '../dist')
const distExists = fs.existsSync(distPath)

const polzaApiUrl = process.env.POLZA_API_URL || 'https://polza.ai/api/v1/chat/completions'
const polzaApiKey = process.env.POLZA_API_KEY
const polzaModel = process.env.POLZA_MODEL || 'openai/gpt-4o-mini'
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const telegramMaxAgeSeconds = Number(process.env.TELEGRAM_INIT_MAX_AGE_SECONDS || 86400)
const telegramDevBypass = process.env.TELEGRAM_DEV_BYPASS === 'true'

if (!polzaApiKey) {
  throw new Error('POLZA_API_KEY is missing. Set it in .env.local')
}
if (!telegramBotToken && !telegramDevBypass) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing. Set it in .env.local')
}

function isValidTelegramInitData(initData) {
  if (!initData || !telegramBotToken) {
    return false
  }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  const authDate = Number(params.get('auth_date') || 0)

  if (!hash || !authDate) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - authDate) > telegramMaxAgeSeconds) {
    return false
  }

  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(telegramBotToken).digest()
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  const hashBuffer = Buffer.from(hash, 'hex')
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex')
  if (hashBuffer.length !== calculatedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(hashBuffer, calculatedBuffer)
}

function isLocalDevRequest(req) {
  const host = String(req.hostname || '').toLowerCase()
  const ip = String(req.ip || '').replace('::ffff:', '')

  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  const localIps = new Set(['127.0.0.1', '::1'])

  return localHosts.has(host) || localIps.has(ip)
}

app.use(cors())
app.use(express.json({ limit: '25mb' }))

if (distExists) {
  app.use(express.static(distPath))
}

app.use('/api', (req, res, next) => {
  if (telegramDevBypass && isLocalDevRequest(req)) {
    return next()
  }

  const initData = req.get('x-telegram-init-data') || ''
  if (!isValidTelegramInitData(initData)) {
    return res.status(403).json({
      error: 'Доступ разрешен только из Telegram Mini App.',
    })
  }

  next()
})

app.post('/api/recipes', async (req, res) => {
  const { products = [], imageBase64, preferences } = req.body ?? {}
  const cleanProducts = Array.isArray(products)
    ? products
        .map((item) => String(item).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 50)
    : []
  const cleanPreferences =
    typeof preferences === 'string' ? preferences.trim().replace(/\s+/g, ' ').slice(0, 500) : ''

  if (cleanProducts.length === 0 && !imageBase64) {
    return res.status(400).json({ error: 'Передайте products или imageBase64.' })
  }

  const userParts = []
  userParts.push({
    type: 'text',
    text: [
      'Сформируй до 5 рецептов из доступных продуктов.',
      'Отвечай строго JSON без markdown.',
      'Формат: {"recipes":[{"id":"...","title":"...","ingredients":["..."],"steps":["..."]}],"note":"..."}',
      `Список продуктов пользователя: ${cleanProducts.join(', ') || 'не указан'}.`,
      `Пожелания и ограничения пользователя: ${cleanPreferences || 'не указаны'}.`,
    ].join('\n'),
  })

  const hasImage = typeof imageBase64 === 'string' && imageBase64.startsWith('data:image')

  if (hasImage) {
    userParts.push({
      type: 'image_url',
      image_url: { url: imageBase64 },
    })
  }

  try {
    let fallbackToTextOnly = false
    let polzaResponse = await fetch(polzaApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${polzaApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: polzaModel,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content:
              'Ты кулинарный ассистент. Рекомендуй простые и безопасные рецепты. Не выдумывай наличие продуктов.',
          },
          {
            role: 'user',
            content: userParts,
          },
        ],
      }),
    })

    if (!polzaResponse.ok && hasImage) {
      fallbackToTextOnly = true
      polzaResponse = await fetch(polzaApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${polzaApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: polzaModel,
          temperature: 0.4,
          messages: [
            {
              role: 'system',
              content:
                'Ты кулинарный ассистент. Рекомендуй простые и безопасные рецепты. Не выдумывай наличие продуктов.',
            },
            {
              role: 'user',
              content: `Сформируй до 5 рецептов из доступных продуктов. Отвечай строго JSON без markdown. Формат: {"recipes":[{"id":"...","title":"...","ingredients":["..."],"steps":["..."]}],"note":"..."}. Список продуктов пользователя: ${
                cleanProducts.join(', ') || 'не указан'
              }.`,
            },
          ],
        }),
      })
    }

    if (!polzaResponse.ok) {
      const errorText = await polzaResponse.text()
      return res.status(502).json({
        error: 'Ошибка ответа polza.ai',
        details: errorText.slice(0, 1000),
      })
    }

    const completion = await polzaResponse.json()
    const content = completion?.choices?.[0]?.message?.content

    if (typeof content !== 'string') {
      return res.status(500).json({ error: 'Некорректный формат ответа от polza.ai' })
    }

    try {
      const parsed = JSON.parse(content)
      return res.json({
        recipes: Array.isArray(parsed?.recipes) ? parsed.recipes : [],
        note:
          typeof parsed?.note === 'string'
            ? parsed.note
            : fallbackToTextOnly
              ? 'Рецепты подобраны по списку продуктов (анализ фото временно недоступен).'
              : undefined,
      })
    } catch {
      return res.json({
        recipes: [],
        rawText: content,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка сервера'
    return res.status(500).json({ error: message })
  }
})

app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Фото слишком большое. Попробуйте изображение меньшего размера.',
    })
  }

  if (error) {
    return res.status(500).json({
      error: error.message || 'Внутренняя ошибка сервера',
    })
  }

  next()
})

if (distExists) {
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(port, () => {
  const mode = distExists ? 'api+web' : 'api-only'
  console.log(`Server started on http://localhost:${port} (${mode})`)
})

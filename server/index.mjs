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
const requestCostStars = Number(process.env.REQUEST_COST_STARS || 2)
const newUserStartStars = Number(process.env.NEW_USER_START_STARS || 20)
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || ''
const balancesPath = path.resolve(__dirname, '../data/balances.json')
const promoUsagePath = path.resolve(__dirname, '../data/promo-usage.json')
const invoicesSecret = process.env.INVOICES_SECRET || polzaApiKey
const fixedPromoCode = 'BEASTOLOLO'
const promoGrantStars = Number(process.env.PROMO_GRANT_STARS || requestCostStars)
const promoMaxUses = Number(process.env.PROMO_MAX_USES || 10)

const topupPackages = [
  { id: 'topup_25', stars: 25, priceXtr: 25, label: '25⭐' },
  { id: 'topup_100', stars: 100, priceXtr: 100, label: '100⭐' },
  { id: 'topup_250', stars: 250, priceXtr: 250, label: '250⭐' },
]

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

function callTelegramApi(method, payload) {
  if (!telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing')
  }

  return fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

function extractTelegramUserId(initData) {
  try {
    const params = new URLSearchParams(initData)
    const rawUser = params.get('user')
    if (!rawUser) {
      return null
    }

    const user = JSON.parse(rawUser)
    if (!user?.id) {
      return null
    }

    return String(user.id)
  } catch {
    return null
  }
}

function isLocalDevRequest(req) {
  const host = String(req.hostname || '').toLowerCase()
  const ip = String(req.ip || '').replace('::ffff:', '')

  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  const localIps = new Set(['127.0.0.1', '::1'])

  return localHosts.has(host) || localIps.has(ip)
}

function ensureBalancesStorage() {
  const dir = path.dirname(balancesPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  if (!fs.existsSync(balancesPath)) {
    fs.writeFileSync(balancesPath, '{}', 'utf8')
  }
}

function ensurePromoUsageStorage() {
  const dir = path.dirname(promoUsagePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  if (!fs.existsSync(promoUsagePath)) {
    fs.writeFileSync(promoUsagePath, '{}', 'utf8')
  }
}

function loadPromoUsage() {
  ensurePromoUsageStorage()
  try {
    const raw = fs.readFileSync(promoUsagePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePromoUsage(usage) {
  fs.writeFileSync(promoUsagePath, JSON.stringify(usage, null, 2), 'utf8')
}

function loadBalances() {
  ensureBalancesStorage()

  try {
    const raw = fs.readFileSync(balancesPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveBalances(balances) {
  fs.writeFileSync(balancesPath, JSON.stringify(balances, null, 2), 'utf8')
}

function getOrCreateWallet(balances, userId) {
  if (!balances[userId]) {
    balances[userId] = {
      stars: newUserStartStars,
      spent: 0,
      requests: 0,
      redeemedPromos: [],
      updatedAt: new Date().toISOString(),
    }
  }

  if (!Array.isArray(balances[userId].redeemedPromos)) {
    balances[userId].redeemedPromos = []
  }

  return balances[userId]
}

function getBalance(userId) {
  const balances = loadBalances()
  const wallet = getOrCreateWallet(balances, userId)
  saveBalances(balances)

  return {
    stars: Number(wallet.stars || 0),
    requestCostStars,
    promoRedeemed: wallet.redeemedPromos.includes(fixedPromoCode),
  }
}

function chargeStars(userId, amount) {
  const balances = loadBalances()
  const wallet = getOrCreateWallet(balances, userId)
  const stars = Number(wallet.stars || 0)

  if (stars < amount) {
    saveBalances(balances)
    return {
      ok: false,
      balance: stars,
      requestCostStars,
    }
  }

  wallet.stars = stars - amount
  wallet.spent = Number(wallet.spent || 0) + amount
  wallet.requests = Number(wallet.requests || 0) + 1
  wallet.updatedAt = new Date().toISOString()
  saveBalances(balances)

  return {
    ok: true,
    balance: wallet.stars,
    requestCostStars,
  }
}

function refundStars(userId, amount) {
  const balances = loadBalances()
  const wallet = getOrCreateWallet(balances, userId)
  wallet.stars = Number(wallet.stars || 0) + amount
  wallet.spent = Math.max(0, Number(wallet.spent || 0) - amount)
  wallet.requests = Math.max(0, Number(wallet.requests || 0) - 1)
  wallet.updatedAt = new Date().toISOString()
  saveBalances(balances)
}

function addStars(userId, amount) {
  const balances = loadBalances()
  const wallet = getOrCreateWallet(balances, userId)
  wallet.stars = Number(wallet.stars || 0) + amount
  wallet.updatedAt = new Date().toISOString()
  saveBalances(balances)

  return wallet.stars
}

function redeemPromo(userId, promoCodeRaw) {
  const promoCode = String(promoCodeRaw || '').trim().toUpperCase()
  if (promoCode !== fixedPromoCode) {
    return {
      ok: false,
      reason: 'invalid',
    }
  }

  const balances = loadBalances()
  const wallet = getOrCreateWallet(balances, userId)
  const promoUsage = loadPromoUsage()
  const currentUsage = Number(promoUsage[fixedPromoCode] || 0)

  if (currentUsage >= promoMaxUses) {
    return {
      ok: false,
      reason: 'limit_reached',
      balance: Number(wallet.stars || 0),
    }
  }

  if (wallet.redeemedPromos.includes(fixedPromoCode)) {
    return {
      ok: false,
      reason: 'already_used',
      balance: Number(wallet.stars || 0),
    }
  }

  wallet.redeemedPromos.push(fixedPromoCode)
  wallet.stars = Number(wallet.stars || 0) + promoGrantStars
  wallet.updatedAt = new Date().toISOString()
  saveBalances(balances)
  promoUsage[fixedPromoCode] = currentUsage + 1
  savePromoUsage(promoUsage)

  return {
    ok: true,
    balance: wallet.stars,
    promoGrantStars,
  }
}

function createInvoicePayload(userId, packageId, stars) {
  const nonce = crypto.randomBytes(8).toString('hex')
  const base = `${userId}:${packageId}:${stars}:${nonce}`
  const signature = crypto.createHmac('sha256', invoicesSecret).update(base).digest('hex')
  return `${base}:${signature}`
}

function parseAndVerifyInvoicePayload(payload) {
  const parts = String(payload || '').split(':')
  if (parts.length !== 5) {
    return null
  }

  const [userId, packageId, starsRaw, nonce, signature] = parts
  const base = `${userId}:${packageId}:${starsRaw}:${nonce}`
  const expectedSignature = crypto.createHmac('sha256', invoicesSecret).update(base).digest('hex')

  const signatureBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expectedSignature, 'hex')
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  const stars = Number(starsRaw)
  if (!Number.isFinite(stars) || stars <= 0) {
    return null
  }

  return { userId, packageId, stars }
}

app.use(cors())
app.use(express.json({ limit: '25mb' }))

if (distExists) {
  app.use(express.static(distPath))
}

app.post('/telegram/webhook', async (req, res) => {
  const secretHeader = req.get('x-telegram-bot-api-secret-token') || ''
  if (telegramWebhookSecret && secretHeader !== telegramWebhookSecret) {
    return res.sendStatus(403)
  }

  const update = req.body || {}

  if (update.pre_checkout_query) {
    const preCheckoutQuery = update.pre_checkout_query
    try {
      const parsed = parseAndVerifyInvoicePayload(preCheckoutQuery.invoice_payload)
      const ok = Boolean(parsed)
      const telegramResponse = await callTelegramApi('answerPreCheckoutQuery', {
        pre_checkout_query_id: preCheckoutQuery.id,
        ok,
        error_message: ok ? undefined : 'Ошибка проверки платежа. Попробуйте снова.',
      })

      const data = await telegramResponse.json()
      if (!data.ok) {
        console.error('answerPreCheckoutQuery failed', data)
      }
    } catch (error) {
      console.error('pre_checkout_query handling failed', error)
    }
  }

  if (update.message?.successful_payment) {
    const successfulPayment = update.message.successful_payment
    const parsed = parseAndVerifyInvoicePayload(successfulPayment.invoice_payload)
    if (parsed) {
      addStars(parsed.userId, parsed.stars)
    }
  }

  return res.sendStatus(200)
})

app.use('/api', (req, res, next) => {
  if (telegramDevBypass && isLocalDevRequest(req)) {
    req.userId = 'local-dev'
    return next()
  }

  const initData = req.get('x-telegram-init-data') || ''
  if (!isValidTelegramInitData(initData)) {
    return res.status(403).json({
      error: 'Доступ разрешен только из Telegram Mini App.',
    })
  }

  const userId = extractTelegramUserId(initData)
  if (!userId) {
    return res.status(403).json({
      error: 'Не удалось определить пользователя Telegram.',
    })
  }

  req.userId = userId
  next()
})

app.get('/api/balance', (req, res) => {
  const userId = req.userId || 'unknown'
  const balance = getBalance(String(userId))
  return res.json({
    ...balance,
    topupPackages,
  })
})

app.post('/api/promo/redeem', (req, res) => {
  const userId = String(req.userId || 'unknown')
  const code = String(req.body?.code || '')
  const result = redeemPromo(userId, code)

  if (!result.ok) {
    if (result.reason === 'already_used') {
      return res.status(409).json({
        error: 'Этот промокод уже использован.',
        balance: result.balance,
      })
    }
    if (result.reason === 'limit_reached') {
      return res.status(409).json({
        error: 'Промокод больше недоступен.',
        balance: result.balance,
      })
    }

    return res.status(400).json({
      error: 'Неверный промокод.',
    })
  }

  return res.json({
    message: `Промокод активирован. Начислено ${result.promoGrantStars}⭐.`,
    balance: result.balance,
    promoGrantStars: result.promoGrantStars,
  })
})

app.post('/api/stars/invoice', async (req, res) => {
  const userId = String(req.userId || 'unknown')
  const packageId = String(req.body?.packageId || '')
  const selectedPackage = topupPackages.find((item) => item.id === packageId)

  if (!selectedPackage) {
    return res.status(400).json({ error: 'Некорректный пакет пополнения.' })
  }

  try {
    const invoicePayload = createInvoicePayload(userId, selectedPackage.id, selectedPackage.stars)
    const telegramResponse = await callTelegramApi('createInvoiceLink', {
      title: `Пополнение баланса ${selectedPackage.label}`,
      description: `Пополнение на ${selectedPackage.stars}⭐ для Chief Ai`,
      payload: invoicePayload,
      currency: 'XTR',
      prices: [
        {
          label: `${selectedPackage.stars} stars`,
          amount: selectedPackage.priceXtr,
        },
      ],
    })
    const data = await telegramResponse.json()

    if (!data.ok || typeof data.result !== 'string') {
      return res.status(502).json({
        error: 'Не удалось создать инвойс Telegram Stars.',
        details: data.description || 'Unknown Telegram API error',
      })
    }

    return res.json({ invoiceLink: data.result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка создания инвойса'
    return res.status(500).json({ error: message })
  }
})

app.post('/api/recipes', async (req, res) => {
  const userId = String(req.userId || 'unknown')
  const charge = chargeStars(userId, requestCostStars)
  if (!charge.ok) {
    return res.status(402).json({
      error: `Недостаточно звезд. Нужно ${charge.requestCostStars}⭐ за запрос.`,
      balance: charge.balance,
      requestCostStars: charge.requestCostStars,
    })
  }

  let refundRequired = true
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
    refundStars(userId, requestCostStars)
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
      refundStars(userId, requestCostStars)
      return res.status(502).json({
        error: 'Ошибка ответа polza.ai',
        details: errorText.slice(0, 1000),
      })
    }

    const completion = await polzaResponse.json()
    const content = completion?.choices?.[0]?.message?.content

    if (typeof content !== 'string') {
      refundStars(userId, requestCostStars)
      return res.status(500).json({ error: 'Некорректный формат ответа от polza.ai' })
    }

    try {
      const parsed = JSON.parse(content)
      refundRequired = false
      return res.json({
        recipes: Array.isArray(parsed?.recipes) ? parsed.recipes : [],
        note:
          typeof parsed?.note === 'string'
            ? parsed.note
            : fallbackToTextOnly
              ? 'Рецепты подобраны по списку продуктов (анализ фото временно недоступен).'
              : undefined,
        balance: charge.balance,
        requestCostStars,
      })
    } catch {
      refundRequired = false
      return res.json({
        recipes: [],
        rawText: content,
        balance: charge.balance,
        requestCostStars,
      })
    }
  } catch (error) {
    if (refundRequired) {
      refundStars(userId, requestCostStars)
    }
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

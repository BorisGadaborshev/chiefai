import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import styled from '@emotion/styled'

type Recipe = {
  id: string
  title: string
  ingredients: string[]
  steps: string[]
}

type RecipesResponse = {
  recipes: Recipe[]
  note?: string
  rawText?: string
  balance?: number
  requestCostStars?: number
}

type BalanceResponse = {
  stars?: number
  requestCostStars?: number
  topupPackages?: TopupPackage[]
}

type TopupPackage = {
  id: string
  stars: number
  priceXtr: number
  label: string
}

type TelegramWebApp = {
  initData: string
  ready?: () => void
  expand?: () => void
  openInvoice?: (url: string, callback?: (status: string) => void) => void
  openTelegramLink?: (url: string) => void
  openLink?: (url: string) => void
}

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp
  }
}

type AgreementSection = {
  title: string
  items: string[]
}

const AGREEMENT_VERSION = 'v1'
const AGREEMENT_STORAGE_KEY = `chief-ai-agreement-${AGREEMENT_VERSION}`

const agreementSections: AgreementSection[] = [
  {
    title: '1. Назначение сервиса',
    items: [
      'Chief Ai подбирает варианты рецептов на основе фото, списка продуктов и пожеланий пользователя.',
      'Результат носит рекомендательный характер и не является профессиональной медицинской или диетологической консультацией.',
    ],
  },
  {
    title: '2. Доступ и оплата',
    items: [
      'Генерация рецептов выполняется за внутренние звезды приложения в соответствии с текущим тарифом.',
      'Пополнение и промокоды применяются по правилам, действующим на момент использования.',
    ],
  },
  {
    title: '3. Контент пользователя',
    items: [
      'Пользователь подтверждает право загружать фото и вводить данные, которые не нарушают права третьих лиц.',
      'Запрещено использовать сервис для противоправного, оскорбительного или опасного контента.',
    ],
  },
  {
    title: '4. Обработка данных',
    items: [
      'Для работы сервиса могут обрабатываться фото продуктов, текстовые запросы и технические данные сессии.',
      'Отправляя данные, пользователь соглашается на их обработку для генерации ответа.',
    ],
  },
  {
    title: '5. Ограничение ответственности',
    items: [
      'Пользователь самостоятельно проверяет ингредиенты, аллергенность, сроки годности и безопасность приготовления.',
      'Сервис не несет ответственности за решения, принятые пользователем на основе рекомендаций.',
    ],
  },
  {
    title: '6. Изменение условий',
    items: [
      'Условия могут обновляться; продолжение использования сервиса означает согласие с актуальной редакцией.',
    ],
  },
]

function getOrCreateClientId(): string {
  const storageKey = 'chief-ai-client-id'
  const existing = window.localStorage.getItem(storageKey)
  if (existing) {
    return existing
  }

  const generated = `web_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  window.localStorage.setItem(storageKey, generated)
  return generated
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function getProductsFromText(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map(normalize)
    .filter(Boolean)
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать фото'))
    reader.readAsDataURL(file)
  })
}

async function compressImage(file: File): Promise<string> {
  const sourceDataUrl = await fileToDataUrl(file)

  if (!file.type.startsWith('image/')) {
    return sourceDataUrl
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось обработать фото'))
    img.src = sourceDataUrl
  })

  const maxSide = 1280
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    return sourceDataUrl
  }

  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

function App() {
  const telegramWebApp = (window as TelegramWindow).Telegram?.WebApp
  const telegramInitData = telegramWebApp?.initData ?? ''
  const [clientId] = useState(() => getOrCreateClientId())
  const [hasAcceptedAgreement, setHasAcceptedAgreement] = useState(
    () => window.localStorage.getItem(AGREEMENT_STORAGE_KEY) === 'accepted',
  )
  const [agreementChecked, setAgreementChecked] = useState(false)

  const [productsText, setProductsText] = useState('')
  const [preferencesText, setPreferencesText] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [matchedRecipes, setMatchedRecipes] = useState<Recipe[]>([])
  const [starsBalance, setStarsBalance] = useState<number | null>(null)
  const [requestCostStars, setRequestCostStars] = useState(3)
  const [topupPackages, setTopupPackages] = useState<TopupPackage[]>([])
  const [topupLoadingId, setTopupLoadingId] = useState<string | null>(null)
  const [promoCode, setPromoCode] = useState('')
  const [promoLoading, setPromoLoading] = useState(false)
  const [promoMessage, setPromoMessage] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraLoading, setCameraLoading] = useState(false)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    telegramWebApp?.ready?.()
    telegramWebApp?.expand?.()
  }, [telegramWebApp])

  useEffect(() => {
    const loadBalance = async () => {
      try {
        const response = await fetch('/api/balance', {
          headers: {
            'X-Telegram-Init-Data': telegramInitData,
            'X-Client-Id': clientId,
          },
        })
        if (!response.ok) {
          return
        }

        const payload = (await response.json()) as BalanceResponse

        if (typeof payload.stars === 'number') {
          setStarsBalance(payload.stars)
        }
        if (typeof payload.requestCostStars === 'number') {
          setRequestCostStars(payload.requestCostStars)
        }
        if (Array.isArray(payload.topupPackages)) {
          setTopupPackages(payload.topupPackages)
        }
      } catch {
        // Balance fetch is non-blocking; UI can still render without it.
      }
    }

    void loadBalance()
  }, [telegramInitData, clientId])

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null)
      return
    }

    const objectUrl = URL.createObjectURL(imageFile)
    setImagePreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [imageFile])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = cameraStream
    }
  }, [cameraStream])

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach((track) => track.stop())
    }
  }, [cameraStream])

  const allProducts = useMemo(() => {
    const fromText = getProductsFromText(productsText)
    return [...new Set(fromText)]
  }, [productsText])

  const onPhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setImageFile(file)
  }

  const stopCamera = () => {
    cameraStream?.getTracks().forEach((track) => track.stop())
    setCameraStream(null)
    setCameraOpen(false)
    setCameraLoading(false)
  }

  const onOpenCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Камера не поддерживается на этом устройстве.')
      return
    }

    setCameraLoading(true)
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      setCameraStream(stream)
      setCameraOpen(true)
    } catch {
      setError('Не удалось открыть камеру. Проверь разрешения браузера.')
    } finally {
      setCameraLoading(false)
    }
  }

  const onCaptureFromCamera = async () => {
    const video = videoRef.current
    if (!video) return

    const width = video.videoWidth || 1280
    const height = video.videoHeight || 720
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      setError('Не удалось получить кадр с камеры.')
      return
    }

    context.drawImage(video, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )

    if (!blob) {
      setError('Не удалось создать фото с камеры.')
      return
    }

    const file = new File([blob], `camera-${Date.now()}.jpg`, {
      type: 'image/jpeg',
    })
    setImageFile(file)
    stopCamera()
  }

  const onPickFromGallery = () => fileInputRef.current?.click()

  const onFindRecipes = async () => {
    if (!imageFile && allProducts.length === 0) {
      setError('Добавь фото или введи список продуктов.')
      return
    }

    setLoading(true)
    setError(null)
    setNote(null)

    try {
      const imageBase64 = imageFile ? await compressImage(imageFile) : undefined

      const response = await fetch('/api/recipes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': telegramInitData,
          'X-Client-Id': clientId,
        },
        body: JSON.stringify({
          products: allProducts,
          imageBase64,
          preferences: preferencesText.trim(),
        }),
      })

      const payload = (await response.json()) as RecipesResponse & {
        error?: string
        details?: string
      }

      if (!response.ok) {
        if (typeof payload.balance === 'number') {
          setStarsBalance(payload.balance)
        }
        if (typeof payload.requestCostStars === 'number') {
          setRequestCostStars(payload.requestCostStars)
        }
        const errorMessage = payload.details
          ? `${payload.error}: ${payload.details}`
          : payload.error || 'Ошибка запроса к серверу'
        throw new Error(errorMessage)
      }

      setMatchedRecipes(Array.isArray(payload.recipes) ? payload.recipes : [])
      setNote(payload.note ?? payload.rawText ?? null)
      if (typeof payload.balance === 'number') {
        setStarsBalance(payload.balance)
      }
      if (typeof payload.requestCostStars === 'number') {
        setRequestCostStars(payload.requestCostStars)
      }
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Неизвестная ошибка запроса'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const onTopup = async (packageId: string) => {
    setTopupLoadingId(packageId)
    setError(null)

    try {
      const response = await fetch('/api/stars/invoice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': telegramInitData,
          'X-Client-Id': clientId,
        },
        body: JSON.stringify({ packageId }),
      })
      const payload = (await response.json()) as { invoiceLink?: string; error?: string }

      if (!response.ok || !payload.invoiceLink) {
        throw new Error(payload.error || 'Не удалось создать инвойс')
      }

      if (telegramWebApp?.openInvoice) {
        await new Promise<void>((resolve, reject) => {
          telegramWebApp.openInvoice?.(payload.invoiceLink!, (status) => {
            if (status === 'paid') {
              resolve()
              return
            }
            if (status === 'cancelled') {
              reject(new Error('Платеж отменен.'))
              return
            }
            reject(new Error(`Не удалось завершить платеж (${status}).`))
          })
        })
      } else {
        // Fallback for Telegram clients without WebApp.openInvoice support.
        if (telegramWebApp?.openTelegramLink) {
          telegramWebApp.openTelegramLink(payload.invoiceLink)
        } else if (telegramWebApp?.openLink) {
          telegramWebApp.openLink(payload.invoiceLink)
        } else {
          window.location.href = payload.invoiceLink
        }
        setPromoMessage('Инвойс открыт. После оплаты нажми кнопку пополнения еще раз для обновления баланса.')
        return
      }

      const balanceResponse = await fetch('/api/balance', {
        headers: {
          'X-Telegram-Init-Data': telegramInitData,
          'X-Client-Id': clientId,
        },
      })
      if (balanceResponse.ok) {
        const balancePayload = (await balanceResponse.json()) as {
          stars?: number
          requestCostStars?: number
        }
        if (typeof balancePayload.stars === 'number') {
          setStarsBalance(balancePayload.stars)
        }
        if (typeof balancePayload.requestCostStars === 'number') {
          setRequestCostStars(balancePayload.requestCostStars)
        }
      }
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Ошибка пополнения баланса'
      setError(message)
    } finally {
      setTopupLoadingId(null)
    }
  }

  const onRedeemPromo = async () => {
    const code = promoCode.trim()
    if (!code) {
      setPromoMessage('Введи промокод.')
      return
    }

    setPromoLoading(true)
    setPromoMessage(null)
    setError(null)

    try {
      const response = await fetch('/api/promo/redeem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': telegramInitData,
          'X-Client-Id': clientId,
        },
        body: JSON.stringify({ code }),
      })
      const payload = (await response.json()) as {
        message?: string
        error?: string
        balance?: number
      }

      if (!response.ok) {
        throw new Error(payload.error || 'Не удалось активировать промокод')
      }

      if (typeof payload.balance === 'number') {
        setStarsBalance(payload.balance)
      }
      setPromoCode('')
      setPromoMessage(payload.message || 'Промокод активирован.')
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Ошибка активации промокода'
      setPromoMessage(message)
    } finally {
      setPromoLoading(false)
    }
  }

  const onAcceptAgreement = () => {
    if (!agreementChecked) {
      return
    }
    window.localStorage.setItem(AGREEMENT_STORAGE_KEY, 'accepted')
    setHasAcceptedAgreement(true)
  }

  if (!hasAcceptedAgreement) {
    return (
      <Page>
        <Card>
          <Header>
            <h1>Chief Ai</h1>
          </Header>

          <Section>
            <SectionTitle>Пользовательское соглашение</SectionTitle>
            <AgreementText>
              Перед использованием сервиса ознакомьтесь с условиями и подтвердите согласие.
            </AgreementText>
            <AgreementList>
              {agreementSections.map((section) => (
                <AgreementItem key={section.title}>
                  <AgreementTitle>{section.title}</AgreementTitle>
                  {section.items.map((item) => (
                    <AgreementText key={item}>- {item}</AgreementText>
                  ))}
                </AgreementItem>
              ))}
            </AgreementList>
          </Section>

          <AgreementActions>
            <AgreementCheckboxLabel>
              <input
                type="checkbox"
                checked={agreementChecked}
                onChange={(event) => setAgreementChecked(event.target.checked)}
              />
              Я согласен с условиями пользовательского соглашения
            </AgreementCheckboxLabel>
            <PrimaryButton
              type="button"
              disabled={!agreementChecked}
              onClick={onAcceptAgreement}
            >
              Продолжить
            </PrimaryButton>
          </AgreementActions>
        </Card>
      </Page>
    )
  }

  return (
    <Page>
      <Card>
        <Header>
          <h1>Chief Ai</h1>
        </Header>

          <Section>
            <SectionTitle>1) Добавь фото продуктов</SectionTitle>
            <PreviewArea>
              {imagePreview ? (
                <Preview src={imagePreview} alt="Продукты" />
              ) : (
                <PreviewPlaceholder>Изображение пока не выбрано</PreviewPlaceholder>
              )}
            </PreviewArea>
            <UploadActions>
              <HiddenFileInput
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onPhotoChange}
              />
              <UploadButton type="button" onClick={onPickFromGallery}>
                Выбрать фото
              </UploadButton>
              <UploadButton type="button" onClick={onOpenCamera} disabled={cameraLoading}>
                {cameraLoading ? 'Открываем камеру...' : 'Сделать снимок'}
              </UploadButton>
            </UploadActions>
            {cameraOpen && (
              <CameraPanel>
                <CameraVideo ref={videoRef} autoPlay playsInline muted />
                <CameraControls>
                  <CameraButton type="button" onClick={onCaptureFromCamera}>
                    Снять
                  </CameraButton>
                  <CancelButton type="button" onClick={stopCamera}>
                    Отмена
                  </CancelButton>
                </CameraControls>
              </CameraPanel>
            )}
            {imageFile && (
              <Hint>
                Фото загружено: <strong>{imageFile.name}</strong>
              </Hint>
            )}
          </Section>

          <Section>
            <SectionTitle>2) Введи список продуктов</SectionTitle>
            <Accordion>
              <AccordionSummary>Открыть список продуктов</AccordionSummary>
              <Textarea
                value={productsText}
                onChange={(event) => setProductsText(event.target.value)}
                placeholder="Например: яйца, сыр, помидоры"
              />
            </Accordion>
          </Section>

          <Section>
            <SectionTitle>3) Пожелания</SectionTitle>
            <Accordion>
              <AccordionSummary>Открыть пожелания и ограничения</AccordionSummary>
              <Textarea
                value={preferencesText}
                onChange={(event) => setPreferencesText(event.target.value)}
                placeholder="Пожелания: здоровое питание, исключить лук, без сахара"
              />
            </Accordion>
          </Section>

          <PromoRow>
            <PromoInput
              value={promoCode}
              onChange={(event) => setPromoCode(event.target.value)}
              placeholder="Введите промокод"
            />
            <TopupButton type="button" disabled={promoLoading} onClick={onRedeemPromo}>
              {promoLoading ? 'Проверяем...' : 'Активировать промокод'}
            </TopupButton>
          </PromoRow>
          {promoMessage && <Hint>{promoMessage}</Hint>}
          <ActionRow>
            <PrimaryButton type="button" onClick={onFindRecipes} disabled={loading}>
              {loading ? 'Ищем...' : `Подобрать рецепты (${requestCostStars}⭐)`}
            </PrimaryButton>
            <ProductsInfo>
              Баланс: {typeof starsBalance === 'number' ? `${starsBalance}⭐` : '...'}
            </ProductsInfo>
            <ProductsInfo>
              Продукты: {allProducts.length > 0 ? allProducts.join(', ') : 'не добавлены'}
            </ProductsInfo>
            {preferencesText.trim() && (
              <ProductsInfo>Пожелания: {preferencesText.trim()}</ProductsInfo>
            )}
          </ActionRow>
          <TopupRow>
            {topupPackages.map((item) => (
              <TopupButton
                key={item.id}
                type="button"
                disabled={topupLoadingId !== null}
                onClick={() => onTopup(item.id)}
              >
                {topupLoadingId === item.id
                  ? 'Ожидание оплаты...'
                  : `Пополнить ${item.stars}⭐ за ${item.priceXtr}⭐`}
              </TopupButton>
            ))}
          </TopupRow>
          {error && <ErrorText>{error}</ErrorText>}

          <Section>
            <SectionTitle>4) Подходящие рецепты</SectionTitle>
            {!loading && matchedRecipes.length === 0 && !error && (
              <EmptyState>
                Пока не нашел подходящих рецептов. Добавь больше продуктов или измени список.
              </EmptyState>
            )}
            {matchedRecipes.map((recipe) => (
              <RecipeCard key={recipe.id}>
                <RecipeTitle>{recipe.title}</RecipeTitle>
                <RecipeMeta>Ингредиенты: {recipe.ingredients.join(', ')}</RecipeMeta>
                <Steps>
                  {recipe.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </Steps>
              </RecipeCard>
            ))}
            {note && <Hint>{note}</Hint>}
          </Section>
      </Card>
    </Page>
  )
}

const Page = styled.main`
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 20px;
  background: linear-gradient(180deg, #1f71df 0%, #0f2b59 100%);
`

const Card = styled.section`
  width: min(760px, 100%);
  border-radius: 20px;
  padding: 20px;
  background: #0f1f3d;
  color: #eaf2ff;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 22px 60px rgba(4, 9, 20, 0.45);
`

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  h1 {
    margin: 0;
    font-size: 22px;
  }
`

const Section = styled.section`
  margin-top: 18px;
`

const SectionTitle = styled.h2`
  margin: 0 0 10px;
  font-size: 16px;
`

const AgreementList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const AgreementItem = styled.div`
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.03);
`

const AgreementTitle = styled.h3`
  margin: 0 0 8px;
  font-size: 14px;
`

const AgreementText = styled.p`
  margin: 0 0 6px;
  font-size: 13px;
  color: #c9dbff;
`

const AgreementActions = styled.div`
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const AgreementCheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #d4e3ff;
`

const HiddenFileInput = styled.input`
  display: none;
`

const UploadActions = styled.div`
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`

const UploadButton = styled.button`
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 12px;
  padding: 10px 14px;
  color: #eaf2ff;
  cursor: pointer;
  background: #1f71df;
`

const CameraButton = styled.button`
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 12px;
  padding: 10px 14px;
  color: #eaf2ff;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.08);
`

const CameraPanel = styled.div`
  margin-top: 10px;
  max-width: 360px;
`

const CameraVideo = styled.video`
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: #020813;
`

const CameraControls = styled.div`
  margin-top: 8px;
  display: flex;
  gap: 8px;
`

const CancelButton = styled(CameraButton)`
  background: rgba(255, 100, 100, 0.2);
`

const PreviewArea = styled.div`
  width: min(300px, 100%);
`

const Preview = styled.img`
  width: 100%;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.16);
`

const PreviewPlaceholder = styled.div`
  width: 100%;
  min-height: 170px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  padding: 14px;
  text-align: center;
  font-size: 13px;
  color: #b9cfff;
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed rgba(255, 255, 255, 0.2);
`

const Hint = styled.p`
  margin: 8px 0 0;
  font-size: 13px;
  color: #b9cfff;
`

const Textarea = styled.textarea`
  width: 100%;
  min-height: 90px;
  resize: vertical;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 12px;
  color: #eaf2ff;
  background: rgba(255, 255, 255, 0.06);
  outline: none;
`

const Accordion = styled.details`
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  padding: 10px;
`

const AccordionSummary = styled.summary`
  cursor: pointer;
  font-size: 14px;
  color: #d8e8ff;
  margin-bottom: 10px;
  user-select: none;
`

const ActionRow = styled.div`
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
`

const TopupRow = styled.div`
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`

const PromoRow = styled.div`
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`

const PromoInput = styled.input`
  min-width: 230px;
  flex: 1 1 260px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  padding: 8px 10px;
  color: #ecf3ff;
  background: rgba(255, 255, 255, 0.06);
  outline: none;
`

const TopupButton = styled.button`
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 10px;
  padding: 8px 10px;
  color: #dbe9ff;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.08);
`

const PrimaryButton = styled.button`
  border: 0;
  border-radius: 12px;
  padding: 11px 14px;
  font-weight: 700;
  color: #eff6ff;
  cursor: pointer;
  background: linear-gradient(135deg, #2d8fff, #4d66ff);

  &:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
`

const ProductsInfo = styled.p`
  margin: 0;
  font-size: 13px;
  color: #c9dbff;
`

const RecipeCard = styled.article`
  margin-top: 10px;
  border-radius: 14px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.07);
`

const RecipeTitle = styled.h3`
  margin: 0 0 6px;
  font-size: 15px;
`

const RecipeMeta = styled.p`
  margin: 4px 0;
  font-size: 13px;
  color: #c5d8ff;
`

const Steps = styled.ol`
  margin: 8px 0 0;
  padding-left: 20px;
  font-size: 13px;
`

const EmptyState = styled.p`
  margin: 0;
  color: #c5d8ff;
`

const ErrorText = styled.p`
  margin: 10px 0 0;
  color: #ffb4b4;
  font-size: 13px;
`

export default App

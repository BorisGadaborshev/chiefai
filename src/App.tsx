import { useEffect, useMemo, useState } from 'react'
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
}

type TelegramWebApp = {
  initData: string
  ready?: () => void
  expand?: () => void
}

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp
  }
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
  const isTelegramLaunch = Boolean(telegramWebApp && telegramInitData)
  const hostname = window.location.hostname
  const isLocalDevelopment =
    import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(hostname)
  const isAllowedLaunch = isTelegramLaunch || isLocalDevelopment

  const [productsText, setProductsText] = useState('')
  const [preferencesText, setPreferencesText] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [matchedRecipes, setMatchedRecipes] = useState<Recipe[]>([])

  useEffect(() => {
    telegramWebApp?.ready?.()
    telegramWebApp?.expand?.()
  }, [telegramWebApp])

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null)
      return
    }

    const objectUrl = URL.createObjectURL(imageFile)
    setImagePreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [imageFile])

  const allProducts = useMemo(() => {
    const fromText = getProductsFromText(productsText)
    return [...new Set(fromText)]
  }, [productsText])

  const onPhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setImageFile(file)
  }

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
        const errorMessage = payload.details
          ? `${payload.error}: ${payload.details}`
          : payload.error || 'Ошибка запроса к серверу'
        throw new Error(errorMessage)
      }

      setMatchedRecipes(Array.isArray(payload.recipes) ? payload.recipes : [])
      setNote(payload.note ?? payload.rawText ?? null)
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Неизвестная ошибка запроса'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page>
      {!isAllowedLaunch && (
        <Card>
          <Header>
            <h1>Chief Ai</h1>
          </Header>
          <Section>
            <SectionTitle>Доступ ограничен</SectionTitle>
            <EmptyState>
              Это приложение работает только внутри Telegram Mini App. Открой его через Telegram.
            </EmptyState>
          </Section>
        </Card>
      )}

      {isAllowedLaunch && (
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
          <UploadLabel>
            <input type="file" accept="image/*" onChange={onPhotoChange} />
            Выбрать фото
          </UploadLabel>
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

        <ActionRow>
          <PrimaryButton type="button" onClick={onFindRecipes} disabled={loading}>
            {loading ? 'Ищем...' : 'Подобрать рецепты'}
          </PrimaryButton>
          <ProductsInfo>
            Продукты: {allProducts.length > 0 ? allProducts.join(', ') : 'не добавлены'}
          </ProductsInfo>
          {preferencesText.trim() && <ProductsInfo>Пожелания: {preferencesText.trim()}</ProductsInfo>}
        </ActionRow>
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
      )}
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

const UploadLabel = styled.label`
  display: inline-block;
  margin-top: 10px;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 14px;
  cursor: pointer;
  background: #1f71df;

  input {
    display: none;
  }
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

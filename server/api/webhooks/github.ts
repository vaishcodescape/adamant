import { Hono } from 'hono'
import * as crypto from 'crypto'
import { WebhookService } from '../services/webhookService.ts'

const github = new Hono()

function verifySignature(signature: string | null, rawBody: string, secret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false

  try {
    const hmac = crypto.createHmac('sha256', secret)
    hmac.update(rawBody)
    const expectedSignature = `sha256=${hmac.digest('hex')}`

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  } catch {
    return false
  }
}

github.post('/', async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.warn('GITHUB_WEBHOOK_SECRET is not set.')
    return c.json({ error: 'Server configuration error' }, 500)
  }

  const signature = c.req.header('x-hub-signature-256') ?? null
  const event = c.req.header('x-github-event') ?? ''
  const deliveryId = c.req.header('x-github-delivery') ?? ''

  if (!deliveryId) {
    return c.json({ error: 'Missing delivery ID' }, 400)
  }

  // We need the raw text to verify the HMAC signature
  const rawBody = await c.req.text()

  if (!verifySignature(signature, rawBody, secret)) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  try {
    // Process the webhook asynchronously or await it based on logic.
    // The architecture says: "Duplicate delivery_id -> ACK, no second run"
    // "Insert webhook_deliveries before the run."
    await WebhookService.processEvent(deliveryId, event, payload)
    return c.json({ message: 'Accepted' }, 202)
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Duplicate delivery') {
      return c.json({ message: 'Duplicate delivery ignored' }, 202)
    }
    console.error('Webhook processing error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { github }

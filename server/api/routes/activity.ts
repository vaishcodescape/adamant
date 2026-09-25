import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.ts'

const activity = new Hono()

// Secure SSE endpoint with User Authentication
activity.use('*', authMiddleware)

activity.get('/', async (c) => {
  // Stub for SSE events used by `adamant watch`
  // In a real implementation, this would use hono/streaming
  return c.json({ message: 'SSE stream connected (stub)' })
})

export { activity }

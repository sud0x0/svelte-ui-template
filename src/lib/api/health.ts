import { request } from './client'
import { assertHealthResponse, type HealthResponse } from '../types/api'

/**
 * Fetches `GET /health` — the one unauthenticated reference resource. Proves the
 * client + boundary-guard + MSW test surfaces end to end without a live backend.
 */
export async function getHealth(): Promise<HealthResponse> {
  return assertHealthResponse(await request<unknown>('/health'))
}

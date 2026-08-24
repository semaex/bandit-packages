import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Contrato de firma del canal BFF→core, espejo exacto de
 * `bandit/api/src/Core/Shared/Infrastructure/Security/CoreSignedRequest.php`.
 *
 * Cadena canónica (saltos de línea literales):
 *
 *     {MÉTODO}\n{requestUri incluida la query}\n{sha256hex(cuerpo)}\n{timestamp}\n{nonce}
 *
 * ⚠ Cualquier cambio aquí hay que hacerlo a la vez en el PHP, o el core empieza a
 * devolver 401 a todo.
 */
export const SIGNATURE_HEADERS = {
  client: 'X-Bandit-Client',
  timestamp: 'X-Bandit-Timestamp',
  nonce: 'X-Bandit-Nonce',
  signature: 'X-Bandit-Signature',
  actingUser: 'X-Acting-User-Id'
} as const

export interface SignatureInput {
  method: string
  /** Path + query tal cual va a viajar. Debe ser byte a byte lo que se manda. */
  requestUri: string
  body: string
  clientId: string
  signingSecret: string
}

export interface SignatureHeaders {
  [header: string]: string
}

export function canonicalString(
  method: string,
  requestUri: string,
  body: string,
  timestamp: string,
  nonce: string
): string {
  return [
    method.toUpperCase(),
    requestUri,
    createHash('sha256').update(body, 'utf8').digest('hex'),
    timestamp,
    nonce
  ].join('\n')
}

export function signRequest(input: SignatureInput): SignatureHeaders {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')

  const signature = createHmac('sha256', input.signingSecret)
    .update(canonicalString(input.method, input.requestUri, input.body, timestamp, nonce), 'utf8')
    .digest('hex')

  return {
    [SIGNATURE_HEADERS.client]: input.clientId,
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.nonce]: nonce,
    [SIGNATURE_HEADERS.signature]: signature
  }
}

/**
 * Codificación RFC 3986 de la query.
 *
 * ⚠ No se usa `URLSearchParams`: escribe los espacios como `+` y `fetch` puede
 * renormalizar la cadena, y en cuanto el servidor ve un byte distinto del firmado la
 * firma deja de cuadrar. Aquí se genera la cadena una sola vez y esa misma se firma y
 * se envía.
 */
export function encodeQuery(params: Record<string, unknown>): string {
  const parts: string[] = []

  const push = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') {
      return
    }
    parts.push(`${rfc3986(key)}=${rfc3986(String(value))}`)
  }

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => push(`${key}[]`, item))
      continue
    }
    if (typeof value === 'boolean') {
      push(key, value ? 1 : 0)
      continue
    }
    push(key, value)
  }

  return parts.join('&')
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

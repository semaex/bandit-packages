import { SIGNATURE_HEADERS, encodeQuery, signRequest } from './signature'
import { type Scope, scopeToQuery } from './scope'
import type {
  CustomerInvoices,
  PaginatedInvoices,
  SearchInvoicesParams,
  MonthlyBilling,
  Paginated,
  SearchSubscriptionsParams,
  SubscriptionRow,
  SubscriptionsSummary
} from './types'

export interface CoreClientOptions {
  /** Raíz del core, sin barra final. Ej. `https://api.devel.bandit.show:44344`. */
  baseUrl: string
  /** Identificador de este cliente. Cada uno tiene su clave para poder revocar sin tirar a los demás. */
  clientId: string
  signingSecret: string
  timeoutMs?: number
  /** Reintentos ante fallo de red o 5xx. Nunca ante 4xx: un 409 no mejora repitiéndolo. */
  retries?: number
}

/**
 * ⚠ Aquí hubo un `allowInsecureTls` y se quitó a propósito.
 *
 * Apagaba `NODE_TLS_REJECT_UNAUTHORIZED` para todo el proceso, no sólo para este cliente,
 * porque Node no deja acotar la verificación por petición sin traerse `undici`. Mientras
 * hubo un único core al que hablar era discutible; en cuanto un mismo proceso apunta a un
 * core local y a uno de producción, deja de serlo: una vez apagado, las llamadas a
 * producción también viajan sin verificar.
 *
 * La forma correcta de hablar con un core local de certificado autofirmado es arrancar el
 * proceso con `NODE_EXTRA_CA_CERTS` apuntando a ese certificado. Así la verificación sigue
 * activa para todo lo demás.
 */

/**
 * Contexto de quien llama. Lo resuelve cada BFF a su manera — este paquete no sabe de
 * autenticación (§9.1 regla 5).
 */
export interface CallerContext {
  /** Viaja como `X-Acting-User-Id`. Informativo para logs y Sentry; el core nunca decide con él. */
  userId?: string | null
}

export class CoreRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly path: string
  ) {
    super(message)
    this.name = 'CoreRequestError'
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 1

export class CoreClient {
  private readonly baseUrl: string

  constructor(private readonly options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  // ---------------------------------------------------------------- suscripciones

  /**
   * Listado unificado de suscripciones de agencia y de artista. Es una sola query del core
   * a propósito: unir las dos aquí obligaría a traerse las dos listas enteras para ordenar
   * y paginar en memoria.
   */
  searchSubscriptions(
    params: SearchSubscriptionsParams,
    context: CallerContext & { scope: Scope }
  ): Promise<Paginated<SubscriptionRow>> {
    return this.get('/core/v1/subscriptions/search', this.subscriptionQuery(params, context.scope), context)
  }

  /** Resumen del MISMO conjunto que devuelve `searchSubscriptions` con esos filtros. */
  findSubscriptionsSummary(
    params: SearchSubscriptionsParams,
    context: CallerContext & { scope: Scope }
  ): Promise<SubscriptionsSummary> {
    return this.get('/core/v1/subscriptions/summary', this.subscriptionQuery(params, context.scope), context)
  }

  private subscriptionQuery(params: SearchSubscriptionsParams, scope: Scope): Record<string, unknown> {
    return {
      ...scopeToQuery(scope),
      terms: params.terms,
      statuses: params.statuses,
      planCommonTags: params.planCommonTags,
      customerTypes: params.customerTypes,
      atCapOnly: params.atCapOnly,
      onlyBilled: params.onlyBilled,
      orderBy: params.orderBy,
      limit: params.limit,
      offset: params.offset
    }
  }

  // ------------------------------------------------------------------ facturación

  /** Listado de facturas emitidas, de la más reciente a la más antigua. */
  searchInvoices(
    params: SearchInvoicesParams,
    context: CallerContext & { scope: Scope }
  ): Promise<PaginatedInvoices> {
    return this.get('/core/v1/invoices/search', {
      ...scopeToQuery(context.scope),
      serieGroups: params.serieGroups,
      customerTypes: params.customerTypes,
      from: params.from,
      to: params.to,
      terms: params.terms,
      orderBy: params.orderBy,
      limit: params.limit,
      offset: params.offset
    }, context)
  }

  /**
   * Token de sesión para entrar como otro usuario, sin su contraseña.
   *
   * ⚠ Lo que autoriza esto es la firma HMAC de este cliente. Su clave vale, por tanto, lo
   * que la contraseña de todos los usuarios juntos: no la repartas ni la reutilices entre
   * servicios, porque revocarla es lo único que corta el acceso.
   */
  generateImpersonationToken(
    userId: string,
    context: CallerContext & { scope: Scope }
  ): Promise<{ token: string }> {
    const query = encodeQuery(scopeToQuery(context.scope))

    return this.send(
      'POST',
      `/core/v1/users/${encodeURIComponent(userId)}/impersonation-token${query ? '?' + query : ''}`,
      {},
      context
    )
  }

  /** Facturas de un cliente y lo que ha facturado en toda su vida. */
  findCustomerInvoices(
    customerType: 'agency' | 'artist',
    customerId: string,
    context: CallerContext & { scope: Scope }
  ): Promise<CustomerInvoices> {
    return this.get(
      `/core/v1/customers/${customerType}/${encodeURIComponent(customerId)}/invoices`,
      scopeToQuery(context.scope),
      context
    )
  }

  /** Serie mensual continua desde la primera factura hasta el mes en curso. */
  findMonthlyBilling(context: CallerContext & { scope: Scope }): Promise<MonthlyBilling> {
    return this.get('/core/v1/invoices/monthly-billing', scopeToQuery(context.scope), context)
  }

  extendAgencySubscriptionGrace(
    agencyId: string,
    days: number,
    context: CallerContext = {}
  ): Promise<null> {
    return this.send('POST', `/core/v1/agencies/${encodeURIComponent(agencyId)}/subscription/extend-grace`, { days }, context)
  }

  extendArtistSubscriptionGrace(
    artistId: string,
    days: number,
    context: CallerContext = {}
  ): Promise<null> {
    return this.send('POST', `/core/v1/artists/${encodeURIComponent(artistId)}/subscription/extend-grace`, { days }, context)
  }

  /**
   * Alarga la prueba. ⚠ A diferencia de la gracia, el core **no** toma el máximo: fija
   * `trialEndsAt` a hoy + días, así que un valor menor que lo que queda la acorta. Y sólo
   * admite una prueba ya caducada.
   */
  extendAgencySubscriptionTrial(
    agencyId: string,
    days: number,
    context: CallerContext = {}
  ): Promise<null> {
    return this.send('POST', `/core/v1/agencies/${encodeURIComponent(agencyId)}/subscription/extend-trial`, { days }, context)
  }

  extendArtistSubscriptionTrial(
    artistId: string,
    days: number,
    context: CallerContext = {}
  ): Promise<null> {
    return this.send('POST', `/core/v1/artists/${encodeURIComponent(artistId)}/subscription/extend-trial`, { days }, context)
  }

  /** `-1` = ilimitado. El core rechaza un tope por debajo del que concede el plan. */
  changeAgencySubscriptionMaxArtists(
    agencyId: string,
    maxArtists: number,
    context: CallerContext = {}
  ): Promise<null> {
    return this.send('PUT', `/core/v1/agencies/${encodeURIComponent(agencyId)}/subscription/max-artists`, { maxArtists }, context)
  }

  // ---------------------------------------------------------------------- genérico

  async get<T>(path: string, query: Record<string, unknown>, context: CallerContext = {}): Promise<T> {
    const queryString = encodeQuery(query)

    return this.request<T>('GET', queryString ? `${path}?${queryString}` : path, '', context)
  }

  async send<T>(method: string, path: string, body: unknown, context: CallerContext = {}): Promise<T> {
    return this.request<T>(method, path, JSON.stringify(body ?? {}), context)
  }

  private async request<T>(
    method: string,
    requestUri: string,
    body: string,
    context: CallerContext
  ): Promise<T> {
    const retries = this.options.retries ?? DEFAULT_RETRIES

    let lastError: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.attempt<T>(method, requestUri, body, context)
      } catch (error) {
        lastError = error

        // Un 4xx es una respuesta, no un fallo: repetirlo da lo mismo y además
        // quemaría un nonce nuevo por nada.
        if (error instanceof CoreRequestError && error.status < 500) {
          throw error
        }
      }
    }

    throw lastError
  }

  private async attempt<T>(
    method: string,
    requestUri: string,
    body: string,
    context: CallerContext
  ): Promise<T> {
    // ⚠ Se firma exactamente la misma cadena `requestUri` que se envía. Si se
    // reconstruyera la URL con `new URL()` podría renormalizarse y la firma no cuadraría.
    const headers: Record<string, string> = {
      ...signRequest({
        method,
        requestUri,
        body,
        clientId: this.options.clientId,
        signingSecret: this.options.signingSecret
      }),
      Accept: 'application/json'
    }

    if (body !== '') {
      headers['Content-Type'] = 'application/json'
    }

    if (context.userId) {
      headers[SIGNATURE_HEADERS.actingUser] = context.userId
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.baseUrl}${requestUri}`, {
        method,
        headers,
        body: body === '' ? undefined : body,
        signal: controller.signal
      })

      return await this.readResponse<T>(response, requestUri)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readResponse<T>(response: Response, requestUri: string): Promise<T> {
    const text = await response.text()
    const payload = text ? safeJsonParse(text) : null

    if (!response.ok) {
      throw new CoreRequestError(
        (payload as { message?: string } | null)?.message ?? `Core responded ${response.status}`,
        response.status,
        (payload as { code?: string } | null)?.code ?? null,
        requestUri
      )
    }

    // El core envuelve todas las respuestas en `{ data: … }`.
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data
    }

    return payload as T
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Tipos del contrato de `/core/v1`. El core devuelve dato canónico: fechas en ISO 8601 y estados numéricos. */

/** Espejo de `App\Shared\Domain\Subscription\SubscriptionStatus`. */
export enum SubscriptionStatus {
  Trial = 1,
  Active = 2,
  Grace = 3,
  TrialExpired = 4,
  Expired = 5
}

/** Espejo de `App\Agency\Domain\AgencyStatus` y `App\Artist\Domain\ArtistStatus` (comparten valores). */
export enum SubscriberStatus {
  Active = 1,
  Deactivated = 2,
  Expired = 3,
  Deleted = 4
}

/** `-1` en un tope de artistas significa ilimitado. */
export const UNLIMITED_ARTISTS = -1

export interface Paginated<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

/** Quién es el suscriptor. Espejo de `App\SubscriptionSearch\Domain\CustomerType`. */
export type CustomerType = 'agency' | 'artist'

export const CUSTOMER_TYPES: CustomerType[] = ['agency', 'artist']

/**
 * Fila del listado unificado. Los campos de tope de artistas llegan a `null` para un
 * artista individual: no tiene tope, y un 0 se leería como "no le caben".
 */
export interface SubscriptionRow {
  subscriptionId: string
  customerType: CustomerType
  customerId: string
  customerName: string
  customerImage: string | null
  customerStatus: SubscriberStatus
  customerCountry: string | null
  status: SubscriptionStatus
  /** Tope efectivo de la suscripción; puede diferir del plan. `null` en artistas. */
  maxArtists: number | null
  /** Artistas activos que cuelgan hoy de la agencia. `null` en artistas. */
  artistsCount: number | null
  planId: string
  planTag: string | null
  planName: string | null
  /** Familia comercial del plan (`small`, `mini`, `pro`…). `null` en los planes a medida. */
  planCommonTag: string | null
  planMaxArtists: number | null
  planIntervalType: number | null
  planPrice: number | null
  /** Importe anual estimado sin IVA. `null` cuando no hay forma de calcularlo. */
  annualPrice: number | null
  /** true si el importe viene del precio negociado de la suscripción, no del plan. */
  annualPriceIsOverride: boolean
  promoCode: string | null
  /**
   * Cuándo esta suscripción pasó a ser de pago. `null` si sigue en prueba, o si es anterior
   * a que existiera el campo: para esas el dato ya estaba sobrescrito y no se inventó.
   *
   * ⚠ No confundir con `createdAt` —cuándo se creó la suscripción, que en las que empiezan
   * por prueba es el inicio del trial— ni con `startsAt`, que es el ciclo en curso y se
   * reescribe en cada renovación.
   */
  subscribedAt: string | null
  /** Alta de la suscripción. En las que vienen de prueba, el inicio del trial. */
  createdAt: string | null
  trialEndsAt: string | null
  startsAt: string | null
  endsAt: string | null
  graceEndsAt: string | null
  graceExtendedAt: string | null
  cancelledAt: string | null
  isAutoRenewal: boolean
  ownerUserId: string | null
  ownerName: string | null
  ownerEmail: string | null
}

export interface SubscriptionsSummaryBucket {
  subscriptions: number
  annualPrice: number
  /** Suscripciones del grupo sin importe calculable — no suman, y esconderlas mentiría. */
  withoutPrice: number
}

export interface SubscriptionsSummary {
  byPlanCommonTag: Array<SubscriptionsSummaryBucket & { planCommonTag: string | null }>
  byCustomerType: Array<SubscriptionsSummaryBucket & { customerType: CustomerType }>
  byStatus: Array<SubscriptionsSummaryBucket & { status: SubscriptionStatus }>
  totals: SubscriptionsSummaryBucket
}

export interface SearchSubscriptionsParams {
  terms?: string
  statuses?: SubscriptionStatus[]
  customerTypes?: CustomerType[]
  /** Solo agencias que ya han llegado a su tope. Deja fuera a los artistas. */
  atCapOnly?: boolean
  /** Excluye las suscripciones de cortesía (importe puesto a 0 a mano). */
  onlyBilled?: boolean
  orderBy?: string
  limit?: number
  offset?: number
}

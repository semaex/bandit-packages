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
  /** Inicio de la prueba. Sólo el detalle lo usa; en el listado no cabe. */
  trialStartsAt: string | null
  trialEndsAt: string | null
  startsAt: string | null
  endsAt: string | null
  graceEndsAt: string | null
  graceExtendedAt: string | null
  cancelledAt: string | null
  isAutoRenewal: boolean
  /**
   * Lo facturado a este cliente en toda su vida, sin IVA y neto de abonos.
   *
   * Cuelga del cliente y no de la suscripción, así que sobrevive a que ésta se borre y se
   * rehaga. Viene calculado por el core porque es columna ordenable: sumarlo aquí obligaría
   * a ordenar después de paginar, que devuelve la página equivocada.
   */
  lifetimeBilled: number
  ownerUserId: string | null
  ownerName: string | null
  ownerEmail: string | null
}

export interface SubscriptionsSummaryBucket {
  /** Todas las suscripciones del grupo que cumplen el filtro. */
  subscriptions: number
  /**
   * Las que generan ingreso: en estado de pago (activa o gracia) y con importe > 0.
   *
   * ⚠ Es la cifra de negocio, y **no coincide con `subscriptions`**. No son suscriptores:
   * las de cortesía, las de plan a medida sin precio pactado —que suelen ser la segunda
   * agencia de un cliente que paga una sola vez— y las que están en prueba, que tienen
   * plan y por tanto precio pero todavía no facturan.
   */
  subscribers: number
  /** Importe anual de los `subscribers`, sin IVA. Ni las pruebas ni las cortesías suman. */
  annualPrice: number
  /** Con importe puesto a 0 a mano. */
  courtesy: number
  /** Sin importe calculable: plan a medida sin precio pactado. */
  withoutPrice: number
}

export interface SubscriptionsSummary {
  byPlanCommonTag: Array<SubscriptionsSummaryBucket & { planCommonTag: string | null }>
  byCustomerType: Array<SubscriptionsSummaryBucket & { customerType: CustomerType }>
  byStatus: Array<SubscriptionsSummaryBucket & { status: SubscriptionStatus }>
  totals: SubscriptionsSummaryBucket
}

/** Centinela para la familia «sin tag común»: los planes Personalizado. */
export const NO_PLAN_FAMILY = '__none__'

export interface SearchSubscriptionsParams {
  terms?: string
  statuses?: SubscriptionStatus[]
  /** Familias de plan (`small`, `mini`…). Para los Personalizado, `NO_PLAN_FAMILY`. */
  planCommonTags?: string[]
  customerTypes?: CustomerType[]
  /** Solo agencias que ya han llegado a su tope. Deja fuera a los artistas. */
  atCapOnly?: boolean
  /** Excluye las suscripciones de cortesía (importe puesto a 0 a mano). */
  onlyBilled?: boolean
  orderBy?: string
  limit?: number
  offset?: number
}

export interface InvoiceBillingData {
  name: string | null
  vatNumber: string | null
  address: string | null
  postalCode: string | null
  city: string | null
  country: string | null
}

export interface CustomerInvoice {
  id: string
  /** Número tal y como se emitió (`:c/:yyyy/:s` y variantes por serie). */
  number: string
  date: string | null
  /** Sin IVA. Negativo en los abonos. */
  baseAmount: number
  taxesAmount: number
  totalAmount: number
  /**
   * Los datos fiscales con los que se emitió ESTA factura. Van con la factura y no con el
   * cliente porque son los que se declararon ese día: si el cliente cambia de sociedad, las
   * antiguas siguen diciendo a nombre de quién se emitieron.
   */
  billing: InvoiceBillingData
}

export interface CustomerInvoices {
  items: CustomerInvoice[]
  /** Suma neta de `baseAmount`. Va aparte porque `items` podría paginarse algún día. */
  lifetimeBilled: number
}

export interface BillingMonth {
  /** `YYYY-MM`. */
  month: string
  /** Sin IVA, neto de abonos. Cero en los meses sin facturar, que no faltan de la serie. */
  baseAmount: number
  invoices: number
}

export interface MonthlyBilling {
  months: BillingMonth[]
  total: number
}

export type InvoiceSerieGroup = 'C' | 'M' | 'R'

export interface InvoiceRow {
  id: string
  /** Número tal y como se emitió. */
  number: string
  /** Serie literal (`C23`, `21M`…). */
  serie: string
  /**
   * Familia de la serie. Las series llevaron sufijo de año hasta 2023 y desde 2024 no, pero
   * son la misma serie a lo largo del tiempo: por eso se filtra por familia.
   */
  serieGroup: InvoiceSerieGroup | null
  date: string | null
  customerId: string
  customerType: CustomerType
  /** Nombre de la agencia o artista; cae a la razón social si el cliente ya no existe. */
  customerName: string | null
  /** Razón social con la que se emitió, que puede no ser el nombre de hoy del cliente. */
  billingName: string | null
  vatNumber: string | null
  /** Sin IVA. Negativo en los abonos. */
  baseAmount: number
  taxesAmount: number
  totalAmount: number
}

export interface InvoiceTotals {
  invoices: number
  baseAmount: number
  taxesAmount: number
  totalAmount: number
}

export interface SearchInvoicesParams {
  serieGroups?: string
  customerTypes?: string
  /** `YYYY-MM-DD`. */
  from?: string
  to?: string
  terms?: string
  orderBy?: string
  limit?: number
  offset?: number
}

export interface PaginatedInvoices extends Paginated<InvoiceRow> {
  /** Sumas del conjunto filtrado entero, no de la página. */
  totals: InvoiceTotals
}

export type ArtistStatus = 1 | 2 | 3 | 4

export interface AgencyArtist {
  id: string
  name: string
  /** URL completa; la compone el core, que es quien sabe dónde viven los ficheros. */
  imageUrl: string | null
  /** 1 activo, 2 desactivado, 3 caducado, 4 borrado. */
  status: ArtistStatus
  createdAt: string | null
}

export interface ForecastMonth {
  /** `YYYY-MM`. */
  month: string
  /** Sin IVA. Lo que se espera cobrar ese mes. */
  amount: number
  renewals: number
}

export interface UpcomingRenewal {
  subscriptionId: string
  customerType: CustomerType
  customerId: string
  customerName: string
  /** `YYYY-MM-DD`. */
  date: string
  amount: number
  /** Ciclo medido de la suscripción: 1 mensual, 12 anual. */
  cycleMonths: number
  status: SubscriptionStatus
}

export interface BillingForecast {
  months: ForecastMonth[]
  total: number
  /** Los cobros uno a uno dentro de la ventana, del más próximo al más lejano. */
  upcoming: UpcomingRenewal[]
}

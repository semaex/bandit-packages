import { SIGNATURE_HEADERS, encodeQuery, signRequest } from './signature'
import { type Scope, scopeToQuery } from './scope'
import type {
  AgencyRosterSending,
  AgencySmtpSettingsInput,
  AgencySmtpTestInput,
  SenderDomainCheck,
  SenderDomainCheckParams,
  AgencyArtist,
  ContactDetail,
  ContactListParams,
  ContactOwnerFacet,
  ContactRow,
  ContactUpdateBody,
  ConcertCalendarDay,
  ConcertRow,
  ConcertsSummary,
  ConcertYear,
  SearchConcertsOverviewParams,
  AgencyOption,
  ArtistDetail,
  ArtistRow,
  ArtistsSummary,
  BinaryResponse,
  InvoiceDetail,
  BillingForecast,
  CustomerFlow,
  CustomerType,
  CustomerInvoices,
  CustomerUsage,
  PaginatedInvoices,
  SearchInvoicesParams,
  MonthlyBilling,
  Paginated,
  SearchSubscriptionsParams,
  SearchArtistsParams,
  SearchUsersParams,
  SubscriptionPlan,
  SubscriptionRow,
  SubscriptionsSummary,
  UserRow,
  UsersGrowth
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

/**
 * Ajustes de UNA llamada, para las pocas que no encajan con los del cliente.
 *
 * ⚠ Existe por la prueba de SMTP: habla con un servidor de terceros que puede tardar más que
 * los 10 s por defecto, y un aborto por tiempo se reintentaba — o sea, se mandaba el correo de
 * prueba dos veces. Una llamada con efectos fuera del core no se reintenta.
 */
export interface RequestOptions {
  timeoutMs?: number
  retries?: number
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
      customerIds: params.customerIds,
      planIds: params.planIds,
      atCapOnly: params.atCapOnly,
      atRisk: params.atRisk,
      onlyBilled: params.onlyBilled,
      notCancelled: params.notCancelled,
      usageLevels: params.usageLevels,
      usageTrends: params.usageTrends,
      endsAfter: params.endsAfter,
      trialEndsAfter: params.trialEndsAfter,
      orderBy: params.orderBy,
      limit: params.limit,
      offset: params.offset
    }
  }

  /**
   * Pone a mano el precio anual pactado y la familia de una suscripción.
   *
   * ⚠ **Los dos van siempre juntos**: el core escribe lo que llega, así que omitir uno lo
   * borra. Son la misma decisión comercial partida en dos columnas.
   */
  changeSubscriptionCommercialTerms(
    customerType: CustomerType,
    subscriptionId: string,
    terms: { annualPrice: number | null; planCommonTag: string | null },
    context: CallerContext
  ): Promise<void> {
    return this.send(
      'PUT',
      `/core/v1/subscriptions/${encodeURIComponent(customerType)}/${encodeURIComponent(subscriptionId)}/commercial-terms`,
      terms,
      context
    )
  }

  /**
   * El catálogo de planes de los dos tipos de cliente.
   *
   * ⚠ Devuelve una fila por plan real, sin agrupar: «Pack 3» son cuatro. Y **también los no
   * visibles**, que es donde está la mayoría de los suscriptores.
   */
  findSubscriptionPlans(context: CallerContext & { scope: Scope }): Promise<SubscriptionPlan[]> {
    return this.get('/core/v1/subscription-plans', scopeToQuery(context.scope), context)
  }

  /**
   * Previsión de cobro de aquí a `months` meses.
   *
   * Cuenta sólo lo que se va a cobrar de verdad: activas o en gracia, con renovación
   * automática puesta y con importe conocido.
   */
  findBillingForecast(
    months: number,
    context: CallerContext & { scope: Scope }
  ): Promise<BillingForecast> {
    return this.get('/core/v1/subscriptions/billing-forecast', {
      ...scopeToQuery(context.scope),
      months
    }, context)
  }

  /**
   * Altas y bajas de clientes de pago, por mes y por año, con el acumulado.
   *
   * Sin parámetros: es todo el histórico. Recortarlo por arriba dejaría el acumulado sin
   * punto de partida.
   */
  findCustomerFlow(context: CallerContext & { scope: Scope }): Promise<CustomerFlow> {
    return this.get('/core/v1/subscriptions/customer-flow', scopeToQuery(context.scope), context)
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

  // ------------------------------------------------------------------ usuarios

  /** Listado de usuarios de la plataforma. */
  searchUsers(
    params: SearchUsersParams,
    context: CallerContext & { scope: Scope }
  ): Promise<Paginated<UserRow>> {
    return this.get('/core/v1/users/search', {
      ...scopeToQuery(context.scope),
      terms: params.terms,
      activity: params.activity,
      onlyOwners: params.onlyOwners ? '1' : undefined,
      orderBy: params.orderBy,
      limit: params.limit,
      offset: params.offset
    }, context)
  }

  /** Altas de usuarios por año, con el acumulado y el reparto por tramo de actividad. */
  findUsersGrowth(context: CallerContext & { scope: Scope }): Promise<UsersGrowth> {
    return this.get('/core/v1/users/growth', scopeToQuery(context.scope), context)
  }

  // ------------------------------------------------------------------ artistas

  /** Listado de artistas con su dueño —usuario o agencia— ya resuelto. */
  searchArtists(
    params: SearchArtistsParams,
    context: CallerContext & { scope: Scope }
  ): Promise<Paginated<ArtistRow>> {
    return this.get('/core/v1/artists/search', {
      ...scopeToQuery(context.scope),
      terms: params.terms,
      statuses: params.statuses,
      ownerTypes: params.ownerTypes,
      subscriptionStatuses: params.subscriptionStatuses,
      ownerActivities: params.ownerActivities,
      usageLevels: params.usageLevels,
      orderBy: params.orderBy,
      limit: params.limit,
      offset: params.offset
    }, context)
  }

  /**
   * Reparto de artistas por estado de suscripción.
   *
   * Acepta los mismos filtros que el listado salvo el de suscripción, que el core se salta
   * porque es la dimensión que está contando: aplicándoselo a sí mismo, elegir un estado
   * dejaría los demás recuentos a cero.
   */
  findArtistsSummary(
    params: SearchArtistsParams,
    context: CallerContext & { scope: Scope }
  ): Promise<ArtistsSummary> {
    return this.get('/core/v1/artists/summary', {
      ...scopeToQuery(context.scope),
      terms: params.terms,
      statuses: params.statuses,
      // La actividad y el uso SÍ se aplican: no son de las dos dimensiones que cuenta, así
      // que el reparto tiene que ser el de los artistas que se están viendo.
      ownerActivities: params.ownerActivities,
      usageLevels: params.usageLevels
    }, context)
  }

  /**
   * Agencias para elegir una. Devuelve TODAS, también las que no tienen suscripción: al mover
   * un artista, la agencia destino puede no tener ninguna todavía.
   */
  searchAgencies(
    params: { terms?: string; limit?: number },
    context: CallerContext & { scope: Scope }
  ): Promise<{ items: AgencyOption[] }> {
    return this.get('/core/v1/agencies/search', {
      ...scopeToQuery(context.scope),
      terms: params.terms,
      limit: params.limit
    }, context)
  }

  /**
   * Mueve un artista a otro dueño: otra agencia (`ownerType` 2) u otro usuario (1).
   *
   * ⚠ Puede responder 409 (`agency_has_reached_maximum_artists_number`): el core rechaza la
   * mudanza si la agencia destino ha llegado a su tope de artistas.
   */
  changeArtistOwner(
    artistId: string,
    owner: { ownerType: number; ownerId: string },
    context: CallerContext & { scope: Scope }
  ): Promise<{ artistId: string; ownerType: number; ownerId: string }> {
    const query = encodeQuery(scopeToQuery(context.scope))

    return this.send(
      'POST',
      `/core/v1/artists/${encodeURIComponent(artistId)}/owner${query ? '?' + query : ''}`,
      owner,
      context
    )
  }

  /** Ficha de un artista. */
  findArtistDetail(
    artistId: string,
    context: CallerContext & { scope: Scope }
  ): Promise<ArtistDetail> {
    return this.get(
      `/core/v1/artists/${encodeURIComponent(artistId)}`,
      scopeToQuery(context.scope),
      context
    )
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

  /**
   * Artistas que cuelgan de una agencia. Devuelve TODOS, también los desactivados: el
   * recuento del listado cuenta sólo activos porque es el que se compara con el tope del
   * plan, y la diferencia entre ambos es justo lo que se viene a mirar.
   */
  findAgencyArtists(
    agencyId: string,
    context: CallerContext & { scope: Scope }
  ): Promise<{ items: AgencyArtist[] }> {
    return this.get(
      `/core/v1/agencies/${encodeURIComponent(agencyId)}/artists`,
      scopeToQuery(context.scope),
      context
    )
  }

  /**
   * Trabajo del cliente mes a mes.
   *
   * ⚠ Son ACCIONES, no conciertos: uno creado y editado el mismo mes cuenta en las dos
   * series. Sumarlas contesta «cuánto trabajo hubo», que es la pregunta.
   */
  findCustomerUsage(
    customerType: 'agency' | 'artist',
    customerId: string,
    months: number,
    context: CallerContext & { scope: Scope }
  ): Promise<CustomerUsage> {
    return this.get(
      `/core/v1/customers/${customerType}/${encodeURIComponent(customerId)}/usage`,
      { ...scopeToQuery(context.scope), months },
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

  /** Una factura con sus líneas y el concepto ya legible. */
  findInvoiceDetail(
    invoiceId: string,
    context: CallerContext & { scope: Scope },
    language = 'es'
  ): Promise<InvoiceDetail> {
    return this.get(
      `/core/v1/invoices/${encodeURIComponent(invoiceId)}`,
      { ...scopeToQuery(context.scope), language },
      context
    )
  }

  /**
   * El PDF de una factura, tal cual lo recibió el cliente.
   *
   * Va por `requestBinary` y no por `get`, que descodifica JSON: pasar un PDF por
   * `JSON.parse` no devuelve nada útil, y por `text()` se corrompen los bytes.
   */
  fetchInvoicePdf(
    invoiceId: string,
    context: CallerContext & { scope: Scope },
    language = 'es'
  ): Promise<BinaryResponse> {
    const query = encodeQuery({ ...scopeToQuery(context.scope), language })

    return this.requestBinary('GET', `/core/v1/invoices/${encodeURIComponent(invoiceId)}/pdf${query ? '?' + query : ''}`, context)
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
   * Desactiva a un cliente: caduca su suscripción y deja fuera a la agencia o al artista que
   * hay detrás. «Cliente» es el vocabulario de la pantalla —la unión de los dos—; lo que se
   * desactiva es siempre una de esas dos cosas.
   *
   * ⚠ **`cancelOnGateway` es la decisión importante, no un detalle.** Si la suscripción se
   * cobra por la pasarela hay que cancelarla también allí, o se le sigue cobrando a quien ya
   * no es cliente. Si se factura a mano —los planes a medida— no hay nada que cancelar y
   * pedirlo falla. Quien llama sabe cuál es el caso.
   */
  /**
   * Cancela la suscripción: **deja de cobrarse y nada más**.
   *
   * Marca la baja, apaga la renovación automática y le dice a Stripe `cancel_at_period_end`. El
   * cliente conserva lo que ha pagado hasta el final del ciclo y a partir de ahí es el cron
   * diario quien la pasa a gracia y luego a caducada.
   *
   * ⚠ **Esto y `deactivateCustomer` eran una sola llamada, y juntarlas costó un cliente.** Dar
   * de baja a alguien que pagaba y no usaba la plataforma lo sacaba además de su propia app.
   *
   * ⚠ **Exige suscripción ACTIVA y plan no personalizado**, y lo impone el dominio del core: una
   * prueba no se cancela y un plan a medida no se cobra por pasarela. En esos casos, 409 — lo
   * que aplica ahí es `expireCustomerSubscription`.
   */
  cancelCustomerSubscription(
    customerType: CustomerType,
    customerId: string,
    context: CallerContext = {}
  ): Promise<null> {
    const path = customerType === 'agency'
      ? `/core/v1/agencies/${encodeURIComponent(customerId)}/subscription/cancel`
      : `/core/v1/artists/${encodeURIComponent(customerId)}/subscription/cancel`

    return this.send('POST', path, {}, context)
  }

  /**
   * Caduca la suscripción AHORA, sin esperar a que se agote lo pagado.
   *
   * ⚠ **Cancelar es lo normal; esto es la excepción.** Sólo para lo que no se puede cancelar
   * —planes a medida, pruebas— o cuando hay devolución de por medio y no hay periodo que
   * respetar.
   *
   * ⚠ **`cancelOnGateway` viaja explícito**: si se cobra por la pasarela hay que cancelarlo
   * también allí; si se factura a mano, pedirlo falla.
   */
  expireCustomerSubscription(
    customerType: CustomerType,
    customerId: string,
    cancelOnGateway: boolean,
    context: CallerContext = {}
  ): Promise<null> {
    const path = customerType === 'agency'
      ? `/core/v1/agencies/${encodeURIComponent(customerId)}/subscription/expire`
      : `/core/v1/artists/${encodeURIComponent(customerId)}/subscription/expire`

    return this.send('POST', path, { cancelOnGateway }, context)
  }

  /**
   * Aparta a la agencia o al artista. NO toca la suscripción.
   *
   * ⚠ **Exige que esté ya caducada** y el core contesta 409 si no (`artist_is_subscribed` /
   * `agency_is_subscribed`): quien sigue suscrito sigue contando como cliente y, si se cobra por
   * la pasarela, sigue cobrándose.
   */
  deactivateCustomer(
    customerType: CustomerType,
    customerId: string,
    context: CallerContext = {}
  ): Promise<null> {
    const path = customerType === 'agency'
      ? `/core/v1/agencies/${encodeURIComponent(customerId)}/deactivate`
      : `/core/v1/artists/${encodeURIComponent(customerId)}/deactivate`

    return this.send('POST', path, {}, context)
  }

  /**
   * Deshace la desactivación de un ARTISTA. No reactiva su suscripción.
   *
   * ⚠ **No hay equivalente para agencias**: `Agency` no tiene `activate()` en el dominio y no se
   * ha inventado — reactivar una agencia arrastra a los artistas que cayeron con ella.
   */
  reactivateArtistCustomer(artistId: string, context: CallerContext = {}): Promise<null> {
    return this.send('POST', `/core/v1/artists/${encodeURIComponent(artistId)}/reactivate`, {}, context)
  }

  /**
   * El listado de contactos del backoffice.
   *
   * ⚠ **Sin `owner` devuelve los de TODAS las cuentas**, que es justo lo que hace falta para
   * repasar — y por eso exige alcance sin restricción. Un alcance acotado que omita el dueño se
   * lleva un 403.
   *
   * ⚠ **No excluye nada por defecto**, a diferencia del autocompletado del panel del promotor:
   * una pantalla de administración tiene que poder ver justo lo que aquél esconde. El filtro lo
   * pone quien llama.
   */
  listContacts(
    params: ContactListParams,
    context: CallerContext & { scope: Scope }
  ): Promise<Paginated<ContactRow>> {
    return this.send('POST', '/core/v1/contacts/list', { scope: context.scope, ...params }, context)
  }

  /**
   * Quién tiene contactos y cuántos, para el desplegable de cliente.
   *
   * ⚠ **Endpoint aparte y no un campo del listado**, a propósito: dentro se recalcularía en cada
   * página y el desplegable no cambia al paginar. Se pide al abrir y al cambiar de filtros.
   *
   * ⚠ **Exige alcance sin restricción** (403 si no): preguntar quién tiene agenda es preguntar por
   * todas las cuentas a la vez. Y no pagina — son 177 y crecen con los clientes, no con los
   * contactos; nadie pagina un desplegable.
   */
  listContactOwners(
    params: Omit<ContactListParams, 'owner' | 'orderBy' | 'direction' | 'limit' | 'offset'>,
    context: CallerContext & { scope: Scope }
  ): Promise<{ owners: ContactOwnerFacet[] }> {
    return this.send('POST', '/core/v1/contacts/owners', { scope: context.scope, ...params }, context)
  }

  findContact(
    contactId: string,
    context: CallerContext & { scope: Scope }
  ): Promise<{ contact: ContactDetail }> {
    return this.send('POST', `/core/v1/contacts/${encodeURIComponent(contactId)}`, { scope: context.scope }, context)
  }

  /**
   * ⚠ **Operaciones explícitas, nunca la lista entera.** El core aplica lo que llega, así que
   * mandar todos los teléfonos para cambiar uno borraría los que se omitan.
   */
  updateContact(
    contactId: string,
    body: ContactUpdateBody,
    context: CallerContext & { scope: Scope }
  ): Promise<unknown> {
    return this.send(
      'POST',
      `/core/v1/contacts/${encodeURIComponent(contactId)}/update`,
      { scope: context.scope, ...body },
      context
    )
  }

  /**
   * Da un contacto por revisado, o lo devuelve a la cola con `reviewed: false`.
   *
   * ⚠ **Una sola llamada porque es UNA decisión.** Quita la etiqueta `needs_review` y confirma el
   * log de migración; separarlo obligaría a cada cliente a saber que existe un log, y al primero
   * que se le olvidara dejaría contactos en circulación enseñando motivos de revisión.
   */
  markContactReviewed(
    contactId: string,
    reviewed: boolean,
    context: CallerContext & { scope: Scope }
  ): Promise<unknown> {
    return this.send(
      'POST',
      `/core/v1/contacts/${encodeURIComponent(contactId)}/mark-reviewed`,
      { scope: context.scope, reviewed },
      context
    )
  }

  /** Fusiona duplicados en el superviviente. La migración los crea, así que hace falta desde el día uno. */
  mergeContacts(
    survivorId: string,
    absorbedContactIds: string[],
    context: CallerContext & { scope: Scope }
  ): Promise<unknown> {
    return this.send(
      'POST',
      `/core/v1/contacts/${encodeURIComponent(survivorId)}/merge`,
      { scope: context.scope, absorbedContactIds },
      context
    )
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

  // ------------------------------------------------------------ envío de rosters

  /** SMTP propio de la agencia (sin contraseña, nunca) y su cupo de envíos desde bandit.show. */
  findAgencyRosterSending(agencyId: string, context: CallerContext = {}): Promise<AgencyRosterSending> {
    return this.get(`/core/v1/agencies/${encodeURIComponent(agencyId)}/roster-sending`, {}, context)
  }

  /**
   * Guarda el SMTP propio. Sin `password` (o vacía) el core conserva la guardada; volver a
   * guardar con la misma cifra una contraseña que estaba en claro.
   */
  setAgencySmtp(agencyId: string, settings: AgencySmtpSettingsInput, context: CallerContext = {}): Promise<null> {
    return this.send('PUT', `/core/v1/agencies/${encodeURIComponent(agencyId)}/roster-sending/smtp`, settings, context)
  }

  /** Quita el SMTP propio: la agencia vuelve a salir desde bandit.show, con cupo. */
  removeAgencySmtp(agencyId: string, context: CallerContext = {}): Promise<null> {
    return this.send('DELETE', `/core/v1/agencies/${encodeURIComponent(agencyId)}/roster-sending/smtp`, {}, context)
  }

  /**
   * Manda un correo de prueba con los valores DADOS, sin guardarlos. 422
   * `agency_smtp_test_failed` trae en `message` la respuesta del servidor SMTP.
   *
   * ⚠ **Sin reintentos y con más margen de tiempo**: el servidor es de terceros y puede tardar,
   * y reintentar tras un aborto mandaría la prueba dos veces.
   */
  testAgencySmtp(agencyId: string, input: AgencySmtpTestInput, context: CallerContext = {}): Promise<null> {
    return this.send(
      'POST',
      `/core/v1/agencies/${encodeURIComponent(agencyId)}/roster-sending/smtp/test`,
      input,
      context,
      { timeoutMs: 45_000, retries: 0 }
    )
  }

  /** SPF, DKIM, DMARC y MX del dominio remitente. Consulta DNS en vivo: margen de tiempo extra. */
  checkSenderDomain(params: SenderDomainCheckParams, context: CallerContext = {}): Promise<SenderDomainCheck> {
    return this.get('/core/v1/sender-domains/check', { ...params }, context, { timeoutMs: 20_000 })
  }

  // -------------------------------------------------------------------- conciertos

  /**
   * Listado de conciertos de toda la plataforma.
   *
   * ⚠ **No es `searchConcerts` del panel del promotor**: aquélla devuelve el concierto entero
   * con sus partes, y ésta contesta cuántos hay, de quién y cuándo.
   */
  searchConcertsOverview(
    params: SearchConcertsOverviewParams,
    context: CallerContext & { scope: Scope }
  ): Promise<Paginated<ConcertRow>> {
    return this.get('/core/v1/concerts/overview', { ...scopeToQuery(context.scope), ...params }, context)
  }

  /** Los recuentos del listado, con los MISMOS filtros que él. */
  findConcertsSummary(
    params: SearchConcertsOverviewParams,
    context: CallerContext & { scope: Scope }
  ): Promise<ConcertsSummary> {
    return this.get('/core/v1/concerts/summary', { ...scopeToQuery(context.scope), ...params }, context)
  }

  /**
   * Cuántos conciertos hay cada día entre dos fechas.
   *
   * ⚠ El rango es SUYO y no el del listado: se mira un año entero aunque la tabla esté acotada
   * a una semana. El core lo topa en 550 días.
   */
  findConcertsCalendar(
    range: { from: string; to: string },
    params: SearchConcertsOverviewParams,
    context: CallerContext & { scope: Scope }
  ): Promise<ConcertCalendarDay[]> {
    return this.get(
      '/core/v1/concerts/calendar',
      { ...scopeToQuery(context.scope), ...params, ...range },
      context
    )
  }

  /** Conciertos por año, de toda la historia. Son quince filas: no lleva rango. */
  findConcertsYearly(
    params: SearchConcertsOverviewParams,
    context: CallerContext & { scope: Scope }
  ): Promise<ConcertYear[]> {
    return this.get('/core/v1/concerts/yearly', { ...scopeToQuery(context.scope), ...params }, context)
  }

  // ---------------------------------------------------------------------- genérico

  async get<T>(
    path: string,
    query: Record<string, unknown>,
    context: CallerContext = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const queryString = encodeQuery(query)

    return this.request<T>('GET', queryString ? `${path}?${queryString}` : path, '', context, options)
  }

  /**
   * Cualquier método con cuerpo. Para GET está `get()`, que además arma la query.
   *
   * ⚠ **Un GET o un HEAD van SIN cuerpo, aunque se pase uno.** `fetch` no lo permite y revienta
   * con «Request with GET/HEAD method cannot have body»: le tumbó el `home-context` entero al BFF
   * móvil y, como la llamada estaba dentro de un `catch` de fallo suave, el calendario se quedó
   * sin colores en silencio. Un fallo que depende de acordarse de qué método se está usando se
   * repite con cada BFF nuevo, así que se corta aquí.
   *
   * Se descarta y no se avisa porque no había nada que perder: ese cuerpo nunca llegó a salir
   * —la petición no se hacía— y el core lee sus parámetros de la query. Y la firma cuadra igual:
   * un GET siempre se ha firmado con el cuerpo vacío, que es lo que hace `get()`.
   */
  async send<T>(
    method: string,
    path: string,
    body: unknown,
    context: CallerContext = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const withoutBody = ['GET', 'HEAD'].includes(method.toUpperCase())

    return this.request<T>(method, path, withoutBody ? '' : JSON.stringify(body ?? {}), context, options)
  }

  private async request<T>(
    method: string,
    requestUri: string,
    body: string,
    context: CallerContext,
    options: RequestOptions = {}
  ): Promise<T> {
    const retries = options.retries ?? this.options.retries ?? DEFAULT_RETRIES

    let lastError: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.attempt<T>(method, requestUri, body, context, options.timeoutMs)
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
    context: CallerContext,
    timeoutMs?: number
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
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

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

  /**
   * Como `request`, pero devuelve los bytes sin tocar. Firma igual: el perímetro del core no
   * distingue si lo que vuelve es JSON o un fichero.
   *
   * Sin reintentos a propósito: un PDF pesa, y repetir una descarga a medias no la arregla.
   */
  async requestBinary(method: string, requestUri: string, context: CallerContext = {}): Promise<BinaryResponse> {
    const headers: Record<string, string> = {
      ...signRequest({
        method,
        requestUri,
        body: '',
        clientId: this.options.clientId,
        signingSecret: this.options.signingSecret
      })
    }

    if (context.userId) {
      headers[SIGNATURE_HEADERS.actingUser] = context.userId
    }

    const response = await fetch(`${this.baseUrl}${requestUri}`, { method, headers })

    if (!response.ok) {
      throw new CoreRequestError(`Core responded ${response.status}`, response.status, null, requestUri)
    }

    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentDisposition: response.headers.get('content-disposition')
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

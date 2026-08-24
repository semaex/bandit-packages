# @bandit/core-client

Cliente del **contrato nuevo** de `bandit/api` (`/core/v1`), compartido por todos los BFFs.

Nació con `bandit/backoffice` y lo adoptarán `mobile-app-bff`, `public-api` y el servidor MCP.
Plan y decisiones: `bandit/API_PUBLICA_MCP_PLAN.md` (§6 y §9.1).

## Qué hace

- **Firma HMAC** de cada petición al core. Es el motivo de peso para que esto sea una
  librería y no cuatro copias: tres implementaciones propias de código criptográfico
  son tres oportunidades de dejar un agujero.
- Desempaqueta el `{ data: … }` con el que el core envuelve todas las respuestas.
- Propaga `X-Acting-User-Id` (informativo, nunca autoritativo), timeouts y reintentos.
- Aporta los **tipos TypeScript del contrato**.

## Qué NO hace

⚠ **No sabe de autenticación.** Recibe un `{ userId?, scope }` ya resuelto. Quién es el
usuario y qué alcance tiene lo decide cada BFF: contraseña única en el backoffice, JWT en
la app móvil, clave `sk_` en `public-api`. Si se le metiera verificación de JWT dentro
dejaría de servir para `public-api` y acabaríamos con dos librerías.

## Uso

```ts
import { CoreClient, UNRESTRICTED } from '@bandit/core-client'

const core = new CoreClient({
  baseUrl: process.env.BANDIT_CORE_URL!,
  clientId: 'backoffice',
  signingSecret: process.env.CORE_SIGNING_SECRET!
})

const page = await core.searchAgencySubscriptions(
  { terms: 'houston', limit: 25 },
  { scope: UNRESTRICTED, userId: 'admin' }
)
```

## Hablar con un core de certificado autofirmado

El core de desarrollo se sirve por HTTPS con un certificado autofirmado y nginx redirige el
HTTP, así que no hay forma de hablarle en claro. La manera de aceptarlo **sin apagar la
verificación TLS** es arrancar el proceso con el certificado como CA extra:

```yaml
environment:
  - NODE_EXTRA_CA_CERTS=/certs/api_devel_bandit_show.crt
```

⚠ Este paquete **no** ofrece una opción para saltarse la verificación. La tuvo y se quitó:
apagaba `NODE_TLS_REJECT_UNAUTHORIZED` para todo el proceso, y en cuanto un mismo proceso
habla con un core local y con uno de producción —el caso del selector del backoffice— eso
significa llamar a producción sin verificar el certificado.

El `scope` es **obligatorio** en toda llamada de listado, igual que en el core. Quien vea
todo pasa `UNRESTRICTED` de forma explícita.

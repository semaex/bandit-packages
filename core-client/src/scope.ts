/**
 * Alcance ya resuelto que el BFF pasa al core. Espejo de
 * `bandit/api/src/Core/Shared/Domain/Scope/ScopeConstraint.php`.
 *
 * El core NO resuelve identidad: quién es el usuario y sobre qué puede actuar lo decide
 * el BFF y viaja como parámetro de la petición. Por eso el alcance es obligatorio en
 * toda llamada de listado — incluso cuando no hay nada que restringir.
 */
export type Scope =
  | { unrestricted: true }
  | {
      unrestricted?: false
      agencyIds?: string[]
      artistIds?: string[]
      /**
       * Alcance por CAMPOS: qué columnas se rellenan en las filas que sí se devuelven.
       * Mapa política → ids permitidos, p.ej. `{'concerts.balances': ['artist-1']}`.
       *
       * ⚠ Deniega por defecto: una política que no venga aquí se trata como no permitida.
       * Si un BFF se olvida de un eje, el campo llega vacío en vez de llegar entero.
       */
      fieldPolicies?: Record<string, string[]>
    }

/**
 * Sin restricción. Hoy solo lo usa `bandit/backoffice`, cuya autenticación es una
 * contraseña única de admin de plataforma.
 *
 * ⚠ Es explícito a propósito. Que un admin lo vea todo no lo convierte en el valor por
 * defecto: el día que llame un cliente con alcance real, lo que falla debe ser un error
 * de tipos, no una consulta que devuelve de más.
 */
export const UNRESTRICTED: Scope = { unrestricted: true }

/** Traduce el alcance a los parámetros de query que leen los controllers de `/core/v1`. */
export function scopeToQuery(scope: Scope): Record<string, unknown> {
  if (scope.unrestricted === true) {
    return { unrestricted: true }
  }

  return {
    allowedAgencyIds: scope.agencyIds ?? [],
    allowedArtistIds: scope.artistIds ?? [],
    fieldPolicies: scope.fieldPolicies ?? {}
  }
}

/**
 * Forma en la que `/core/v1/authorization/resolve-scope` devuelve el alcance: los mismos
 * nombres que usa `ScopeConstraint::toPrimitives()` en PHP, más `appliedPolicies`.
 */
export interface ResolvedScope {
  unrestricted: boolean
  agencyIds: string[] | null
  artistIds: string[] | null
  fieldPolicies: Record<string, string[]>
  /** Qué ejes de campo se resolvieron; permite distinguir "no hay dato" de "no tienes permiso". */
  appliedPolicies?: string[]
}

/** Traduce lo que devuelve el core al `Scope` que se manda de vuelta en cada consulta. */
export function scopeFromResolved(resolved: ResolvedScope): Scope {
  if (resolved.unrestricted) {
    return UNRESTRICTED
  }

  return {
    agencyIds: resolved.agencyIds ?? [],
    artistIds: resolved.artistIds ?? [],
    fieldPolicies: resolved.fieldPolicies ?? {}
  }
}

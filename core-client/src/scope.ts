/**
 * Alcance ya resuelto que el BFF pasa al core. Espejo de
 * `bandit/api/src/App/Shared/Domain/Scope/ScopeConstraint.php`.
 *
 * El core NO resuelve identidad: quién es el usuario y sobre qué puede actuar lo decide
 * el BFF y viaja como parámetro de la petición. Por eso el alcance es obligatorio en
 * toda llamada de listado — incluso cuando no hay nada que restringir.
 */
export type Scope =
  | { unrestricted: true }
  | { unrestricted?: false; agencyIds?: string[]; artistIds?: string[] }

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
    allowedArtistIds: scope.artistIds ?? []
  }
}

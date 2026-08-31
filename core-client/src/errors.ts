import { CoreRequestError } from './client'

/**
 * Un fallo del core traducido a lo que se le puede contar a quien llamó al BFF.
 *
 * ⚠ **Aquí vive la POLÍTICA, no el framework.** Cada BFF la aplica con lo suyo —un
 * `ExceptionFilter` en Nest, un `createError` en Nuxt— pero qué status sale y qué texto se
 * reenvía tiene que decidirse en un solo sitio: son tres consumidores y subiendo, y el que se
 * olvide de copiarlo convierte todos los errores del core en 500 sin enterarse.
 */
export interface PublicCoreError {
  status: number
  /** El `code` del core, que es lo que la UI usa para elegir su mensaje. */
  code: string | null
  /** El texto del core, o `null` cuando NO debe reenviarse. */
  message: string | null
}

export function publicCoreError(error: unknown): PublicCoreError {
  /*
   * Lo que no viene del core no se sabe qué es —un fallo del propio BFF, un timeout, un DNS
   * caído— y no se cuenta: 500 pelado.
   */
  if (!(error instanceof CoreRequestError)) {
    return { status: 500, code: null, message: null }
  }

  /*
   * ⚠ **Un 4xx del core es una RESPUESTA, y se reenvía entera.** Es lo que distingue «no puede
   * quedar por debajo del plan» de un error genérico: sin el `code`, la UI no puede elegir su
   * mensaje y todo se lee igual de roto.
   */
  if (error.status >= 400 && error.status < 500) {
    return { status: error.status, code: error.code, message: error.message }
  }

  /*
   * ⚠ **Y un 5xx del core NO es un 500 del BFF: es un 502.** El BFF funciona; quien ha fallado
   * es el servicio de detrás, y mezclarlos hace imposible distinguir en los logs un fallo
   * nuestro de uno del core. El mensaje no se reenvía: es de dentro, puede llevar rutas, SQL o
   * nombres de clase, y quien llama no puede hacer nada con él.
   */
  return { status: 502, code: null, message: null }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

/** An Error carrying an HTTP status; `middleware/error-handler.ts` turns it into `{ error }`. */
export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

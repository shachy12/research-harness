import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Thrown by routes; turned into a JSON `{ error }` response by the app's error handler. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);

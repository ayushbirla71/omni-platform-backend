import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Express 4 does not forward a rejected promise from an async route handler
 * to error-handling middleware automatically — an unhandled async throw
 * just hangs the request with no response ever sent. That exact gap caused
 * two real bugs (a bad contactId on POST /api/deals, a bad channelId on
 * POST /api/campaigns — see IMPLEMENTATION_TRACKER.md) before this wrapper
 * existed. Every route in this app should be wrapped in this.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}

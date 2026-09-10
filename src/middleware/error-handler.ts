import { Request, Response, NextFunction } from "express";
import { logger, sanitizeMeta } from "../utils/logger";
import { AuthedRequest } from "./auth";

/**
 * Global Express Error Handling Middleware.
 * Captures, logs with full contextual metadata, and returns clean structured error responses.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const reqId = req.id || (req.headers["x-request-id"] as string);
  const authed = req as AuthedRequest;
  const tenantId = authed.auth?.tenantId;
  const userId = authed.auth?.userId;

  const scopedLogger = req.logger || logger.child({
    module: "error-handler",
    reqId,
    tenantId,
    userId,
  });

  const method = req.method;
  const url = req.originalUrl || req.url;

  const errorContext = {
    method,
    url,
    reqId,
    tenantId,
    userId,
    query: sanitizeMeta(req.query),
    body: sanitizeMeta(req.body),
    ip: req.ip || req.socket.remoteAddress,
  };

  // Log full stack and contextual details
  scopedLogger.error(
    `Unhandled Error processing ${method} ${url}: ${err?.message || err}`,
    err,
    errorContext
  );

  if (res.headersSent) {
    return;
  }

  // Handle known Postgres constraint errors
  if (err?.code === "23503") {
    res.status(400).json({
      error: "Request refers to a record that does not exist",
      code: "FOREIGN_KEY_VIOLATION",
      requestId: reqId,
    });
    return;
  }

  if (err?.code === "23505") {
    res.status(409).json({
      error: "A record with these values already exists",
      code: "DUPLICATE_RECORD",
      requestId: reqId,
    });
    return;
  }

  if (err?.code === "23514" || err?.code === "22P02") {
    res.status(400).json({
      error: "Request contains an invalid or malformed value",
      code: "INVALID_INPUT_SYNTAX",
      requestId: reqId,
    });
    return;
  }

  // Client-specified status code
  const statusCode = typeof err?.statusCode === "number" ? err.statusCode : typeof err?.status === "number" ? err.status : 500;
  const errorMessage = statusCode < 500
    ? err?.message || "Client request error"
    : (process.env.NODE_ENV === "development" ? (err?.message || "Internal server error") : "Internal server error");

  res.status(statusCode).json({
    error: errorMessage,
    code: err?.code || "INTERNAL_SERVER_ERROR",
    requestId: reqId,
    ...(process.env.NODE_ENV === "development" && err?.stack ? { stack: err.stack } : {}),
  });
}

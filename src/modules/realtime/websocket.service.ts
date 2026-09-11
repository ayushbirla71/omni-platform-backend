import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { logger } from "../../utils/logger";
import { AuthTokenPayload } from "../auth/auth.service";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export interface RealtimeSocket extends WebSocket {
  isAlive: boolean;
  user?: AuthTokenPayload;
  tenantId?: string;
  userId?: string;
  subscriptions: Set<string>;
}

export interface RealtimeMessageEvent {
  event: string;
  data: any;
  tenantId: string;
  targetUserId?: string;
  conversationId?: string;
  timestamp: string;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<RealtimeSocket> = new Set();
  private redisPub: ReturnType<typeof createClient> | null = null;
  private redisSub: ReturnType<typeof createClient> | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isRedisReady: boolean = false;

  public async init(server: HttpServer): Promise<void> {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    // Initialize Redis Pub/Sub for horizontal scaling across distributed nodes
    await this.initRedisPubSub();

    this.wss.on("connection", (ws: WebSocket, req) => {
      const socket = ws as RealtimeSocket;
      socket.isAlive = true;
      socket.subscriptions = new Set(["*"]); // default subscribe to all tenant events

      // Parse token from query parameter or Authorization header
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      const token =
        url.searchParams.get("token") ||
        (req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : null);

      if (!token) {
        logger.warn("WebSocket connection rejected: No authentication token provided");
        socket.send(JSON.stringify({ type: "error", message: "Authentication required" }));
        socket.close(1008, "Token required");
        return;
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        const uid = decoded.userId || decoded.id;
        if (!decoded.tenantId || !uid) {
          throw new Error("Invalid token claims");
        }

        socket.user = {
          userId: uid,
          tenantId: decoded.tenantId,
          role: decoded.role || "agent",
          email: decoded.email || "",
        };
        socket.tenantId = decoded.tenantId;
        socket.userId = uid;

        this.clients.add(socket);
        logger.info("WebSocket client connected", {
          tenantId: socket.tenantId,
          userId: socket.userId,
          role: socket.user?.role,
        });

        // Send connection confirmation
        socket.send(
          JSON.stringify({
            type: "connection_established",
            tenantId: socket.tenantId,
            userId: socket.userId,
            timestamp: new Date().toISOString(),
          })
        );
      } catch (err: any) {
        logger.warn("WebSocket authentication failed", { error: err.message });
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(1008, "Authentication failed");
        return;
      }

      // Heartbeat ping-pong
      socket.on("pong", () => {
        socket.isAlive = true;
      });

      // Handle client incoming messages (subscriptions / pings)
      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          } else if (msg.type === "subscribe" && msg.channel) {
            socket.subscriptions.add(msg.channel);
            socket.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
          } else if (msg.type === "unsubscribe" && msg.channel) {
            socket.subscriptions.delete(msg.channel);
            socket.send(JSON.stringify({ type: "unsubscribed", channel: msg.channel }));
          }
        } catch {
          // ignore malformed client frames
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        logger.debug("WebSocket client disconnected", {
          tenantId: socket.tenantId,
          userId: socket.userId,
        });
      });

      socket.on("error", (err) => {
        logger.error("WebSocket socket error", { error: err.message });
        this.clients.delete(socket);
      });
    });

    // Start periodic ping/pong connection sweeper (30s)
    this.pingInterval = setInterval(() => {
      this.clients.forEach((socket) => {
        if (!socket.isAlive) {
          logger.debug("Terminating inactive WebSocket client", {
            tenantId: socket.tenantId,
            userId: socket.userId,
          });
          socket.terminate();
          this.clients.delete(socket);
          return;
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);
  }

  private async initRedisPubSub(): Promise<void> {
    try {
      this.redisPub = createClient({ url: REDIS_URL });
      this.redisSub = createClient({ url: REDIS_URL });

      this.redisPub.on("error", (err) =>
        logger.warn("Redis Publisher error (non-fatal, falling back to local)", { error: err.message })
      );
      this.redisSub.on("error", (err) =>
        logger.warn("Redis Subscriber error (non-fatal, falling back to local)", { error: err.message })
      );

      await Promise.all([this.redisPub.connect(), this.redisSub.connect()]);
      this.isRedisReady = true;

      // Subscribe to all tenant pub/sub channels
      await this.redisSub.pSubscribe("omni:tenant:*", (message, channel) => {
        try {
          const tenantId = channel.replace("omni:tenant:", "");
          const eventPayload: RealtimeMessageEvent = JSON.parse(message);
          this.broadcastLocally(tenantId, eventPayload);
        } catch (err: any) {
          logger.error("Error processing Redis pub/sub event", { error: err.message });
        }
      });

      logger.info("Redis Pub/Sub Real-Time WebSocket cluster connected successfully");
    } catch (err: any) {
      this.isRedisReady = false;
      logger.warn("Redis Pub/Sub unavailable, falling back to in-memory WebSocket broadcast", {
        error: err.message,
      });
    }
  }

  /**
   * Broadcast an event to local connected WebSockets matching tenant and target filters
   */
  private broadcastLocally(tenantId: string, payload: RealtimeMessageEvent): void {
    const rawMessage = JSON.stringify({
      type: "event",
      event: payload.event,
      data: payload.data,
      timestamp: payload.timestamp,
    });

    this.clients.forEach((socket) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.tenantId !== tenantId) return;

      // Check user target filter if specified
      if (payload.targetUserId && socket.userId !== payload.targetUserId) {
        return;
      }

      // Check conversation subscription filter if specified
      if (
        payload.conversationId &&
        !socket.subscriptions.has("*") &&
        !socket.subscriptions.has(`conversation:${payload.conversationId}`)
      ) {
        return;
      }

      socket.send(rawMessage);
    });
  }

  /**
   * Publish a real-time event across the distributed cluster.
   */
  public async publish(
    tenantId: string,
    event: string,
    data: any,
    options?: { targetUserId?: string; conversationId?: string }
  ): Promise<void> {
    const payload: RealtimeMessageEvent = {
      event,
      data,
      tenantId,
      targetUserId: options?.targetUserId,
      conversationId: options?.conversationId,
      timestamp: new Date().toISOString(),
    };

    if (this.isRedisReady && this.redisPub) {
      try {
        await this.redisPub.publish(`omni:tenant:${tenantId}`, JSON.stringify(payload));
        return;
      } catch (err: any) {
        logger.warn("Redis publish failed, falling back to local broadcast", { error: err.message });
      }
    }

    // Direct local fallback
    this.broadcastLocally(tenantId, payload);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }
}

export const realtimeGateway = new WebSocketManager();

/**
 * Convenient global helper to emit real-time events to all agents in a tenant
 */
export async function emitRealtimeEvent(
  tenantId: string,
  event: string,
  data: any,
  options?: { targetUserId?: string; conversationId?: string }
): Promise<void> {
  return realtimeGateway.publish(tenantId, event, data, options);
}

import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { uploadMedia } from "../../db/object-storage";
import { listMessages } from "../messages/messages.service";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import {
  listWebchatWidgets,
  getWebchatWidgetById,
  createWebchatWidget,
  updateWebchatWidget,
  deleteWebchatWidget,
  getPublicWidgetConfig,
  initVisitorSession,
  sendVisitorMessage,
  VisitorAuthPayload,
} from "./webchat.service";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max per media upload
});

export interface VisitorRequest extends Request {
  visitor?: VisitorAuthPayload;
}

/**
 * Middleware: Verify stateless visitor JWT token
 */
export function requireVisitorAuth(req: VisitorRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token =
    (authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null) ||
    (typeof req.query.token === "string" ? req.query.token : null);

  if (!token) {
    return res.status(401).json({ error: "Visitor authentication token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded.isVisitor && decoded.role !== "visitor") {
      return res.status(403).json({ error: "Invalid visitor token" });
    }
    if (!decoded.tenantId || !decoded.conversationId) {
      return res.status(403).json({ error: "Incomplete visitor token claims" });
    }

    req.visitor = {
      role: "visitor",
      isVisitor: true,
      tenantId: decoded.tenantId,
      channelId: decoded.channelId,
      contactId: decoded.contactId,
      conversationId: decoded.conversationId,
      visitorSessionId: decoded.visitorSessionId,
    };
    next();
  } catch (err: any) {
    return res.status(401).json({ error: "Visitor session expired or invalid", details: err.message });
  }
}

export const webchatRouter = Router();

// Enable Cross-Origin Script Execution & Embedding for Public Webchat Routes
webchatRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Frame-Options");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ============================================================================
// 1. PUBLIC VISITOR API ENDPOINTS
// ============================================================================

/**
 * GET /api/webchat/config/:widgetKey
 * Public endpoint to load widget appearance, branding, and online status.
 */
webchatRouter.get(
  "/config/:widgetKey",
  asyncHandler(async (req: Request, res: Response) => {
    const { widgetKey } = req.params;
    const origin = req.headers.origin || req.headers.referer;
    const config = await getPublicWidgetConfig(widgetKey, typeof origin === "string" ? origin : undefined);
    res.json(config);
  })
);

/**
 * POST /api/webchat/init
 * Initialize or resume a stateless visitor session and load conversation history.
 */
webchatRouter.post(
  "/init",
  asyncHandler(async (req: Request, res: Response) => {
    const { widgetKey, visitorSessionId, contactName, contactEmail, metadata } = req.body;
    if (!widgetKey) {
      return res.status(400).json({ error: "widgetKey is required" });
    }

    const session = await initVisitorSession({
      widgetKey,
      visitorSessionId,
      contactName,
      contactEmail,
      metadata,
    });

    res.json(session);
  })
);

/**
 * GET /api/webchat/messages
 * Fetch conversation message history for an authenticated visitor.
 */
webchatRouter.get(
  "/messages",
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const messages = await listMessages(visitor.tenantId, visitor.conversationId);
    res.json({ messages });
  })
);

/**
 * POST /api/webchat/messages
 * Send a message from the visitor into the live chat conversation.
 */
webchatRouter.post(
  "/messages",
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const { text, mediaUrl, mediaStorageKey, type } = req.body;

    const message = await sendVisitorMessage({
      tenantId: visitor.tenantId,
      channelId: visitor.channelId,
      conversationId: visitor.conversationId,
      contactId: visitor.contactId,
      visitorSessionId: visitor.visitorSessionId,
      text,
      mediaUrl,
      mediaStorageKey,
      type,
    });

    res.status(201).json({ message });
  })
);

/**
 * POST /api/webchat/typing
 * Broadcast visitor typing indicator to tenant agents in real time.
 */
webchatRouter.post(
  "/typing",
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const { isTyping } = req.body;

    await emitRealtimeEvent(
      visitor.tenantId,
      "conversation:typing",
      {
        conversationId: visitor.conversationId,
        isTyping: Boolean(isTyping),
        sender: "visitor",
        userId: visitor.contactId,
      },
      { conversationId: visitor.conversationId }
    );

    res.json({ success: true });
  })
);

/**
 * POST /api/webchat/upload
 * Securely upload image, document, or audio attachment for visitor chat.
 */
webchatRouter.post(
  "/upload",
  requireVisitorAuth,
  upload.single("file"),
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `webchat/${visitor.tenantId}/${visitor.conversationId}/${uuidv4()}_${safeFilename}`;

    await uploadMedia({
      key,
      body: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    const fileUrl = `/api/media/file?key=${encodeURIComponent(key)}`;

    res.json({
      key,
      url: fileUrl,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
    });
  })
);

/**
 * GET /api/webchat/embed.js
 * Standalone embed script loader that customers can include in their website HTML.
 */
webchatRouter.get("/embed.js", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Frame-Options");

  const host =
    req.get("x-forwarded-host") ||
    req.get("host") ||
    "localhost:4000";
  const protocol =
    req.get("x-forwarded-proto") ||
    (req.protocol === "https" ? "https" : "http");
  const baseUrl = `${protocol}://${host}`;

  const js = `
(function() {
  if (document.getElementById('omni-webchat-iframe')) return;

  var currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i].src || '';
      if (s.indexOf('embed.js') !== -1 || s.indexOf('webchat') !== -1) return scripts[i];
    }
    return scripts[scripts.length - 1];
  })();

  var widgetKey = null;
  var scriptSrc = (currentScript && currentScript.src) ? currentScript.src : '';
  if (scriptSrc) {
    var match = scriptSrc.match(/[?&]key=([^&#]*)/);
    if (match) widgetKey = decodeURIComponent(match[1]);
  }
  if (!widgetKey && window.OmniChatConfig && window.OmniChatConfig.widgetKey) {
    widgetKey = window.OmniChatConfig.widgetKey;
  }
  if (!widgetKey) {
    console.warn('[OmniChat] Missing widget key in embed script tag.');
    return;
  }

  // Derive origin dynamically in browser from the loaded script's URL
  var scriptOrigin = '';
  if (scriptSrc) {
    try {
      var parsedUrl = new URL(scriptSrc, window.location.href);
      scriptOrigin = parsedUrl.origin;
    } catch(e) {}
  }
  var baseHost = (window.OmniChatConfig && window.OmniChatConfig.appUrl) || scriptOrigin || '${baseUrl}';
  baseHost = baseHost.replace(/\\/+$/, '');

  var iframe = document.createElement('iframe');
  iframe.id = 'omni-webchat-iframe';
  iframe.src = baseHost + '/chat/' + encodeURIComponent(widgetKey) + '?embedded=true';
  iframe.style.position = 'fixed';
  iframe.style.bottom = '20px';
  iframe.style.right = '20px';
  iframe.style.width = '70px';
  iframe.style.height = '70px';
  iframe.style.maxHeight = 'calc(100vh - 30px)';
  iframe.style.maxWidth = 'calc(100vw - 30px)';
  iframe.style.border = 'none';
  iframe.style.background = 'transparent';
  iframe.style.zIndex = '999999';
  iframe.style.overflow = 'hidden';
  iframe.style.transition = 'width 0.28s cubic-bezier(0.16, 1, 0.3, 1), height 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease';
  iframe.allow = 'camera; microphone; autoplay';

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'omni-webchat-resize') {
      if (e.data.position === 'bottom-left') {
        iframe.style.left = '20px';
        iframe.style.right = 'auto';
      } else {
        iframe.style.right = '20px';
        iframe.style.left = 'auto';
      }
      if (e.data.isExpanded) {
        iframe.style.width = e.data.width || '420px';
        iframe.style.height = e.data.height || '680px';
        iframe.style.borderRadius = '16px';
        iframe.style.boxShadow = '0 20px 30px -10px rgba(0, 0, 0, 0.2), 0 10px 15px -5px rgba(0, 0, 0, 0.08)';
      } else {
        iframe.style.width = '70px';
        iframe.style.height = '70px';
        iframe.style.borderRadius = '50%';
        iframe.style.boxShadow = 'none';
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.appendChild(iframe);
    });
  } else {
    document.body.appendChild(iframe);
  }
})();
`;
  res.send(js);
});

// ============================================================================
// 2. TENANT AUTHENTICATED WIDGET MANAGEMENT CRUD
// ============================================================================

export const webchatTenantRouter = Router();
webchatTenantRouter.use(requireAuth);

/**
 * GET /api/channels/webchat/widgets
 * List all live chat widgets for the tenant
 */
webchatTenantRouter.get(
  "/widgets",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const widgets = await listWebchatWidgets(req.auth!.tenantId);
    res.json({ widgets });
  })
);

/**
 * GET /api/channels/webchat/widgets/:id
 * Get single widget details by ID
 */
webchatTenantRouter.get(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const widget = await getWebchatWidgetById(req.auth!.tenantId, req.params.id);
    if (!widget) {
      return res.status(404).json({ error: "Webchat widget not found" });
    }
    res.json({ widget });
  })
);

/**
 * POST /api/channels/webchat/widgets
 * Create a new live chat widget and webchat channel
 */
webchatTenantRouter.post(
  "/widgets",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    } = req.body;

    const widget = await createWebchatWidget(req.auth!.tenantId, {
      displayName: displayName || title || "Website Live Chat",
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    });

    res.status(201).json({ widget });
  })
);

/**
 * PUT /api/channels/webchat/widgets/:id
 * Update an existing live chat widget and its settings
 */
webchatTenantRouter.put(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    } = req.body;

    const widget = await updateWebchatWidget(req.auth!.tenantId, req.params.id, {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    });

    res.json({ widget });
  })
);

/**
 * DELETE /api/channels/webchat/widgets/:id
 * Delete a live chat widget and its associated channel
 */
webchatTenantRouter.delete(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await deleteWebchatWidget(req.auth!.tenantId, req.params.id);
    res.json({ success: true, message: "Webchat widget deleted successfully" });
  })
);

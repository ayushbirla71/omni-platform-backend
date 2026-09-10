import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  getAnalyticsOverview,
  getSlaPerformanceMetrics,
  getTrafficHeatmap,
  getConversionFunnel,
} from "./analytics.service";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get(
  "/overview",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = await getAnalyticsOverview(req.auth!.tenantId);
    res.json(data);
  })
);

analyticsRouter.get(
  "/sla-performance",
  asyncHandler(async (req: AuthedRequest, res) => {
    const threshold = Number(req.query.threshold) || 300;
    const data = await getSlaPerformanceMetrics(req.auth!.tenantId, threshold);
    res.json(data);
  })
);

analyticsRouter.get(
  "/traffic-heatmap",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = await getTrafficHeatmap(req.auth!.tenantId);
    res.json(data);
  })
);

analyticsRouter.get(
  "/conversion-funnel",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = await getConversionFunnel(req.auth!.tenantId);
    res.json(data);
  })
);

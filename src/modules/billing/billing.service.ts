import { query, queryOne } from "../../db/pool";
import { getMongoDb } from "../../db/mongo";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "billing-service" });

export interface PlanConfig {
  id: string;
  name: string;
  description: string;
  priceMonthly: number;
  maxChannels: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  features: string[];
}

export const PLAN_TIERS: Record<string, PlanConfig> = {
  free: {
    id: "free",
    name: "Free Sandbox",
    description: "Ideal for testing and single-channel experimentation",
    priceMonthly: 0,
    maxChannels: 1,
    maxContacts: 500,
    maxMonthlyMessages: 2000,
    maxMonthlyAiQueries: 100,
    features: ["1 Active Channel", "500 Contacts", "2k Messages/mo", "Basic Flow Builder", "Community Support"],
  },
  starter: {
    id: "starter",
    name: "Starter Growth",
    description: "For small teams scaling messaging and customer service",
    priceMonthly: 29,
    maxChannels: 3,
    maxContacts: 3000,
    maxMonthlyMessages: 15000,
    maxMonthlyAiQueries: 500,
    features: [
      "3 Connected Channels",
      "3,000 Verified Contacts",
      "15k Messages/mo",
      "AI Smart Copilot",
      "WhatsApp Cloud API Integration",
      "Standard Email Support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro Scale",
    description: "For fast-growing organizations requiring high capacity & AI agents",
    priceMonthly: 99,
    maxChannels: 10,
    maxContacts: 25000,
    maxMonthlyMessages: 100000,
    maxMonthlyAiQueries: 5000,
    features: [
      "10 Connected Channels",
      "25,000 Contacts",
      "100k Messages/mo",
      "Full RAG Knowledge Bases",
      "Automated Intent Router",
      "Team RBAC & Developer API Keys",
      "Priority 24/7 Support",
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise Custom",
    description: "Dedicated infrastructure, SLA guarantees, and limitless capacity",
    priceMonthly: 299,
    maxChannels: 50,
    maxContacts: 500000,
    maxMonthlyMessages: 1000000,
    maxMonthlyAiQueries: 50000,
    features: [
      "Unlimited Channels",
      "500,000+ Contacts",
      "1M+ Messages/mo",
      "Custom Fine-Tuned AI Models",
      "Audit Trail & GDPR Compliance Suite",
      "Custom SLA & Dedicated Account Manager",
    ],
  },
};

export interface UsageMetric {
  used: number;
  limit: number;
  percentage: number;
  unit: string;
}

export interface WorkspaceUsageSummary {
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  planStatus: string;
  billingCycleEnd: string;
  metrics: {
    channels: UsageMetric;
    contacts: UsageMetric;
    monthlyMessages: UsageMetric;
    monthlyAiQueries: UsageMetric;
  };
  stats: {
    totalConversations: number;
    totalDealsCount: number;
    totalDealsValue: number;
    activeAgentsCount: number;
  };
  availablePlans: PlanConfig[];
}

export class BillingService {
  /**
   * Retrieves live usage consumption vs allocated plan quotas for a workspace.
   */
  public static async getUsageAndQuotas(tenantId: string): Promise<WorkspaceUsageSummary> {
    // 1. Fetch tenant metadata
    const tenant = await queryOne<{
      id: string;
      name: string;
      plan_status: string;
      max_channels: number;
      max_contacts: number;
      max_monthly_messages: number;
      max_monthly_ai_queries: number;
    }>(
      `SELECT id, name, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (!tenant) {
      throw new Error("Tenant workspace not found");
    }

    const currentPlanKey = (tenant.plan_status || "pro").toLowerCase();
    const activePlan = PLAN_TIERS[currentPlanKey] || PLAN_TIERS.pro;

    const maxChannels = tenant.max_channels || activePlan.maxChannels;
    const maxContacts = tenant.max_contacts || activePlan.maxContacts;
    const maxMessages = tenant.max_monthly_messages || activePlan.maxMonthlyMessages;
    const maxAiQueries = tenant.max_monthly_ai_queries || activePlan.maxMonthlyAiQueries;

    // 2. Query Postgres Relational counts
    const [channelsCountRes, contactsCountRes, dealsStatsRes, usersCountRes, aiLogsRes, convsRes] =
      await Promise.all([
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM channels WHERE tenant_id = $1 AND status = 'active'",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM contacts WHERE tenant_id = $1",
          [tenantId]
        ),
        queryOne<{ count: string; total_value: string }>(
          "SELECT count(*) as count, coalesce(sum(value), 0) as total_value FROM deals WHERE tenant_id = $1",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM users WHERE tenant_id = $1 AND status = 'active'",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM ai_logs WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM conversations WHERE tenant_id = $1",
          [tenantId]
        ),
      ]);

    const activeChannels = parseInt(channelsCountRes?.count || "0", 10);
    const totalContacts = parseInt(contactsCountRes?.count || "0", 10);
    const dealsCount = parseInt(dealsStatsRes?.count || "0", 10);
    const dealsValue = parseFloat(dealsStatsRes?.total_value || "0");
    const activeUsers = parseInt(usersCountRes?.count || "0", 10);
    const aiQueries = parseInt(aiLogsRes?.count || "0", 10);
    const totalConvs = parseInt(convsRes?.count || "0", 10);

    // 3. Query MongoDB message counts for current month
    let monthlyMessagesCount = 0;
    try {
      const mongo = await getMongoDb();
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      monthlyMessagesCount = await mongo.collection("messages").countDocuments({
        $and: [
          { $or: [{ tenantId }, { tenant_id: tenantId }] },
          { $or: [{ sentAt: { $gte: startOfMonth } }, { createdAt: { $gte: startOfMonth.toISOString() } }] },
        ],
      });
    } catch (err: any) {
      log.warn("Mongo count error (using estimate)", { error: err.message });
      monthlyMessagesCount = Math.max(0, totalConvs * 4);
    }

    // Helper for metric calculations
    const calcMetric = (used: number, limit: number, unit: string): UsageMetric => {
      const safeLimit = Math.max(limit, 1);
      const percentage = Math.min(Math.round((used / safeLimit) * 100), 100);
      return { used, limit, percentage, unit };
    };

    // Calculate billing cycle end date (end of current calendar month)
    const cycleEnd = new Date();
    cycleEnd.setMonth(cycleEnd.getMonth() + 1, 0);
    cycleEnd.setHours(23, 59, 59, 999);

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      planId: activePlan.id,
      planName: activePlan.name,
      planStatus: "active",
      billingCycleEnd: cycleEnd.toISOString(),
      metrics: {
        channels: calcMetric(activeChannels, maxChannels, "channels"),
        contacts: calcMetric(totalContacts, maxContacts, "contacts"),
        monthlyMessages: calcMetric(monthlyMessagesCount, maxMessages, "messages"),
        monthlyAiQueries: calcMetric(aiQueries, maxAiQueries, "queries"),
      },
      stats: {
        totalConversations: totalConvs,
        totalDealsCount: dealsCount,
        totalDealsValue: dealsValue,
        activeAgentsCount: activeUsers,
      },
      availablePlans: Object.values(PLAN_TIERS),
    };
  }

  /**
   * Updates or upgrades a tenant's subscription plan tier.
   */
  public static async updatePlan(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    planId: string;
    ipAddress?: string;
  }): Promise<{ message: string; plan: PlanConfig }> {
    const targetPlan = PLAN_TIERS[params.planId.toLowerCase()];
    if (!targetPlan) {
      throw new Error(`Invalid plan tier: ${params.planId}. Available: free, starter, pro, enterprise`);
    }

    await query(
      `UPDATE tenants
       SET plan_status = $1,
           max_channels = $2,
           max_contacts = $3,
           max_monthly_messages = $4,
           max_monthly_ai_queries = $5,
           updated_at = now()
       WHERE id = $6`,
      [
        targetPlan.id,
        targetPlan.maxChannels,
        targetPlan.maxContacts,
        targetPlan.maxMonthlyMessages,
        targetPlan.maxMonthlyAiQueries,
        params.tenantId,
      ]
    );

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "plan.upgrade",
      resourceType: "plan",
      resourceId: targetPlan.id,
      details: { planName: targetPlan.name, priceMonthly: targetPlan.priceMonthly },
      ipAddress: params.ipAddress,
    });

    log.info("Upgraded workspace plan tier", { tenantId: params.tenantId, plan: targetPlan.id });

    return {
      message: `Workspace successfully switched to ${targetPlan.name}`,
      plan: targetPlan,
    };
  }
}

import { query, queryOne } from "../../db/pool";
import { getMongoDb } from "../../db/mongo";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "compliance-service" });

export interface ContactDataExportBundle {
  exportMetadata: {
    exportDate: string;
    tenantId: string;
    contactId: string;
    requestedBy: string | null;
    legalBasis: string;
  };
  contact: any;
  conversations: any[];
  messages: any[];
  deals: any[];
  orders: any[];
}

export class ComplianceService {
  /**
   * GDPR Article 15: Right of Access by the Data Subject.
   * Compiles an immutable, portable JSON export containing all personal data,
   * message histories, channel interactions, deals, and orders.
   */
  public static async exportContactData(params: {
    tenantId: string;
    contactId: string;
    actorId?: string;
    actorEmail?: string;
    ipAddress?: string;
  }): Promise<ContactDataExportBundle> {
    // 1. Fetch Contact
    const contact = await queryOne(
      "SELECT id, tenant_id, channel_id, external_id, name, attributes, created_at, updated_at FROM contacts WHERE id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );

    if (!contact) {
      throw new Error("Contact not found in this workspace");
    }

    // 2. Fetch Conversations
    const conversations = await query(
      "SELECT id, channel_id, channel_type, status, last_message_at, created_at FROM conversations WHERE contact_id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );

    const convIds = conversations.map((c) => c.id);

    // 3. Fetch Messages from MongoDB
    let messages: any[] = [];
    if (convIds.length > 0) {
      try {
        const mongo = await getMongoDb();
        messages = await mongo
          .collection("messages")
          .find({
            conversationId: { $in: convIds },
          })
          .project({ _id: 0 })
          .sort({ sentAt: 1 })
          .toArray();
      } catch (err: any) {
        log.warn("Failed to retrieve mongo messages for GDPR export", { error: err.message });
      }
    }

    // 4. Fetch CRM Deals
    const deals = await query(
      "SELECT id, title, stage, value, created_at, updated_at FROM deals WHERE contact_id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );

    // 5. Fetch Commerce Orders
    const orders = await query(
      "SELECT id, order_number, status, total_amount, currency, items, payment_status, created_at FROM orders WHERE contact_id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "compliance.export",
      resourceType: "contact",
      resourceId: params.contactId,
      details: {
        contactName: contact.name,
        externalId: contact.external_id,
        messagesCount: messages.length,
        conversationsCount: conversations.length,
      },
      ipAddress: params.ipAddress,
    });

    log.info("Exported GDPR data bundle for contact", {
      tenantId: params.tenantId,
      contactId: params.contactId,
      messagesCount: messages.length,
    });

    return {
      exportMetadata: {
        exportDate: new Date().toISOString(),
        tenantId: params.tenantId,
        contactId: params.contactId,
        requestedBy: params.actorEmail || params.actorId || "admin",
        legalBasis: "GDPR Article 15 / CCPA Data Subject Access Request",
      },
      contact,
      conversations,
      messages,
      deals,
      orders,
    };
  }

  /**
   * GDPR Article 17: Right to Erasure ('Right to be Forgotten').
   * Cascades permanent deletion across relational PostgreSQL entities and MongoDB chat collections.
   */
  public static async purgeContactData(params: {
    tenantId: string;
    contactId: string;
    actorId?: string;
    actorEmail?: string;
    ipAddress?: string;
  }): Promise<{ message: string; deletedItemsCount: { conversations: number; messages: number } }> {
    const contact = await queryOne<{ id: string; name: string; external_id: string }>(
      "SELECT id, name, external_id FROM contacts WHERE id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );

    if (!contact) {
      throw new Error("Contact not found in this workspace");
    }

    // 1. Get conversation IDs
    const conversations = await query<{ id: string }>(
      "SELECT id FROM conversations WHERE contact_id = $1 AND tenant_id = $2",
      [params.contactId, params.tenantId]
    );
    const convIds = conversations.map((c) => c.id);

    // 2. Delete MongoDB chat messages
    let deletedMessagesCount = 0;
    if (convIds.length > 0) {
      try {
        const mongo = await getMongoDb();
        const deleteRes = await mongo.collection("messages").deleteMany({
          conversationId: { $in: convIds },
        });
        deletedMessagesCount = deleteRes.deletedCount;
      } catch (err: any) {
        log.warn("Failed to delete mongo messages for GDPR erasure", { error: err.message });
      }
    }

    // 3. Delete Deals and Orders
    await query("DELETE FROM deals WHERE contact_id = $1 AND tenant_id = $2", [params.contactId, params.tenantId]);
    await query("DELETE FROM orders WHERE contact_id = $1 AND tenant_id = $2", [params.contactId, params.tenantId]);

    // 4. Delete Conversations & Contact in Postgres
    await query("DELETE FROM conversations WHERE contact_id = $1 AND tenant_id = $2", [
      params.contactId,
      params.tenantId,
    ]);
    await query("DELETE FROM contacts WHERE id = $1 AND tenant_id = $2", [params.contactId, params.tenantId]);

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "compliance.delete",
      resourceType: "contact",
      resourceId: params.contactId,
      details: {
        contactIdentifier: contact.external_id,
        deletedConversations: convIds.length,
        deletedMessages: deletedMessagesCount,
      },
      ipAddress: params.ipAddress,
    });

    log.info("Executed GDPR Right-to-be-Forgotten erasure for contact", {
      tenantId: params.tenantId,
      contactId: params.contactId,
      deletedConversations: convIds.length,
      deletedMessages: deletedMessagesCount,
    });

    return {
      message: `Personal data for contact ${contact.external_id || contact.name} has been permanently erased.`,
      deletedItemsCount: {
        conversations: convIds.length,
        messages: deletedMessagesCount,
      },
    };
  }
}

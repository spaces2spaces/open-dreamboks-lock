import { db } from "./db";
import { tenants, settings } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { Storage } from "./storage";

export interface ActiveTenant {
  id: string;
  name: string;
  slug: string;
  pmsType: string | null;
  hasMewsCredentials: boolean;
  hasTTLockCredentials: boolean;
}

export class TenantDirectory {
  async listActiveTenants(): Promise<ActiveTenant[]> {
    const allTenants = await db.select().from(tenants).where(eq(tenants.active, true));
    
    const result: ActiveTenant[] = [];
    
    for (const tenant of allTenants) {
      const tenantSettings = await db
        .select()
        .from(settings)
        .where(eq(settings.tenantId, tenant.id));
      
      const hasMewsToken = tenantSettings.some(s => s.key === "mews_client_token" && s.value);
      const hasMewsAccess = tenantSettings.some(s => s.key === "mews_access_token" && s.value);
      const hasTTLockUsername = tenantSettings.some(s => s.key === "ttlock_username" && s.value);
      const hasTTLockPassword = tenantSettings.some(s => s.key === "ttlock_password" && s.value);
      
      result.push({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        pmsType: tenant.pmsType,
        hasMewsCredentials: hasMewsToken && hasMewsAccess,
        hasTTLockCredentials: hasTTLockUsername && hasTTLockPassword,
      });
    }
    
    return result;
  }
  
  async getTenantsWithMewsCredentials(): Promise<ActiveTenant[]> {
    const active = await this.listActiveTenants();
    return active.filter(t => t.hasMewsCredentials);
  }
  
  async getTenant(id: string): Promise<ActiveTenant | undefined> {
    const active = await this.listActiveTenants();
    return active.find(t => t.id === id);
  }
  
  async getTenantBySlug(slug: string): Promise<ActiveTenant | undefined> {
    const active = await this.listActiveTenants();
    return active.find(t => t.slug === slug);
  }
  
  async getTenantByApiKey(apiKey: string): Promise<ActiveTenant | undefined> {
    const tenant = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.apiKey, apiKey), eq(tenants.active, true)))
      .limit(1);
    
    if (tenant.length === 0) return undefined;
    
    return this.getTenant(tenant[0].id);
  }
}

export const tenantDirectory = new TenantDirectory();

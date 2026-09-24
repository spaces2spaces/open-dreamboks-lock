import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  RefreshCw, Battery, BatteryLow, BatteryWarning, Lock, Shield, KeyRound,
  AlertTriangle, Building2, Plus, Key, AlertCircle,
  Hotel, Copy, CheckCircle2, XCircle, Activity, Mail, Send, Eye, EyeOff,
  Server, Database, Plug, Settings, ExternalLink, Trash2, Cpu
} from "lucide-react";
import { adminAPI, type AdminTenant, type AdminTenantStats, type AdminTenantCredentials } from "@/lib/api";
import { toast } from "sonner";

function TenantCard({ tenant, onRefresh }: { tenant: AdminTenant; onRefresh: () => void }) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["admin-tenant-stats", tenant.id],
    queryFn: () => adminAPI.getTenantStats(tenant.id),
  });

  const stats = statsData?.stats;

  const copyApiKey = async () => {
    await navigator.clipboard.writeText(tenant.apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <Card className={`${!tenant.active ? 'opacity-60' : ''}`} data-testid={`card-tenant-${tenant.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Hotel className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {tenant.name}
                {!tenant.active && (
                  <Badge variant="secondary" className="text-xs">Inactive</Badge>
                )}
              </CardTitle>
              <CardDescription className="flex items-center gap-2 mt-1">
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{tenant.slug}</span>
                {tenant.pmsType && (
                  <Badge variant="outline" className="text-xs">{tenant.pmsType.toUpperCase()}</Badge>
                )}
              </CardDescription>
            </div>
          </div>
          {tenant.active ? (
            <Badge className="bg-green-100 text-green-800">
              <Activity className="w-3 h-3 mr-1" />
              Active
            </Badge>
          ) : (
            <Badge variant="secondary">
              <XCircle className="w-3 h-3 mr-1" />
              Inactive
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {statsLoading ? (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : stats ? (
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 bg-muted/50 rounded-lg">
              <div className="text-2xl font-bold">{stats.roomCount}</div>
              <div className="text-xs text-muted-foreground">Rooms</div>
            </div>
            <div className="text-center p-2 bg-muted/50 rounded-lg">
              <div className="text-2xl font-bold">{stats.lockDeviceCount}</div>
              <div className="text-xs text-muted-foreground">Locks</div>
            </div>
            <div className="text-center p-2 bg-muted/50 rounded-lg">
              <div className="text-2xl font-bold text-green-600">{stats.activePinCount}</div>
              <div className="text-xs text-muted-foreground">Active Pins</div>
            </div>
          </div>
        ) : null}

        {stats?.lastError && (
          <div className="flex items-start gap-2 p-2 bg-red-50 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-red-700 truncate" title={stats.lastError.message}>
              {stats.lastError.message}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">API Key</Label>
          <div className="flex items-center gap-2">
            <Input
              type={showApiKey ? "text" : "password"}
              value={tenant.apiKey}
              readOnly
              className="font-mono text-xs"
              data-testid={`input-apikey-${tenant.id}`}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={copyApiKey}
              data-testid={`button-copy-apikey-${tenant.id}`}
            >
              {copied ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
          <span>Created {formatDate(tenant.createdAt)}</span>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-7"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? "Hide" : "Show"} Key
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateTenantDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [pmsType, setPmsType] = useState("");

  const createMutation = useMutation({
    mutationFn: (data: { name: string; slug: string; pmsType?: string }) =>
      adminAPI.createTenant(data),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setSlug("");
      setPmsType("");
      onCreated();
    },
  });

  const handleNameChange = (value: string) => {
    setName(value);
    setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-create-tenant">
          <Plus className="w-4 h-4 mr-2" />
          Add Hotel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Hotel</DialogTitle>
          <DialogDescription>
            Create a new hotel tenant. An API key will be generated automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="tenant-name">Hotel Name</Label>
            <Input
              id="tenant-name"
              placeholder="DreamBoks Amsterdam"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              data-testid="input-tenant-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tenant-slug">URL Slug</Label>
            <Input
              id="tenant-slug"
              placeholder="dreamboks-amsterdam"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              data-testid="input-tenant-slug"
            />
            <p className="text-xs text-muted-foreground">
              Used in URLs. Only lowercase letters, numbers, and hyphens.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pms-type">PMS System</Label>
            <Select value={pmsType} onValueChange={setPmsType}>
              <SelectTrigger data-testid="select-pms-type">
                <SelectValue placeholder="Select PMS system" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mews">MEWS</SelectItem>
                <SelectItem value="opera">Opera</SelectItem>
                <SelectItem value="protel">Protel</SelectItem>
                <SelectItem value="cloudbeds">Cloudbeds</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate({ name, slug, pmsType: pmsType || undefined })}
            disabled={!name || !slug || createMutation.isPending}
            data-testid="button-submit-tenant"
          >
            {createMutation.isPending ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-2" />
            )}
            Create Hotel
          </Button>
        </DialogFooter>
        {createMutation.isError && (
          <div className="flex items-center gap-2 text-destructive text-sm mt-2">
            <AlertTriangle className="w-4 h-4" />
            {(createMutation.error as Error).message}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TenantsTab() {
  const queryClient = useQueryClient();

  const { data: tenantsData, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: adminAPI.getAllTenants,
  });

  const tenants = tenantsData?.tenants || [];
  const activeTenants = tenants.filter(t => t.active);
  const inactiveTenants = tenants.filter(t => !t.active);

  const handleRefresh = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["admin-tenant-stats"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Hotels</h2>
          <p className="text-muted-foreground text-sm">
            {activeTenants.length} active hotels registered
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="outline"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="button-refresh-tenants"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <CreateTenantDialog onCreated={handleRefresh} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : tenants.length === 0 ? (
        <Card className="p-12 text-center">
          <Building2 className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="font-medium mb-2">No hotels registered</h3>
          <p className="text-muted-foreground text-sm mb-4">
            Add your first hotel to get started
          </p>
          <CreateTenantDialog onCreated={handleRefresh} />
        </Card>
      ) : (
        <div className="space-y-6">
          {activeTenants.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeTenants.map((tenant) => (
                <TenantCard key={tenant.id} tenant={tenant} onRefresh={handleRefresh} />
              ))}
            </div>
          )}

          {inactiveTenants.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">Inactive Hotels</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {inactiveTenants.map((tenant) => (
                  <TenantCard key={tenant.id} tenant={tenant} onRefresh={handleRefresh} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CredentialField({ label, value, masked = false }: { label: string; value: string | null; masked?: boolean }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyValue = async () => {
    if (value) {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!value) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm text-muted-foreground italic">Not configured</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="text-xs bg-muted px-2 py-1 rounded font-mono max-w-[200px] truncate">
          {masked && !show ? "••••••••" : value}
        </code>
        {masked && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShow(!show)}>
            {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyValue}>
          {copied ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
        </Button>
      </div>
    </div>
  );
}

function TenantCredentialsCard({ tenant }: { tenant: AdminTenant }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-tenant-credentials", tenant.id],
    queryFn: () => adminAPI.getTenantCredentials(tenant.id),
  });

  const credentials = data?.credentials;

  return (
    <Card data-testid={`card-credentials-${tenant.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Hotel className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">{tenant.name}</CardTitle>
            <CardDescription className="flex items-center gap-2">
              {tenant.pmsType && (
                <Badge variant="outline" className="text-xs">{tenant.pmsType.toUpperCase()}</Badge>
              )}
              {!tenant.active && <Badge variant="secondary" className="text-xs">Inactive</Badge>}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : credentials ? (
          <Accordion type="multiple" className="w-full">
            <AccordionItem value="mews">
              <AccordionTrigger className="text-sm">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  MEWS PMS
                  {credentials.mews.accessToken ? (
                    <Badge variant="outline" className="ml-2 text-xs text-green-600">Configured</Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-2 text-xs">Not Set</Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="divide-y">
                <CredentialField label="Environment" value={credentials.mews.environment} />
                <CredentialField label="Client Token" value={credentials.mews.clientToken} masked />
                <CredentialField label="Access Token" value={credentials.mews.accessToken} masked />
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="ttlock">
              <AccordionTrigger className="text-sm">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4" />
                  TTLock
                  {credentials.ttlock.accessToken ? (
                    <Badge variant="outline" className="ml-2 text-xs text-green-600">Configured</Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-2 text-xs">Not Set</Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="divide-y">
                <CredentialField label="Username" value={credentials.ttlock.username} />
                <CredentialField label="Password" value={credentials.ttlock.password} masked />
                <CredentialField label="Access Token" value={credentials.ttlock.accessToken} masked />
                <CredentialField label="Region" value={credentials.ttlock.region} />
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="notifications">
              <AccordionTrigger className="text-sm">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4" />
                  Notifications
                </div>
              </AccordionTrigger>
              <AccordionContent className="divide-y">
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-muted-foreground">SMS Enabled</span>
                  <Badge variant={credentials.notifications.smsEnabled ? "default" : "secondary"}>
                    {credentials.notifications.smsEnabled ? "Yes" : "No"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-muted-foreground">Email Enabled</span>
                  <Badge variant={credentials.notifications.emailEnabled ? "default" : "secondary"}>
                    {credentials.notifications.emailEnabled ? "Yes" : "No"}
                  </Badge>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            Failed to load credentials
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CredentialsTab() {
  const { data: tenantsData, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: adminAPI.getAllTenants,
  });

  const tenants = tenantsData?.tenants.filter(t => t.active) || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Credentials Vault</h2>
          <p className="text-muted-foreground text-sm">
            View and manage API keys and passwords for all hotels
          </p>
        </div>
        <Button 
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-credentials"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : tenants.length === 0 ? (
        <Card className="p-12 text-center">
          <Key className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="font-medium mb-2">No hotels to show</h3>
          <p className="text-muted-foreground text-sm">
            Add hotels first to view their credentials
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {tenants.map((tenant) => (
            <TenantCredentialsCard key={tenant.id} tenant={tenant} />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegrationsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">PMS Integrations</h2>
        <p className="text-muted-foreground text-sm">
          Configure property management system adapters
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Server className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-base">MEWS</CardTitle>
                <CardDescription>Cloud-based PMS</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Badge className="bg-green-100 text-green-800">Active</Badge>
              <Button variant="outline" size="sm">
                <Settings className="w-4 h-4 mr-2" />
                Configure
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Server className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <CardTitle className="text-base">Opera</CardTitle>
                <CardDescription>Oracle Hospitality</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">Coming Soon</Badge>
              <Button variant="outline" size="sm" disabled>
                <Plug className="w-4 h-4 mr-2" />
                Setup
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <Server className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <CardTitle className="text-base">Protel</CardTitle>
                <CardDescription>Planet Hospitality</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">Coming Soon</Badge>
              <Button variant="outline" size="sm" disabled>
                <Plug className="w-4 h-4 mr-2" />
                Setup
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Server className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <CardTitle className="text-base">Cloudbeds</CardTitle>
                <CardDescription>All-in-one platform</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">Coming Soon</Badge>
              <Button variant="outline" size="sm" disabled>
                <Plug className="w-4 h-4 mr-2" />
                Setup
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">TTLock Integration</CardTitle>
          <CardDescription>Smart lock system configuration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-3">
              <Lock className="w-5 h-5 text-primary" />
              <div>
                <div className="font-medium text-sm">Owner Account</div>
                <div className="text-xs text-muted-foreground">lock@spaces2spaces.com</div>
              </div>
            </div>
            <Badge className="bg-green-100 text-green-800">Connected</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Owner account is used for read-only lock discovery. Hotels configure their own Authorized Admin credentials for passcode operations.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function InvitationsTab() {
  const queryClient = useQueryClient();
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSending, setIsSending] = useState(false);

  const { data: tenantsData } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: adminAPI.getAllTenants,
  });

  const { data: invitationsData, isLoading: loadingInvitations } = useQuery({
    queryKey: ["admin-invitations"],
    queryFn: adminAPI.getAllInvitations,
  });

  const tenants = tenantsData?.tenants.filter(t => t.active) || [];
  const invitations = invitationsData?.invitations || [];

  const getTenantName = (tenantId: string) => {
    return tenants.find(t => t.id === tenantId)?.name || "Unknown";
  };

  const handleSendInvitation = async () => {
    if (!selectedTenantId || !inviteEmail) {
      toast.error("Please select a hotel and enter an email address");
      return;
    }

    setIsSending(true);
    try {
      const result = await adminAPI.createInvitation({
        tenantId: selectedTenantId,
        email: inviteEmail,
        sendEmail: true,
      });
      
      if (result.success) {
        if (result.emailSent) {
          toast.success("Invitation sent successfully!");
        } else {
          toast.warning("Invitation created but email failed to send. Copy the link below.");
        }
        setSelectedTenantId("");
        setInviteEmail("");
        queryClient.invalidateQueries({ queryKey: ["admin-invitations"] });
      } else {
        toast.error("Failed to create invitation");
      }
    } catch (error) {
      toast.error("Failed to send invitation");
      console.error("Error sending invitation:", error);
    } finally {
      setIsSending(false);
    }
  };

  const handleDeleteInvitation = async (id: string) => {
    try {
      await adminAPI.deleteInvitation(id);
      toast.success("Invitation deleted");
      queryClient.invalidateQueries({ queryKey: ["admin-invitations"] });
    } catch (error) {
      toast.error("Failed to delete invitation");
    }
  };

  const copySetupLink = async (token: string) => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/setup?token=${token}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(link);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = link;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        textArea.remove();
      }
      toast.success("Link copied to clipboard");
    } catch (err) {
      toast.error("Could not copy link - please copy manually");
      console.error("Copy failed:", err);
    }
  };

  const getInvitationStatus = (invitation: { usedAt: string | null; expiresAt: string }) => {
    if (invitation.usedAt) {
      return <Badge className="bg-green-100 text-green-800">Used</Badge>;
    }
    if (new Date(invitation.expiresAt) < new Date()) {
      return <Badge variant="destructive">Expired</Badge>;
    }
    return <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Invitations</h2>
          <p className="text-muted-foreground text-sm">
            Send setup invitations to hotels
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Send Setup Invitation</CardTitle>
          <CardDescription>
            Invite a hotel to complete their setup. They will receive an email with a unique link.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="invite-hotel">Select Hotel</Label>
              <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
                <SelectTrigger id="invite-hotel" data-testid="select-invite-hotel">
                  <SelectValue placeholder="Choose a hotel" />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Admin Email</Label>
              <Input 
                id="invite-email" 
                type="email" 
                placeholder="admin@hotel.com" 
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                data-testid="input-invite-email"
              />
            </div>
          </div>
          <Button 
            onClick={handleSendInvitation} 
            disabled={isSending || !selectedTenantId || !inviteEmail}
            data-testid="button-send-invitation"
          >
            {isSending ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-2" />
            )}
            Send Invitation
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invitation History</CardTitle>
          <CardDescription>
            Track all sent invitations and their status
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingInvitations ? (
            <div className="flex justify-center py-8">
              <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No invitations sent yet.
            </p>
          ) : (
            <div className="space-y-2">
              {invitations.map(invitation => (
                <div 
                  key={invitation.id} 
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                  data-testid={`invitation-${invitation.id}`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{getTenantName(invitation.tenantId)}</span>
                      {getInvitationStatus(invitation)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {invitation.email} • Expires {new Date(invitation.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!invitation.usedAt && new Date(invitation.expiresAt) >= new Date() && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => copySetupLink(invitation.token)}
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy Link
                      </Button>
                    )}
                    <Button 
                      variant="ghost" 
                      size="sm"
                      onClick={() => handleDeleteInvitation(invitation.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LocksTab() {
  const [searchTerm, setSearchTerm] = useState("");

  const { data: locksData, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-locks"],
    queryFn: adminAPI.getAllLocks,
  });

  const locks = locksData?.locks || [];

  const filteredLocks = locks.filter((lock) =>
    lock.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    lock.mac.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (lock.groupName && lock.groupName.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  // Group by TTLock groupName, fallback to "Ungrouped" for locks without a group
  const groupedLocks = filteredLocks.reduce((acc, lock) => {
    const groupName = lock.groupName || "Ungrouped";
    if (!acc[groupName]) {
      acc[groupName] = [];
    }
    acc[groupName].push(lock);
    return acc;
  }, {} as Record<string, typeof locks>);

  // Sort groups alphabetically, but put "Ungrouped" at the end
  const sortedGroups = Object.keys(groupedLocks).sort((a, b) => {
    if (a === "Ungrouped") return 1;
    if (b === "Ungrouped") return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  const getBatteryIcon = (battery: number) => {
    if (battery >= 80) return <Battery className="w-4 h-4 text-green-600" />;
    if (battery >= 40) return <BatteryWarning className="w-4 h-4 text-yellow-600" />;
    return <BatteryLow className="w-4 h-4 text-red-600" />;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">All Locks</h2>
          <p className="text-muted-foreground text-sm">
            Owner view of all locks across all hotels ({locksData?.total || 0} total)
          </p>
        </div>
        <Button 
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-admin-locks"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card className="p-4">
        <Input
          placeholder="Search by lock name or MAC address..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="max-w-md"
          data-testid="input-search-admin-locks"
        />
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredLocks.length === 0 ? (
        <Card className="p-12 text-center">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No locks found</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {sortedGroups.map((groupName) => (
            <Card key={groupName} className="p-4">
              <div className="flex items-center gap-2 mb-4">
                <Badge variant="outline" className="text-sm font-semibold">
                  {groupName}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  ({groupedLocks[groupName].length} locks)
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {groupedLocks[groupName]
                  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                  .map((lock) => (
                    <div
                      key={lock.lockId}
                      className="p-3 border rounded-lg bg-card hover:bg-accent/50 transition-colors"
                      data-testid={`card-admin-lock-${lock.lockId}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Lock className="w-4 h-4 text-primary" />
                          <span className="font-medium">{lock.name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {getBatteryIcon(lock.battery)}
                          <span className="text-xs text-muted-foreground">{lock.battery}%</span>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div className="flex justify-between">
                          <span>MAC:</span>
                          <span className="font-mono">{lock.mac}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>ID:</span>
                          <span className="font-mono">{lock.lockId}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Added:</span>
                          <span>{formatDate(lock.date)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

type WorkerStatus = "running" | "stopped" | "ready" | "not_ready";

interface TenantSchedulerStatus {
  name: string;
  pinActivation: WorkerStatus;
  unlockRecords: WorkerStatus;
  autoCheckin: WorkerStatus;
  mewsPoller: WorkerStatus;
  automationEngine: WorkerStatus;
}

function StatusBadge({ status }: { status: WorkerStatus }) {
  if (status === "running" || status === "ready") {
    return (
      <Badge className="bg-green-100 text-green-800 text-xs">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        {status}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      <XCircle className="w-3 h-3 mr-1" />
      {status}
    </Badge>
  );
}

function SystemTab() {
  const { data, isLoading, refetch, isFetching } = useQuery<Record<string, TenantSchedulerStatus>>({
    queryKey: ["scheduler-status"],
    queryFn: async () => {
      const response = await fetch("/api/scheduler-status");
      if (!response.ok) throw new Error("Failed to fetch scheduler status");
      return response.json();
    },
    refetchInterval: 30000,
  });

  const tenantEntries = data ? Object.entries(data) : [];

  type WorkerKey = Exclude<keyof TenantSchedulerStatus, "name">;
  const workers: { key: WorkerKey; label: string }[] = [
    { key: "automationEngine", label: "Automation Engine" },
    { key: "pinActivation", label: "PIN Activation" },
    { key: "unlockRecords", label: "Unlock Records" },
    { key: "autoCheckin", label: "Auto Check-in" },
    { key: "mewsPoller", label: "MEWS Poller" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">System Status</h2>
          <p className="text-muted-foreground text-sm">
            Background worker health per hotel tenant
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-system-status"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : tenantEntries.length === 0 ? (
        <Card className="p-12 text-center">
          <Cpu className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No tenants active</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {tenantEntries.map(([tenantId, status]) => {
            const allOk = workers.every(
              (w) => status[w.key] === "running" || status[w.key] === "ready"
            );
            return (
              <Card key={tenantId} data-testid={`card-system-${tenantId}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <Hotel className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{status.name}</CardTitle>
                        <CardDescription className="font-mono text-xs">{tenantId}</CardDescription>
                      </div>
                    </div>
                    {allOk ? (
                      <Badge className="bg-green-100 text-green-800">
                        <Activity className="w-3 h-3 mr-1" />
                        All systems go
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        Degraded
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {workers.map((w) => (
                      <div
                        key={w.key}
                        className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                      >
                        <span className="text-xs text-muted-foreground">{w.label}</span>
                        <StatusBadge status={status[w.key]} />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function VendorPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");

  const loginMutation = useMutation({
    mutationFn: async (credentials: { username: string; password: string }) => {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid credentials");
      }
      return response.json();
    },
    onSuccess: (data: { success: boolean; token: string }) => {
      adminAPI.setToken(data.token);
      setIsAuthenticated(true);
      setAuthError("");
    },
    onError: (error: Error) => {
      setAuthError(error.message);
      setPassword("");
    },
  });

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username && password) {
      loginMutation.mutate({ username, password });
    }
  };

  if (!isAuthenticated) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                <KeyRound className="w-6 h-6 text-primary" />
              </div>
              <CardTitle>Vendor Admin Access</CardTitle>
              <CardDescription>
                Log ind med dine vendor-administratoroplysninger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="admin-username">Brugernavn</Label>
                  <Input
                    id="admin-username"
                    type="text"
                    placeholder="Brugernavn"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                    data-testid="input-admin-username"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="admin-password">Adgangskode</Label>
                  <div className="relative">
                    <Input
                      id="admin-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Adgangskode"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      data-testid="input-admin-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                {authError && (
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <AlertTriangle className="w-4 h-4" />
                    {authError}
                  </div>
                )}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!username || !password || loginMutation.isPending}
                  data-testid="button-admin-login"
                >
                  {loginMutation.isPending ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Shield className="w-4 h-4 mr-2" />
                  )}
                  Log ind
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Vendor Administration</h1>
            <p className="text-muted-foreground">
              Manage hotels, integrations, and system-wide settings
            </p>
          </div>
        </div>

        <Tabs defaultValue="hotels" className="space-y-6">
          <TabsList className="grid grid-cols-6 w-full max-w-3xl">
            <TabsTrigger value="hotels" data-testid="tab-hotels">
              <Building2 className="w-4 h-4 mr-2" />
              Hotels
            </TabsTrigger>
            <TabsTrigger value="credentials" data-testid="tab-credentials">
              <Key className="w-4 h-4 mr-2" />
              Credentials
            </TabsTrigger>
            <TabsTrigger value="integrations" data-testid="tab-integrations">
              <Plug className="w-4 h-4 mr-2" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="invitations" data-testid="tab-invitations">
              <Mail className="w-4 h-4 mr-2" />
              Invitations
            </TabsTrigger>
            <TabsTrigger value="locks" data-testid="tab-locks">
              <Lock className="w-4 h-4 mr-2" />
              Locks
            </TabsTrigger>
            <TabsTrigger value="system" data-testid="tab-system">
              <Cpu className="w-4 h-4 mr-2" />
              System
            </TabsTrigger>
          </TabsList>

          <TabsContent value="hotels">
            <TenantsTab />
          </TabsContent>

          <TabsContent value="credentials">
            <CredentialsTab />
          </TabsContent>

          <TabsContent value="integrations">
            <IntegrationsTab />
          </TabsContent>

          <TabsContent value="invitations">
            <InvitationsTab />
          </TabsContent>

          <TabsContent value="locks">
            <LocksTab />
          </TabsContent>

          <TabsContent value="system">
            <SystemTab />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}

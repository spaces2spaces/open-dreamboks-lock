import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { settingsAPI, roomsAPI, lockDevicesAPI, validateInvitationToken, useInvitationToken, createTenantScopedAPI } from "@/lib/api";
import { 
  Building2, 
  Hotel, 
  Lock, 
  Boxes, 
  Link2, 
  CheckCircle2, 
  ChevronRight, 
  ChevronLeft,
  Eye,
  EyeOff,
  RefreshCw,
  ArrowRight,
  Sparkles,
  AlertCircle,
  XCircle
} from "lucide-react";

type Step = {
  id: string;
  title: string;
  icon: React.ReactNode;
  description: string;
};

const STEPS: Step[] = [
  { id: "property", title: "Property Info", icon: <Building2 className="w-5 h-5" />, description: "Basic property settings" },
  { id: "mews", title: "MEWS Connection", icon: <Hotel className="w-5 h-5" />, description: "Connect to your PMS" },
  { id: "ttlock", title: "TTLock Account", icon: <Lock className="w-5 h-5" />, description: "Connect smart locks" },
  { id: "sync", title: "Sync Data", icon: <Boxes className="w-5 h-5" />, description: "Import rooms and locks" },
  { id: "complete", title: "All Done!", icon: <CheckCircle2 className="w-5 h-5" />, description: "Setup complete" },
];

export default function QuickSetupPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [currentStep, setCurrentStep] = useState(0);
  
  const [tokenValidation, setTokenValidation] = useState<{
    isValidating: boolean;
    isValid: boolean | null;
    error?: string;
    tenantId?: string;
    tenantName?: string;
    email?: string;
  }>({ isValidating: true, isValid: null });
  
  const [showMewsClientToken, setShowMewsClientToken] = useState(false);
  const [showMewsAccessToken, setShowMewsAccessToken] = useState(false);
  const [showTtlockPassword, setShowTtlockPassword] = useState(false);
  
  const [formData, setFormData] = useState({
    property_timezone: "Europe/Copenhagen",
    reservation_arrival_time: "14:00",
    reservation_checkout_time: "11:00",
    reservation_list_days_ahead: "1",
    mews_environment: "demo",
    mews_client_token: "",
    mews_access_token: "",
    ttlock_username: "",
    ttlock_password: "",
    ttlock_region: "eu",
  });
  
  const [connectionStatus, setConnectionStatus] = useState({
    mewsConnected: false,
    ttlockConnected: false,
    spacesSynced: false,
    locksSynced: false,
  });
  
  useEffect(() => {
    async function validateToken() {
      const params = new URLSearchParams(searchString);
      const token = params.get("token");
      
      if (!token) {
        setTokenValidation({
          isValidating: false,
          isValid: false,
          error: "No invitation token provided. Please use the link from your invitation email.",
        });
        return;
      }
      
      try {
        const result = await validateInvitationToken(token);
        if (result.valid) {
          setTokenValidation({
            isValidating: false,
            isValid: true,
            tenantId: result.tenantId,
            tenantName: result.tenantName,
            email: result.email,
          });
        } else {
          setTokenValidation({
            isValidating: false,
            isValid: false,
            error: result.error || "Invalid invitation token",
          });
        }
      } catch (error) {
        setTokenValidation({
          isValidating: false,
          isValid: false,
          error: "Failed to validate invitation token. Please try again.",
        });
      }
    }
    
    validateToken();
  }, [searchString]);

  // Create tenant-scoped API for onboarding (uses tenant ID + invitation token from the URL)
  const setupToken = new URLSearchParams(searchString).get("token") || undefined;
  const tenantAPI = tokenValidation.tenantId ? createTenantScopedAPI(tokenValidation.tenantId, setupToken) : null;

  const { data: settings = [] } = useQuery({
    queryKey: ["settings", tokenValidation.tenantId],
    queryFn: () => tenantAPI!.settings.getAll(),
    enabled: tokenValidation.isValid === true && !!tokenValidation.tenantId && !!tenantAPI,
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", tokenValidation.tenantId],
    queryFn: () => tenantAPI!.rooms.getAll(),
    enabled: tokenValidation.isValid === true && !!tokenValidation.tenantId && !!tenantAPI,
  });

  const { data: lockDevices = [] } = useQuery({
    queryKey: ["lock-devices", tokenValidation.tenantId],
    queryFn: () => tenantAPI!.lockDevices.getAll(),
    enabled: tokenValidation.isValid === true && !!tokenValidation.tenantId && !!tenantAPI,
  });

  useEffect(() => {
    if (settings.length > 0) {
      const getValue = (key: string) => settings.find(s => s.key === key)?.value || "";
      const hasEncrypted = (key: string) => {
        const s = settings.find(s => s.key === key);
        return s && s.encrypted && s.value === "";
      };
      const hasValue = (key: string) => {
        const s = settings.find(s => s.key === key);
        return s !== undefined && (s.encrypted || (s.value && s.value.length > 0));
      };
      
      setFormData(prev => ({
        ...prev,
        property_timezone: getValue("property_timezone") || "Europe/Copenhagen",
        reservation_arrival_time: getValue("reservation_arrival_time") || "14:00",
        reservation_checkout_time: getValue("reservation_checkout_time") || "11:00",
        reservation_list_days_ahead: getValue("reservation_list_days_ahead") || "1",
        mews_environment: getValue("mews_environment") || "demo",
        mews_client_token: hasEncrypted("mews_client_token") ? "••••••••" : getValue("mews_client_token"),
        mews_access_token: hasEncrypted("mews_access_token") ? "••••••••" : getValue("mews_access_token"),
        ttlock_username: hasEncrypted("ttlock_username") ? "••••••••" : getValue("ttlock_username"),
        ttlock_password: hasEncrypted("ttlock_password") ? "••••••••" : getValue("ttlock_password"),
        ttlock_region: getValue("ttlock_region") || "eu",
      }));
      
      setConnectionStatus({
        mewsConnected: !!hasValue("mews_access_token"),
        ttlockConnected: !!hasValue("ttlock_access_token"),
        spacesSynced: rooms.length > 0,
        locksSynced: lockDevices.length > 0,
      });
    }
  }, [settings, rooms.length, lockDevices.length]);

  const updateSettingMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => {
      if (!tenantAPI) throw new Error("Tenant API not initialized");
      return tenantAPI.settings.update(key, value);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const syncSpacesMutation = useMutation({
    mutationFn: () => {
      if (!tenantAPI) throw new Error("Tenant API not initialized");
      return tenantAPI.rooms.sync();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast({
        title: "Spaces synced successfully",
        description: `Imported: ${data.imported}, Updated: ${data.updated}`,
      });
      setConnectionStatus(prev => ({ ...prev, spacesSynced: true }));
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to sync spaces",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const syncLocksMutation = useMutation({
    mutationFn: () => {
      if (!tenantAPI) throw new Error("Tenant API not initialized");
      return tenantAPI.lockDevices.sync();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["lock-devices"] });
      toast({
        title: "Locks synced successfully",
        description: `Synced: ${data.totalLocks} locks`,
      });
      setConnectionStatus(prev => ({ ...prev, locksSynced: true }));
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to sync locks",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [isSaving, setIsSaving] = useState(false);

  const savePropertySettings = async () => {
    setIsSaving(true);
    try {
      const updates = [
        { key: "property_timezone", value: formData.property_timezone },
        { key: "reservation_arrival_time", value: formData.reservation_arrival_time },
        { key: "reservation_checkout_time", value: formData.reservation_checkout_time },
        { key: "reservation_list_days_ahead", value: formData.reservation_list_days_ahead },
      ];
      
      for (const update of updates) {
        await updateSettingMutation.mutateAsync(update);
      }
      
      toast({ title: "Property settings saved" });
      setCurrentStep(1);
    } catch (error) {
      toast({
        title: "Failed to save property settings",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveMewsSettings = async () => {
    setIsSaving(true);
    try {
      const updates = [
        { key: "mews_environment", value: formData.mews_environment },
      ];
      
      if (formData.mews_client_token && !formData.mews_client_token.includes("•")) {
        updates.push({ key: "mews_client_token", value: formData.mews_client_token });
      }
      if (formData.mews_access_token && !formData.mews_access_token.includes("•")) {
        updates.push({ key: "mews_access_token", value: formData.mews_access_token });
      }
      
      for (const update of updates) {
        await updateSettingMutation.mutateAsync(update);
      }
      
      setConnectionStatus(prev => ({ ...prev, mewsConnected: true }));
      toast({ title: "MEWS connection saved" });
      setCurrentStep(2);
    } catch (error) {
      toast({
        title: "Failed to save MEWS settings",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const connectTTLock = async () => {
    setIsSaving(true);
    try {
      if (formData.ttlock_username && !formData.ttlock_username.includes("•")) {
        await updateSettingMutation.mutateAsync({ key: "ttlock_username", value: formData.ttlock_username });
      }
      if (formData.ttlock_password && !formData.ttlock_password.includes("•")) {
        await updateSettingMutation.mutateAsync({ key: "ttlock_password", value: formData.ttlock_password });
      }
      await updateSettingMutation.mutateAsync({ key: "ttlock_region", value: formData.ttlock_region });
      
      // Use tenant-scoped API for TTLock refresh
      if (!tenantAPI) throw new Error("Tenant API not initialized");
      await tenantAPI.ttlock.refreshToken();
      
      setConnectionStatus(prev => ({ ...prev, ttlockConnected: true }));
      toast({ title: "TTLock account connected successfully" });
      setCurrentStep(3);
    } catch (error) {
      toast({
        title: "Failed to connect TTLock",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const progress = ((currentStep + 1) / STEPS.length) * 100;

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-6">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="timezone">Property Timezone</Label>
                <Select
                  value={formData.property_timezone}
                  onValueChange={(value) => setFormData({ ...formData, property_timezone: value })}
                >
                  <SelectTrigger id="timezone" data-testid="select-timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Europe/Copenhagen">Europe/Copenhagen (DK)</SelectItem>
                    <SelectItem value="Europe/London">Europe/London (UK)</SelectItem>
                    <SelectItem value="Europe/Paris">Europe/Paris (FR)</SelectItem>
                    <SelectItem value="Europe/Berlin">Europe/Berlin (DE)</SelectItem>
                    <SelectItem value="Europe/Amsterdam">Europe/Amsterdam (NL)</SelectItem>
                    <SelectItem value="America/New_York">America/New_York (US East)</SelectItem>
                    <SelectItem value="America/Los_Angeles">America/Los_Angeles (US West)</SelectItem>
                    <SelectItem value="Asia/Tokyo">Asia/Tokyo (JP)</SelectItem>
                    <SelectItem value="Asia/Shanghai">Asia/Shanghai (CN)</SelectItem>
                    <SelectItem value="Australia/Sydney">Australia/Sydney (AU)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="check-in">Check-in Time</Label>
                  <Input
                    id="check-in"
                    type="time"
                    value={formData.reservation_arrival_time}
                    onChange={(e) => setFormData({ ...formData, reservation_arrival_time: e.target.value })}
                    data-testid="input-checkin-time"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="check-out">Check-out Time</Label>
                  <Input
                    id="check-out"
                    type="time"
                    value={formData.reservation_checkout_time}
                    onChange={(e) => setFormData({ ...formData, reservation_checkout_time: e.target.value })}
                    data-testid="input-checkout-time"
                  />
                </div>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="days-ahead">Show Reservations Arriving Within (days)</Label>
                <Input
                  id="days-ahead"
                  type="number"
                  min="0"
                  max="30"
                  value={formData.reservation_list_days_ahead}
                  onChange={(e) => setFormData({ ...formData, reservation_list_days_ahead: e.target.value })}
                  data-testid="input-days-ahead"
                />
                <p className="text-sm text-muted-foreground">0 = today only, 1 = today + tomorrow</p>
              </div>
            </div>
            
            <div className="flex justify-end">
              <Button onClick={savePropertySettings} disabled={isSaving} data-testid="button-next-property">
                {isSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                Continue <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        );
        
      case 1:
        return (
          <div className="space-y-6">
            <div className="grid gap-4">
              <div className="flex items-center justify-between">
                <Label>Environment</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.mews_environment === "demo"}
                    onCheckedChange={(checked) => setFormData({ ...formData, mews_environment: checked ? "demo" : "production" })}
                    data-testid="switch-mews-env"
                  />
                  <span className="text-sm">{formData.mews_environment === "demo" ? "Demo" : "Production"}</span>
                </div>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="mews-client-token">Client Token</Label>
                <div className="flex gap-2">
                  <Input
                    id="mews-client-token"
                    type={showMewsClientToken ? "text" : "password"}
                    value={formData.mews_client_token}
                    onChange={(e) => setFormData({ ...formData, mews_client_token: e.target.value })}
                    placeholder="Enter MEWS Client Token"
                    data-testid="input-mews-client-token"
                  />
                  <Button variant="outline" size="icon" onClick={() => setShowMewsClientToken(!showMewsClientToken)}>
                    {showMewsClientToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="mews-access-token">Access Token</Label>
                <div className="flex gap-2">
                  <Input
                    id="mews-access-token"
                    type={showMewsAccessToken ? "text" : "password"}
                    value={formData.mews_access_token}
                    onChange={(e) => setFormData({ ...formData, mews_access_token: e.target.value })}
                    placeholder="Enter MEWS Access Token"
                    data-testid="input-mews-access-token"
                  />
                  <Button variant="outline" size="icon" onClick={() => setShowMewsAccessToken(!showMewsAccessToken)}>
                    {showMewsAccessToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            </div>
            
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep(0)} disabled={isSaving}>
                <ChevronLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              <Button onClick={saveMewsSettings} disabled={isSaving} data-testid="button-next-mews">
                {isSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                Continue <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        );
        
      case 2:
        return (
          <div className="space-y-6">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ttlock-email">TTLock Email</Label>
                <Input
                  id="ttlock-email"
                  type="email"
                  value={formData.ttlock_username}
                  onChange={(e) => setFormData({ ...formData, ttlock_username: e.target.value })}
                  placeholder="your-email@hotel.com"
                  data-testid="input-ttlock-email"
                />
                <p className="text-sm text-muted-foreground">Enter your hotel's Authorized Admin credentials - not the lock owner account</p>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="ttlock-password">TTLock Password</Label>
                <div className="flex gap-2">
                  <Input
                    id="ttlock-password"
                    type={showTtlockPassword ? "text" : "password"}
                    value={formData.ttlock_password}
                    onChange={(e) => setFormData({ ...formData, ttlock_password: e.target.value })}
                    placeholder="Your TTLock password"
                    data-testid="input-ttlock-password"
                  />
                  <Button variant="outline" size="icon" onClick={() => setShowTtlockPassword(!showTtlockPassword)}>
                    {showTtlockPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              
              <div className="grid gap-2">
                <Label>Region</Label>
                <Select
                  value={formData.ttlock_region}
                  onValueChange={(value) => setFormData({ ...formData, ttlock_region: value })}
                >
                  <SelectTrigger data-testid="select-ttlock-region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="eu">Europe</SelectItem>
                    <SelectItem value="cn">China</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">Select China if your locks were purchased in Asia</p>
              </div>
            </div>
            
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep(1)} disabled={isSaving}>
                <ChevronLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              <Button onClick={connectTTLock} disabled={isSaving} data-testid="button-connect-ttlock">
                {isSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                Connect & Continue <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        );
        
      case 3:
        return (
          <div className="space-y-6">
            <div className="grid gap-4">
              <Card className="border-2">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <Boxes className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">MEWS Spaces</p>
                        <p className="text-sm text-muted-foreground">
                          {rooms.length > 0 ? `${rooms.length} spaces imported` : "Import rooms from MEWS"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {connectionStatus.spacesSynced && (
                        <Badge variant="default" className="bg-green-600">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Synced
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => syncSpacesMutation.mutate()}
                        disabled={syncSpacesMutation.isPending}
                        data-testid="button-sync-spaces"
                      >
                        <RefreshCw className={`w-4 h-4 mr-2 ${syncSpacesMutation.isPending ? 'animate-spin' : ''}`} />
                        Sync
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
              
              <Card className="border-2">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <Lock className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">TTLock Devices</p>
                        <p className="text-sm text-muted-foreground">
                          {lockDevices.length > 0 ? `${lockDevices.length} locks imported` : "Import locks from TTLock"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {connectionStatus.locksSynced && (
                        <Badge variant="default" className="bg-green-600">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Synced
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => syncLocksMutation.mutate()}
                        disabled={syncLocksMutation.isPending}
                        data-testid="button-sync-locks"
                      >
                        <RefreshCw className={`w-4 h-4 mr-2 ${syncLocksMutation.isPending ? 'animate-spin' : ''}`} />
                        Sync
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep(2)}>
                <ChevronLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              <Button 
                onClick={async () => {
                  const params = new URLSearchParams(searchString);
                  const token = params.get("token");
                  if (token) {
                    try {
                      await useInvitationToken(token);
                    } catch (e) {
                      console.error("Failed to mark invitation as used:", e);
                    }
                  }
                  setCurrentStep(4);
                }} 
                data-testid="button-finish-sync"
              >
                Complete Setup <CheckCircle2 className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        );
        
      case 4:
        return (
          <div className="text-center space-y-6 py-8">
            <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
              <Sparkles className="w-8 h-8 text-green-600" />
            </div>
            
            <div>
              <h2 className="text-2xl font-bold mb-2">Setup Complete!</h2>
              <p className="text-muted-foreground">
                Your property is now configured and ready to use.
              </p>
            </div>
            
            <div className="grid grid-cols-2 gap-4 max-w-md mx-auto text-left">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span>Property settings</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span>MEWS connected</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span>TTLock connected</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span>Data synced</span>
              </div>
            </div>
            
            <div className="pt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Next step: Map your locks to rooms in the Spaces page
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="outline" onClick={() => setLocation("/")}>
                  Go to Dashboard
                </Button>
                <Button onClick={() => setLocation("/spaces")} data-testid="button-go-to-spaces">
                  Map Locks to Rooms <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            </div>
          </div>
        );
        
      default:
        return null;
    }
  };

  if (tokenValidation.isValidating) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center p-8">
          <RefreshCw className="w-12 h-12 mx-auto text-primary animate-spin mb-4" />
          <h2 className="text-xl font-semibold mb-2">Validating Invitation</h2>
          <p className="text-muted-foreground">Please wait while we verify your invitation link...</p>
        </Card>
      </div>
    );
  }

  if (!tokenValidation.isValid) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center p-8">
          <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <XCircle className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Invalid Invitation</h2>
          <p className="text-muted-foreground mb-6">{tokenValidation.error}</p>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              If you believe this is an error, please contact your account manager or request a new invitation.
            </p>
            <Button variant="outline" onClick={() => setLocation("/")}>
              Return to Home
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-full text-sm font-medium mb-4">
            <Sparkles className="w-4 h-4" />
            Quick Setup
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Welcome to DreamBoks</h1>
          <p className="text-muted-foreground">
            Setting up <span className="font-semibold">{tokenValidation.tenantName}</span>
          </p>
        </div>
        
        <div className="mb-8">
          <div className="flex justify-between mb-2">
            {STEPS.map((step, index) => (
              <div
                key={step.id}
                className={`flex flex-col items-center ${index <= currentStep ? 'text-primary' : 'text-muted-foreground'}`}
              >
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors ${
                    index < currentStep
                      ? 'bg-primary border-primary text-primary-foreground'
                      : index === currentStep
                      ? 'border-primary bg-primary/10'
                      : 'border-muted'
                  }`}
                >
                  {index < currentStep ? <CheckCircle2 className="w-5 h-5" /> : step.icon}
                </div>
                <span className="text-xs mt-1 hidden sm:block">{step.title}</span>
              </div>
            ))}
          </div>
          <Progress value={progress} className="h-2" />
        </div>
        
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {STEPS[currentStep].icon}
              {STEPS[currentStep].title}
            </CardTitle>
            <CardDescription>{STEPS[currentStep].description}</CardDescription>
          </CardHeader>
          <CardContent>
            {renderStepContent()}
          </CardContent>
        </Card>
        
        <p className="text-center text-sm text-muted-foreground mt-6">
          Need help? Contact support at support@spaces2spaces.com
        </p>
      </div>
    </div>
  );
}

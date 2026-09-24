import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, Eye, EyeOff, Copy, ExternalLink } from "lucide-react";
import { settingsAPI, fetchAPI } from "@/lib/api";
import { renderDoorCodeTemplate, smsSegmentInfo, DOOR_CODE_TEMPLATE_PLACEHOLDERS, DOOR_CODE_TEMPLATE_SAMPLE_VARS } from "@shared/door-code-template";
import { useToast } from "@/hooks/use-toast";

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showMewsToken, setShowMewsToken] = useState(false);
  const [showMewsClientToken, setShowMewsClientToken] = useState(false);
  const [showTtlockUsername, setShowTtlockUsername] = useState(false);
  const [showTtlockPassword, setShowTtlockPassword] = useState(false);
  const [showTwilioSid, setShowTwilioSid] = useState(false);
  const [showTwilioToken, setShowTwilioToken] = useState(false);
  const [showSendgridKey, setShowSendgridKey] = useState(false);

  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: settingsAPI.getAll,
  });

  const getSettingValue = (key: string) => {
    return settings.find(s => s.key === key)?.value || "";
  };

  const [formValues, setFormValues] = useState({
    mews_environment: "demo",
    mews_client_token: "",
    mews_access_token: "",
    ttlock_username: "",
    ttlock_password: "",
    ttlock_access_token: "",
    ttlock_region: "eu",
    reservation_checkout_time: "11:00",
    late_checkout_max_time: "15:00",
    late_checkout_max_time_with_arrival: "12:00",
    property_timezone: "Europe/Copenhagen",
    pin_activation_time: "14:00",
    check_in_time: "15:00",
    require_id_for_checkin: "false",
    lock_arrival_checkin_enabled: "false",
    lock_arrival_log_only: "false",
    lock_arrival_poll_minutes: "60",
    report_ignored_locks: "",
    boarding_theme_mode: "light",
    boarding_brand_color: "#cc352a",
    boarding_brand_name: "",
    boarding_tagline: "Tap a button to unlock your doors",
    boarding_logo_url: "",
    boarding_pin_requires_checkin: "false",
    pin_checkin_kiosk_qr: "false",
    rating_good_url: "",
    rating_bad_url: "",
    rating_threshold: "4",
    twilio_account_sid: "",
    twilio_auth_token: "",
    twilio_from_number: "",
    twilio_messaging_service_sid: "",
    sendgrid_api_key: "",
    sendgrid_from_email: "",
    boarding_test_email: "",
    boarding_test_phone: "",
    door_code_sms_text: "",
    guest_info_enabled: "false",
    guest_info_domain: "",
    guest_info_token: "",
    guest_info_flights_url: "",
    guest_info_wifi_network: "",
    guest_info_wifi_password: "",
    guest_info_checkin_text: "",
    guest_info_parking_text: "",
    guest_info_facilities_text: "",
    guest_info_rules_text: "",
    guest_info_getting_around_text: "",
    guest_info_contact_text: "",
    guest_info_explore_text: "",
  });

  useEffect(() => {
    if (settings.length > 0) {
      const hasEncryptedValue = (key: string) => {
        const setting = settings.find(s => s.key === key);
        return setting && setting.encrypted && setting.value === "";
      };

      setFormValues({
        mews_environment: getSettingValue("mews_environment") || "demo",
        mews_client_token: hasEncryptedValue("mews_client_token") ? "••••••••••••••••" : getSettingValue("mews_client_token"),
        mews_access_token: hasEncryptedValue("mews_access_token") ? "••••••••••••••••" : getSettingValue("mews_access_token"),
        ttlock_username: hasEncryptedValue("ttlock_username") ? "••••••••••••••••" : getSettingValue("ttlock_username"),
        ttlock_password: hasEncryptedValue("ttlock_password") ? "••••••••••••••••" : getSettingValue("ttlock_password"),
        ttlock_access_token: hasEncryptedValue("ttlock_access_token") ? "••••••••••••••••" : getSettingValue("ttlock_access_token"),
        ttlock_region: getSettingValue("ttlock_region") || "eu",
        reservation_checkout_time: getSettingValue("reservation_checkout_time") || "11:00",
        late_checkout_max_time: getSettingValue("late_checkout_max_time") || "15:00",
        late_checkout_max_time_with_arrival: getSettingValue("late_checkout_max_time_with_arrival") || "12:00",
        property_timezone: getSettingValue("property_timezone") || "Europe/Copenhagen",
        pin_activation_time: getSettingValue("pin_activation_time") || "14:00",
        check_in_time: getSettingValue("check_in_time") || "15:00",
        require_id_for_checkin: getSettingValue("require_id_for_checkin") || "false",
        lock_arrival_checkin_enabled: getSettingValue("lock_arrival_checkin_enabled") || "false",
        lock_arrival_log_only: getSettingValue("lock_arrival_log_only") || "false",
        lock_arrival_poll_minutes: getSettingValue("lock_arrival_poll_minutes") || "60",
        report_ignored_locks: getSettingValue("report_ignored_locks") || "",
        boarding_theme_mode: getSettingValue("boarding_theme_mode") || "light",
        boarding_brand_color: getSettingValue("boarding_brand_color") || "#cc352a",
        boarding_brand_name: getSettingValue("boarding_brand_name") || "",
        boarding_tagline: getSettingValue("boarding_tagline") || "Tap a button to unlock your doors",
        boarding_logo_url: getSettingValue("boarding_logo_url") || "",
        boarding_pin_requires_checkin: getSettingValue("boarding_pin_requires_checkin") || "false",
        pin_checkin_kiosk_qr: getSettingValue("pin_checkin_kiosk_qr") || "false",
        rating_good_url: getSettingValue("rating_good_url") || "",
        rating_bad_url: getSettingValue("rating_bad_url") || "",
        rating_threshold: getSettingValue("rating_threshold") || "4",
        twilio_account_sid: hasEncryptedValue("twilio_account_sid") ? "••••••••••••••••" : getSettingValue("twilio_account_sid"),
        twilio_auth_token: hasEncryptedValue("twilio_auth_token") ? "••••••••••••••••" : getSettingValue("twilio_auth_token"),
        twilio_from_number: getSettingValue("twilio_from_number") || "",
        twilio_messaging_service_sid: getSettingValue("twilio_messaging_service_sid") || "",
        sendgrid_api_key: hasEncryptedValue("sendgrid_api_key") ? "••••••••••••••••" : getSettingValue("sendgrid_api_key"),
        sendgrid_from_email: getSettingValue("sendgrid_from_email") || "",
        boarding_test_email: getSettingValue("boarding_test_email") || "",
        boarding_test_phone: getSettingValue("boarding_test_phone") || "",
        door_code_sms_text: getSettingValue("door_code_sms_text") || "",
        guest_info_enabled: getSettingValue("guest_info_enabled") || "false",
        guest_info_domain: getSettingValue("guest_info_domain") || "",
        guest_info_token: getSettingValue("guest_info_token") || "",
        guest_info_flights_url: getSettingValue("guest_info_flights_url") || "",
        guest_info_wifi_network: getSettingValue("guest_info_wifi_network") || "",
        guest_info_wifi_password: getSettingValue("guest_info_wifi_password") || "",
        guest_info_checkin_text: getSettingValue("guest_info_checkin_text") || "",
        guest_info_parking_text: getSettingValue("guest_info_parking_text") || "",
        guest_info_facilities_text: getSettingValue("guest_info_facilities_text") || "",
        guest_info_rules_text: getSettingValue("guest_info_rules_text") || "",
        guest_info_getting_around_text: getSettingValue("guest_info_getting_around_text") || "",
        guest_info_contact_text: getSettingValue("guest_info_contact_text") || "",
        guest_info_explore_text: getSettingValue("guest_info_explore_text") || "",
      });
    }
  }, [settings]);

  const updateSettingMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      settingsAPI.update(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const handleSave = async () => {
    const updates = [
      { key: "mews_environment", value: formValues.mews_environment },
      { key: "ttlock_region", value: formValues.ttlock_region },
      { key: "reservation_checkout_time", value: formValues.reservation_checkout_time },
      { key: "late_checkout_max_time", value: formValues.late_checkout_max_time },
      { key: "late_checkout_max_time_with_arrival", value: formValues.late_checkout_max_time_with_arrival },
      { key: "property_timezone", value: formValues.property_timezone },
      { key: "pin_activation_time", value: formValues.pin_activation_time },
      { key: "check_in_time", value: formValues.check_in_time },
      { key: "require_id_for_checkin", value: formValues.require_id_for_checkin },
      { key: "lock_arrival_checkin_enabled", value: formValues.lock_arrival_checkin_enabled },
      { key: "lock_arrival_log_only", value: formValues.lock_arrival_log_only },
      { key: "lock_arrival_poll_minutes", value: formValues.lock_arrival_poll_minutes },
      { key: "report_ignored_locks", value: formValues.report_ignored_locks },
      { key: "boarding_theme_mode", value: formValues.boarding_theme_mode },
      { key: "boarding_brand_color", value: formValues.boarding_brand_color },
      { key: "boarding_brand_name", value: formValues.boarding_brand_name },
      { key: "boarding_tagline", value: formValues.boarding_tagline },
      { key: "boarding_logo_url", value: formValues.boarding_logo_url },
      { key: "boarding_pin_requires_checkin", value: formValues.boarding_pin_requires_checkin },
      { key: "pin_checkin_kiosk_qr", value: formValues.pin_checkin_kiosk_qr },
      { key: "rating_good_url", value: formValues.rating_good_url },
      { key: "rating_bad_url", value: formValues.rating_bad_url },
      { key: "rating_threshold", value: formValues.rating_threshold },
      { key: "twilio_from_number", value: formValues.twilio_from_number },
      { key: "twilio_messaging_service_sid", value: formValues.twilio_messaging_service_sid },
      { key: "sendgrid_from_email", value: formValues.sendgrid_from_email },
      { key: "boarding_test_email", value: formValues.boarding_test_email },
      { key: "boarding_test_phone", value: formValues.boarding_test_phone },
      { key: "door_code_sms_text", value: formValues.door_code_sms_text },
      { key: "guest_info_enabled", value: formValues.guest_info_enabled },
      { key: "guest_info_domain", value: formValues.guest_info_domain },
      { key: "guest_info_token", value: formValues.guest_info_token },
      { key: "guest_info_flights_url", value: formValues.guest_info_flights_url },
      { key: "guest_info_wifi_network", value: formValues.guest_info_wifi_network },
      { key: "guest_info_wifi_password", value: formValues.guest_info_wifi_password },
      { key: "guest_info_checkin_text", value: formValues.guest_info_checkin_text },
      { key: "guest_info_parking_text", value: formValues.guest_info_parking_text },
      { key: "guest_info_facilities_text", value: formValues.guest_info_facilities_text },
      { key: "guest_info_rules_text", value: formValues.guest_info_rules_text },
      { key: "guest_info_getting_around_text", value: formValues.guest_info_getting_around_text },
      { key: "guest_info_contact_text", value: formValues.guest_info_contact_text },
      { key: "guest_info_explore_text", value: formValues.guest_info_explore_text },
    ];

    if (formValues.twilio_account_sid && !formValues.twilio_account_sid.includes("•")) {
      updates.push({ key: "twilio_account_sid", value: formValues.twilio_account_sid });
    }
    if (formValues.twilio_auth_token && !formValues.twilio_auth_token.includes("•")) {
      updates.push({ key: "twilio_auth_token", value: formValues.twilio_auth_token });
    }
    if (formValues.sendgrid_api_key && !formValues.sendgrid_api_key.includes("•")) {
      updates.push({ key: "sendgrid_api_key", value: formValues.sendgrid_api_key });
    }
    if (formValues.mews_client_token && !formValues.mews_client_token.includes("•")) {
      updates.push({ key: "mews_client_token", value: formValues.mews_client_token });
    }
    if (formValues.mews_access_token && !formValues.mews_access_token.includes("•")) {
      updates.push({ key: "mews_access_token", value: formValues.mews_access_token });
    }
    if (formValues.ttlock_username && !formValues.ttlock_username.includes("•")) {
      updates.push({ key: "ttlock_username", value: formValues.ttlock_username });
    }
    if (formValues.ttlock_password && !formValues.ttlock_password.includes("•")) {
      updates.push({ key: "ttlock_password", value: formValues.ttlock_password });
    }
    if (formValues.ttlock_access_token && !formValues.ttlock_access_token.includes("•")) {
      updates.push({ key: "ttlock_access_token", value: formValues.ttlock_access_token });
    }

    let successCount = 0;
    let failedFields: string[] = [];

    for (const update of updates) {
      try {
        await updateSettingMutation.mutateAsync(update);
        successCount++;
      } catch (error) {
        failedFields.push(update.key);
      }
    }

    if (failedFields.length === 0) {
      toast({ title: "Settings saved successfully" });
    } else if (successCount > 0) {
      toast({ 
        title: `Partially saved`, 
        description: `Failed to save: ${failedFields.join(", ")}`,
        variant: "destructive" 
      });
    } else {
      toast({ title: "Failed to save settings", variant: "destructive" });
    }
  };

  const handleRefreshToken = async () => {
    try {
      // First save the username and password if they've been changed
      const credentialUpdates = [];
      if (formValues.ttlock_username && !formValues.ttlock_username.includes("•")) {
        credentialUpdates.push({ key: "ttlock_username", value: formValues.ttlock_username });
      }
      if (formValues.ttlock_password && !formValues.ttlock_password.includes("•")) {
        credentialUpdates.push({ key: "ttlock_password", value: formValues.ttlock_password });
      }

      // Save credentials first
      for (const update of credentialUpdates) {
        await updateSettingMutation.mutateAsync(update);
      }

      // Then refresh the token
      let ttlockResponse: any;
      try {
        ttlockResponse = await fetchAPI("/ttlock/refresh-token", { method: "POST" });
      } catch (err: any) {
        toast({
          title: "Failed to connect",
          description: err.message || "Please check your TTLock email and password",
          variant: "destructive" 
        });
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["settings"] });
      
      toast({ 
        title: "TTLock connected successfully",
        description: "Your account is now linked. Go to Spaces to sync your locks."
      });
    } catch (error) {
      toast({ 
        title: "Failed to connect", 
        description: "Network error or server is unavailable",
        variant: "destructive" 
      });
    }
  };

  const isMewsDemo = formValues.mews_environment === "demo";

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Global Settings</h1>
          <p className="text-muted-foreground">
            Configure connection details for MEWS, TTLock, and Notifications.
          </p>
        </div>


        <Card>
          <CardHeader>
            <CardTitle>MEWS PMS Connection</CardTitle>
            <CardDescription>
              Manage your connection to the Property Management System.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="mews-env">Environment</Label>
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Switch 
                    id="mews-env" 
                    checked={isMewsDemo} 
                    onCheckedChange={(checked) => setFormValues({ ...formValues, mews_environment: checked ? "demo" : "production" })}
                  />
                  <Label htmlFor="mews-env">Demo Environment</Label>
                </div>
                <div className="text-[0.8rem] text-muted-foreground pl-1">
                  Active URL: <code className="bg-muted px-1 py-0.5 rounded font-mono text-xs">{isMewsDemo ? "https://app.mews-demo.com/" : "https://app.mews.com/"}</code>
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="client-token">Client Token</Label>
              <div className="flex gap-2">
                <Input 
                  id="client-token" 
                  type={showMewsClientToken ? "text" : "password"} 
                  value={formValues.mews_client_token}
                  onChange={(e) => setFormValues({ ...formValues, mews_client_token: e.target.value })}
                  placeholder={`Enter ${isMewsDemo ? "Demo" : "Production"} Client Token`}
                />
                <Button variant="outline" size="icon" onClick={() => setShowMewsClientToken(!showMewsClientToken)}>
                  {showMewsClientToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="access-token">Access Token</Label>
              <div className="flex gap-2">
                <Input 
                  id="access-token" 
                  type={showMewsToken ? "text" : "password"} 
                  value={formValues.mews_access_token}
                  onChange={(e) => setFormValues({ ...formValues, mews_access_token: e.target.value })}
                  placeholder={`Enter ${isMewsDemo ? "Demo" : "Production"} Access Token`}
                />
                <Button variant="outline" size="icon" onClick={() => setShowMewsToken(!showMewsToken)}>
                  {showMewsToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>TTLock Account</CardTitle>
            <CardDescription>
              Connect your hotel's TTLock Authorized Admin account. Use the credentials for your hotel's admin user - not the lock owner account. You will only see locks your account has access to.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="ttlock-username">TTLock Email</Label>
              <div className="flex gap-2">
                <Input 
                  id="ttlock-username" 
                  type={showTtlockUsername ? "text" : "email"} 
                  value={formValues.ttlock_username}
                  onChange={(e) => setFormValues({ ...formValues, ttlock_username: e.target.value })}
                  placeholder="your-email@hotel.com"
                  data-testid="input-ttlock-username"
                />
                <Button variant="outline" size="icon" onClick={() => setShowTtlockUsername(!showTtlockUsername)} data-testid="button-toggle-ttlock-username">
                  {showTtlockUsername ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-[0.8rem] text-muted-foreground">
                The email you use to log into the TTLock app
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ttlock-password">TTLock Password</Label>
              <div className="flex gap-2">
                <Input 
                  id="ttlock-password" 
                  type={showTtlockPassword ? "text" : "password"} 
                  value={formValues.ttlock_password}
                  onChange={(e) => setFormValues({ ...formValues, ttlock_password: e.target.value })}
                  placeholder="Your TTLock password"
                  data-testid="input-ttlock-password"
                />
                <Button variant="outline" size="icon" onClick={() => setShowTtlockPassword(!showTtlockPassword)} data-testid="button-toggle-ttlock-password">
                  {showTtlockPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button 
                onClick={handleRefreshToken}
                data-testid="button-connect-ttlock"
              >
                Connect TTLock Account
              </Button>
              {formValues.ttlock_access_token && !formValues.ttlock_access_token.includes("Generated") && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  Connected
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="ttlock-region">Region</Label>
              <div className="flex items-center space-x-2">
                <Switch 
                  id="ttlock-region" 
                  checked={formValues.ttlock_region === "eu"} 
                  onCheckedChange={(checked) => setFormValues({ ...formValues, ttlock_region: checked ? "eu" : "cn" })}
                />
                <Label htmlFor="ttlock-region">Europe (EU)</Label>
              </div>
              <p className="text-[0.8rem] text-muted-foreground">
                Select China if your locks were purchased in Asia
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Twilio (SMS & WhatsApp)</CardTitle>
            <CardDescription>
              Connect Twilio to send SMS and WhatsApp messages to guests. Get your credentials from{" "}
              <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">console.twilio.com</a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="twilio-sid">Account SID</Label>
              <div className="flex gap-2">
                <Input 
                  id="twilio-sid" 
                  type={showTwilioSid ? "text" : "password"} 
                  value={formValues.twilio_account_sid}
                  onChange={(e) => setFormValues({ ...formValues, twilio_account_sid: e.target.value })}
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  data-testid="input-twilio-sid"
                />
                <Button variant="outline" size="icon" onClick={() => setShowTwilioSid(!showTwilioSid)} data-testid="button-toggle-twilio-sid">
                  {showTwilioSid ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="twilio-token">Auth Token</Label>
              <div className="flex gap-2">
                <Input 
                  id="twilio-token" 
                  type={showTwilioToken ? "text" : "password"} 
                  value={formValues.twilio_auth_token}
                  onChange={(e) => setFormValues({ ...formValues, twilio_auth_token: e.target.value })}
                  placeholder="Your Twilio Auth Token"
                  data-testid="input-twilio-token"
                />
                <Button variant="outline" size="icon" onClick={() => setShowTwilioToken(!showTwilioToken)} data-testid="button-toggle-twilio-token">
                  {showTwilioToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="twilio-from">SMS Phone Number</Label>
              <Input 
                id="twilio-from" 
                type="tel"
                value={formValues.twilio_from_number}
                onChange={(e) => setFormValues({ ...formValues, twilio_from_number: e.target.value })}
                placeholder="+1234567890"
                data-testid="input-twilio-from"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Your Twilio phone number that sends SMS (with country code)
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="twilio-messaging-service">Messaging Service SID (optional)</Label>
              <Input
                id="twilio-messaging-service"
                type="text"
                value={formValues.twilio_messaging_service_sid}
                onChange={(e) => setFormValues({ ...formValues, twilio_messaging_service_sid: e.target.value })}
                placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                data-testid="input-twilio-messaging-service"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When set, SMS is sent via this Messaging Service instead of the phone number above — lets Twilio show a configured sender name (e.g. "Capsuleinn"). WhatsApp always uses the SMS phone number above.
              </p>
            </div>
            <Separator className="my-4" />
            <div className="grid gap-2">
              <Label htmlFor="test-email">Test Email (redirect all emails here)</Label>
              <Input 
                id="test-email" 
                type="email"
                value={formValues.boarding_test_email}
                onChange={(e) => setFormValues({ ...formValues, boarding_test_email: e.target.value })}
                placeholder="Leave empty to send to real guests"
                data-testid="input-test-email"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When set, ALL emails go to this address instead of the guest. Remove to go live.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="test-phone">Test Phone (redirect all SMS/WhatsApp here)</Label>
              <Input 
                id="test-phone" 
                type="tel"
                value={formValues.boarding_test_phone}
                onChange={(e) => setFormValues({ ...formValues, boarding_test_phone: e.target.value })}
                placeholder="Leave empty to send to real guests"
                data-testid="input-test-phone"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When set, ALL SMS/WhatsApp go to this number instead of the guest. Remove to go live.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SendGrid (Email)</CardTitle>
            <CardDescription>
              Connect SendGrid to send emails to guests. Get your credentials from{" "}
              <a href="https://app.sendgrid.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">app.sendgrid.com</a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="sendgrid-key">API Key</Label>
              <div className="flex gap-2">
                <Input
                  id="sendgrid-key"
                  type={showSendgridKey ? "text" : "password"}
                  value={formValues.sendgrid_api_key}
                  onChange={(e) => setFormValues({ ...formValues, sendgrid_api_key: e.target.value })}
                  placeholder="SG.xxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <Button variant="outline" size="icon" onClick={() => setShowSendgridKey(!showSendgridKey)}>
                  {showSendgridKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sendgrid-from">From Email</Label>
              <Input
                id="sendgrid-from"
                type="email"
                value={formValues.sendgrid_from_email}
                onChange={(e) => setFormValues({ ...formValues, sendgrid_from_email: e.target.value })}
                placeholder="noreply@yourdomain.com"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Must be a verified sender identity or domain in SendGrid
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>PIN Access Settings</CardTitle>
            <CardDescription>
              Configure timing for automatic PIN code activation and guest check-in behavior.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="pin-activation-time">PIN Activation Time</Label>
              <Input 
                id="pin-activation-time" 
                type="time" 
                value={formValues.pin_activation_time}
                onChange={(e) => setFormValues({ ...formValues, pin_activation_time: e.target.value })}
                data-testid="input-pin-activation-time"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When PINs are pushed to locks for today's arrivals (e.g., 14:00 means PINs activate at 2 PM)
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="check-in-time">Guest Check-in Time</Label>
              <Input 
                id="check-in-time" 
                type="time" 
                value={formValues.check_in_time}
                onChange={(e) => setFormValues({ ...formValues, check_in_time: e.target.value })}
                data-testid="input-check-in-time"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Earliest time guests can check in. Using the PIN before this time won't trigger automatic check-in.
              </p>
            </div>
            <Separator className="my-4" />
            <div className="grid gap-2">
              <Label htmlFor="reservation-checkout-time">Check-out Time</Label>
              <Input 
                id="reservation-checkout-time" 
                type="time" 
                value={formValues.reservation_checkout_time}
                onChange={(e) => setFormValues({ ...formValues, reservation_checkout_time: e.target.value })}
                data-testid="input-reservation-checkout-time"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When PINs expire and guests must check out
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="late-checkout-max-time">Late Check-out — Latest Time (no same-day arrival)</Label>
              <Input
                id="late-checkout-max-time"
                type="time"
                value={formValues.late_checkout_max_time}
                onChange={(e) => setFormValues({ ...formValues, late_checkout_max_time: e.target.value })}
                data-testid="input-late-checkout-max-time"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Guests can buy late check-out in hourly steps up to this time when NO new guest arrives on the
                capsule that day. Default 15:00.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="late-checkout-max-arrival">Late Check-out — Latest Time (same-day arrival)</Label>
              <Input
                id="late-checkout-max-arrival"
                type="time"
                value={formValues.late_checkout_max_time_with_arrival}
                onChange={(e) => setFormValues({ ...formValues, late_checkout_max_time_with_arrival: e.target.value })}
                data-testid="input-late-checkout-max-arrival"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Tighter cap used when a new guest arrives on the same capsule that day, so housekeeping keeps a
                window before check-in. Default 12:00.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="property-timezone">Property Timezone</Label>
              <Select
                value={formValues.property_timezone}
                onValueChange={(value) => setFormValues({ ...formValues, property_timezone: value })}
              >
                <SelectTrigger id="property-timezone" data-testid="select-property-timezone">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  <SelectItem value="Europe/Copenhagen">Europe/Copenhagen (DK)</SelectItem>
                  <SelectItem value="Europe/Stockholm">Europe/Stockholm (SE)</SelectItem>
                  <SelectItem value="Europe/Oslo">Europe/Oslo (NO)</SelectItem>
                  <SelectItem value="Europe/Helsinki">Europe/Helsinki (FI)</SelectItem>
                  <SelectItem value="Europe/London">Europe/London (UK)</SelectItem>
                  <SelectItem value="Europe/Paris">Europe/Paris (FR)</SelectItem>
                  <SelectItem value="Europe/Berlin">Europe/Berlin (DE)</SelectItem>
                  <SelectItem value="Europe/Amsterdam">Europe/Amsterdam (NL)</SelectItem>
                  <SelectItem value="Europe/Brussels">Europe/Brussels (BE)</SelectItem>
                  <SelectItem value="Europe/Madrid">Europe/Madrid (ES)</SelectItem>
                  <SelectItem value="Europe/Rome">Europe/Rome (IT)</SelectItem>
                  <SelectItem value="Europe/Vienna">Europe/Vienna (AT)</SelectItem>
                  <SelectItem value="Europe/Zurich">Europe/Zurich (CH)</SelectItem>
                  <SelectItem value="Europe/Prague">Europe/Prague (CZ)</SelectItem>
                  <SelectItem value="Europe/Warsaw">Europe/Warsaw (PL)</SelectItem>
                  <SelectItem value="Europe/Budapest">Europe/Budapest (HU)</SelectItem>
                  <SelectItem value="Europe/Athens">Europe/Athens (GR)</SelectItem>
                  <SelectItem value="Europe/Lisbon">Europe/Lisbon (PT)</SelectItem>
                  <SelectItem value="Europe/Dublin">Europe/Dublin (IE)</SelectItem>
                  <SelectItem value="America/New_York">America/New_York (US East)</SelectItem>
                  <SelectItem value="America/Chicago">America/Chicago (US Central)</SelectItem>
                  <SelectItem value="America/Denver">America/Denver (US Mountain)</SelectItem>
                  <SelectItem value="America/Los_Angeles">America/Los_Angeles (US West)</SelectItem>
                  <SelectItem value="America/Toronto">America/Toronto (CA)</SelectItem>
                  <SelectItem value="Asia/Dubai">Asia/Dubai (UAE)</SelectItem>
                  <SelectItem value="Asia/Singapore">Asia/Singapore (SG)</SelectItem>
                  <SelectItem value="Asia/Tokyo">Asia/Tokyo (JP)</SelectItem>
                  <SelectItem value="Australia/Sydney">Australia/Sydney (AU)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[0.8rem] text-muted-foreground">
                Timezone for PIN validity windows
              </p>
            </div>
            <Separator className="my-4" />
            <div className="grid gap-2">
              <Label>Check-in Method</Label>
              <p className="text-[0.8rem] text-muted-foreground">
                When MEWS status is <strong>Checked-in</strong> (via receptionist, kiosk, or remote unlock on boarding card), access is activated immediately. No configuration needed.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guest Journey</CardTitle>
            <CardDescription>
              Configure what guests must do before receiving their digital key and room access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="require-id-checkin">Require ID Verification Before Digital Key</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    When enabled, guests must have an ID document registered in MEWS before they receive their digital key. 
                    This can be done via your DreamBoks pre-check-in form, MEWS Kiosk, or MEWS Online Check-in.
                  </p>
                  <p className="text-[0.8rem] text-muted-foreground mt-1">
                    When disabled, digital key is sent as soon as payment is verified — no ID check required.
                  </p>
                </div>
                <Switch
                  id="require-id-checkin"
                  checked={formValues.require_id_for_checkin === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, require_id_for_checkin: checked ? "true" : "false" })}
                  data-testid="switch-require-id-checkin"
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="lock-arrival-checkin">Auto Check-in on Keypad Code (Front Door)</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    When enabled, a guest who opens the front/common door using their numeric code (instead of the
                    remote-unlock button on the boarding card) is automatically checked in to MEWS — exactly like the
                    button does. This prevents false no-shows when a guest enters with the code only.
                  </p>
                  <p className="text-[0.8rem] text-muted-foreground mt-1">
                    The front door is polled once per interval (below). Only common-area locks are checked, never
                    individual capsules.
                  </p>
                </div>
                <Switch
                  id="lock-arrival-checkin"
                  checked={formValues.lock_arrival_checkin_enabled === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, lock_arrival_checkin_enabled: checked ? "true" : "false" })}
                  data-testid="switch-lock-arrival-checkin"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="lock-arrival-log-only">Observation Mode (Log Only)</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    When enabled, the system only logs which guests it <em>would</em> check in via their keypad code —
                    it does not write anything to MEWS. Use this for a day to confirm detection works, then turn it off
                    to activate real check-in. Has no effect unless the toggle above is on.
                  </p>
                </div>
                <Switch
                  id="lock-arrival-log-only"
                  checked={formValues.lock_arrival_log_only === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, lock_arrival_log_only: checked ? "true" : "false" })}
                  data-testid="switch-lock-arrival-log-only"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="lock-arrival-poll-minutes">Front Door Poll Interval (minutes)</Label>
              <Input
                id="lock-arrival-poll-minutes"
                type="number"
                min={1}
                value={formValues.lock_arrival_poll_minutes}
                onChange={(e) => setFormValues({ ...formValues, lock_arrival_poll_minutes: e.target.value })}
                data-testid="input-lock-arrival-poll-minutes"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                How often the front door is checked for keypad usage. Default 60. Lower values detect arrivals sooner
                but use more TTLock API calls.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="report-ignored-locks">Hide Locks From Report</Label>
              <Input
                id="report-ignored-locks"
                value={formValues.report_ignored_locks}
                onChange={(e) => setFormValues({ ...formValues, report_ignored_locks: e.target.value })}
                placeholder="e.g. Parking 6, Bike Shed"
                data-testid="input-report-ignored-locks"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Comma-separated lock names muted in the arrival report (missing-code alarms, offline lines and urgent
                escalation). Codes are still pushed to these locks automatically — only the reporting is silenced.
                Leave empty to show everything.
              </p>
            </div>

            <Separator className="my-4" />

            <div className="grid gap-2">
              <Label htmlFor="ta-door-code-sms-text">Door-code SMS text (door-code-message mode)</Label>
              <textarea
                id="ta-door-code-sms-text"
                value={formValues.door_code_sms_text}
                onChange={(e) => setFormValues({ ...formValues, door_code_sms_text: e.target.value })}
                placeholder={"Leave empty for the default: \"Door code for Capsule 602s: 1577#\" + check-in/check-out lines + address"}
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="input-door-code-sms-text"
              />
              {(() => {
                const preview = renderDoorCodeTemplate(formValues.door_code_sms_text, DOOR_CODE_TEMPLATE_SAMPLE_VARS);
                const seg = smsSegmentInfo(preview);
                return (
                  <>
                    <p className={`text-[0.8rem] ${seg.fits ? "text-muted-foreground" : "text-destructive font-medium"}`}>
                      {seg.length} / {seg.limit} characters{seg.unicode ? " (a non-GSM character forces the 70-char unicode limit)" : ""}
                      {seg.fits ? "" : " — this SMS will be billed as more than one segment"}
                    </p>
                    {formValues.door_code_sms_text.trim() && (
                      <p className="text-[0.8rem] rounded-md bg-muted px-3 py-2 whitespace-pre-wrap" data-testid="door-code-sms-preview">{preview}</p>
                    )}
                  </>
                );
              })()}
              <p className="text-[0.8rem] text-muted-foreground">
                Placeholders: {DOOR_CODE_TEMPLATE_PLACEHOLDERS.map((p) => `{${p.key}}`).join(" ")}. The email gets the same text plus the check-in/check-out lines. Changing the text does not re-send to guests who already have their code.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Boarding Card Design</CardTitle>
            <CardDescription>
              Customize the guest boarding card (digital key page) for this property — colors, logo and text.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="pin-checkin-kiosk-qr">Reception check-in shows a QR code</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    For a staffed reception running /&lt;slug&gt;/checkin on a shared iPad: after the guest enters their
                    door code, a QR code is shown for them to scan with their own phone, and the screen resets after
                    15 seconds. The boarding card itself never appears on the shared screen. When disabled, the page
                    jumps straight to the boarding card — right for an unmanned hotel where the guest is on their own phone.
                  </p>
                </div>
                <Switch
                  id="pin-checkin-kiosk-qr"
                  checked={formValues.pin_checkin_kiosk_qr === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, pin_checkin_kiosk_qr: checked ? "true" : "false" })}
                  data-testid="switch-pin-checkin-kiosk-qr"
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="boarding-pin-requires-checkin">Require check-in before showing PIN code</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    When enabled, the numeric PIN code is hidden on the boarding card until the guest is Checked-in in MEWS —
                    the guest must use an unlock button first (which checks them in instantly). Prevents false no-shows and
                    a checked-in capsule being reassigned. When disabled, the PIN is shown immediately.
                  </p>
                </div>
                <Switch
                  id="boarding-pin-requires-checkin"
                  checked={formValues.boarding_pin_requires_checkin === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, boarding_pin_requires_checkin: checked ? "true" : "false" })}
                  data-testid="switch-boarding-pin-requires-checkin"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="boarding-theme-mode">Theme</Label>
              <Select
                value={formValues.boarding_theme_mode}
                onValueChange={(value) => setFormValues({ ...formValues, boarding_theme_mode: value })}
              >
                <SelectTrigger id="boarding-theme-mode" data-testid="select-boarding-theme-mode">
                  <SelectValue placeholder="Select theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="boarding-brand-color">Brand color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={formValues.boarding_brand_color}
                  onChange={(e) => setFormValues({ ...formValues, boarding_brand_color: e.target.value })}
                  className="h-10 w-12 rounded border border-input bg-background p-1 cursor-pointer"
                  data-testid="input-boarding-brand-color-picker"
                />
                <Input
                  id="boarding-brand-color"
                  value={formValues.boarding_brand_color}
                  onChange={(e) => setFormValues({ ...formValues, boarding_brand_color: e.target.value })}
                  placeholder="#45A888"
                  data-testid="input-boarding-brand-color"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="boarding-brand-name">Property name (header)</Label>
              <Input
                id="boarding-brand-name"
                value={formValues.boarding_brand_name}
                onChange={(e) => setFormValues({ ...formValues, boarding_brand_name: e.target.value })}
                placeholder="Copenhagen Downtown"
                data-testid="input-boarding-brand-name"
              />
              <p className="text-[0.8rem] text-muted-foreground">Shown if no logo is set.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="boarding-tagline">Tagline</Label>
              <Input
                id="boarding-tagline"
                value={formValues.boarding_tagline}
                onChange={(e) => setFormValues({ ...formValues, boarding_tagline: e.target.value })}
                placeholder="Tap a button to unlock your doors"
                data-testid="input-boarding-tagline"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="boarding-logo-url">Logo (image URL or data URI)</Label>
              <textarea
                id="boarding-logo-url"
                value={formValues.boarding_logo_url}
                onChange={(e) => setFormValues({ ...formValues, boarding_logo_url: e.target.value })}
                placeholder="https://… or data:image/png;base64,…"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                data-testid="input-boarding-logo-url"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                Shown in the header. Leave empty to show the property name as text. Paste a hosted image URL or a base64 data URI.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guest Info Screen (Kiosk)</CardTitle>
            <CardDescription>
              Content for the wall-mounted guest info tablet at /&lt;hotel-slug&gt;/info. Tiles with empty
              text are hidden. Formatting: blank line = new paragraph, lines starting with "- " become bullets.
              Changes appear on the screen within ~5 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="guest-info-enabled">Enable guest info screen</Label>
                  <p className="text-[0.8rem] text-muted-foreground">
                    When off, the kiosk page returns "not found".
                  </p>
                </div>
                <Switch
                  id="guest-info-enabled"
                  checked={formValues.guest_info_enabled === "true"}
                  onCheckedChange={(checked) => setFormValues({ ...formValues, guest_info_enabled: checked ? "true" : "false" })}
                  data-testid="switch-guest-info-enabled"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="guest-info-domain">Kiosk domain (optional)</Label>
              <Input
                id="guest-info-domain"
                value={formValues.guest_info_domain}
                onChange={(e) => setFormValues({ ...formValues, guest_info_domain: e.target.value })}
                placeholder="infoscreen.example.com"
                data-testid="input-guest-info-domain"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                When this domain points at the app (custom domain in Railway + DNS CNAME), its front page
                redirects straight to the info screen — the tablet only needs the bare domain.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="guest-info-token">Kiosk token (recommended)</Label>
              <div className="flex gap-2">
                <Input
                  id="guest-info-token"
                  value={formValues.guest_info_token}
                  onChange={(e) => setFormValues({ ...formValues, guest_info_token: e.target.value })}
                  placeholder="empty = domain check only"
                  data-testid="input-guest-info-token"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFormValues({ ...formValues, guest_info_token: crypto.randomUUID().replace(/-/g, "") })}
                  data-testid="button-generate-guest-info-token"
                >
                  Generate
                </Button>
              </div>
              <p className="text-[0.8rem] text-muted-foreground">
                When set, the door-code lookup only answers requests that carry this token. Open the info screen once on the
                tablet as <code>/&lt;slug&gt;/info?k=&lt;token&gt;</code> — it remembers the token, so later visits and the
                bare-domain redirect keep working. To rotate, generate a new one, save, and open that link on the tablet again.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="guest-info-flights-url">Flight feed URL (optional)</Label>
              <Input
                id="guest-info-flights-url"
                value={formValues.guest_info_flights_url}
                onChange={(e) => setFormValues({ ...formValues, guest_info_flights_url: e.target.value })}
                placeholder="https://www.example.com/api/flights"
                data-testid="input-guest-info-flights-url"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                JSON feed with departures/arrivals (e.g. the hotel website's /api/flights). When set, the
                kiosk shows a live "Airport" tile. Leave empty to hide it.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="guest-info-wifi-network">WiFi network</Label>
                <Input
                  id="guest-info-wifi-network"
                  value={formValues.guest_info_wifi_network}
                  onChange={(e) => setFormValues({ ...formValues, guest_info_wifi_network: e.target.value })}
                  placeholder="CapsuleInn Guest"
                  data-testid="input-guest-info-wifi-network"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="guest-info-wifi-password">WiFi password</Label>
                <Input
                  id="guest-info-wifi-password"
                  value={formValues.guest_info_wifi_password}
                  onChange={(e) => setFormValues({ ...formValues, guest_info_wifi_password: e.target.value })}
                  placeholder="Shown openly on the kiosk"
                  data-testid="input-guest-info-wifi-password"
                />
              </div>
            </div>
            {([
              { key: "guest_info_checkin_text", label: "Check-in & check-out", placeholder: "How to check in, late check-out, luggage after check-out…" },
              { key: "guest_info_parking_text", label: "Parking", placeholder: "Parking garage, street parking, rates… (\"## Heading\" for subheadings, \"- \" for bullets)" },
              { key: "guest_info_facilities_text", label: "Facilities", placeholder: "Bathrooms, common area, kitchen, luggage storage…" },
              { key: "guest_info_rules_text", label: "House rules", placeholder: "- Quiet hours 22:00–08:00\n- No smoking…" },
              { key: "guest_info_getting_around_text", label: "Getting around", placeholder: "Metro, bus, to/from the airport… (address comes from the Hotel Address setting)" },
              { key: "guest_info_contact_text", label: "Help & contact", placeholder: "Phone/SMS, what to do if your code doesn't work…" },
              { key: "guest_info_explore_text", label: "Explore Copenhagen (optional tile)", placeholder: "Neighbourhood tips — leave empty to hide the tile" },
            ] as const).map((field) => (
              <div className="grid gap-2" key={field.key}>
                <Label htmlFor={`ta-${field.key}`}>{field.label}</Label>
                <textarea
                  id={`ta-${field.key}`}
                  value={formValues[field.key]}
                  onChange={(e) => setFormValues({ ...formValues, [field.key]: e.target.value })}
                  placeholder={field.placeholder}
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid={`input-${field.key.replace(/_/g, "-")}`}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guest Rating & Reviews</CardTitle>
            <CardDescription>
              Configure where guests are redirected after rating their stay. Positive ratings can be directed to your Google Reviews or TripAdvisor page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="rating-threshold">Rating Threshold (Good rating)</Label>
              <Select
                value={formValues.rating_threshold}
                onValueChange={(value) => setFormValues({ ...formValues, rating_threshold: value })}
              >
                <SelectTrigger id="rating-threshold" data-testid="select-rating-threshold">
                  <SelectValue placeholder="Select threshold" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 or higher is good</SelectItem>
                  <SelectItem value="4">4 or higher is good</SelectItem>
                  <SelectItem value="5">Only 5 is good</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[0.8rem] text-muted-foreground">
                Guests rating at or above this value will be redirected to leave a public review
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rating-good-url">Good Rating URL (Google Reviews, TripAdvisor, etc.)</Label>
              <Input 
                id="rating-good-url" 
                type="url"
                placeholder="https://g.page/r/your-hotel/review"
                value={formValues.rating_good_url}
                onChange={(e) => setFormValues({ ...formValues, rating_good_url: e.target.value })}
                data-testid="input-rating-good-url"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                URL where happy guests are redirected (e.g., your Google Reviews or TripAdvisor page)
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rating-bad-url">Low Rating URL (Feedback form)</Label>
              <Input 
                id="rating-bad-url" 
                type="url"
                placeholder="https://your-hotel.com/feedback"
                value={formValues.rating_bad_url}
                onChange={(e) => setFormValues({ ...formValues, rating_bad_url: e.target.value })}
                data-testid="input-rating-bad-url"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                URL where guests with lower ratings are redirected (e.g., internal feedback form)
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button className="gap-2" onClick={handleSave}>
            <Save className="w-4 h-4" />
            Save Configuration
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}

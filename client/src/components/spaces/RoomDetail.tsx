import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Room, mockCommonAreas, mockPins, mockLogs, mockQrCodes } from "@/lib/mockData";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { lockDevicesAPI } from "@/lib/api";
import {
  Info,
  BedDouble,
  DoorOpen,
  Key,
  Settings,
  FileText,
  Plus,
  Trash2,
  Save,
  MoreHorizontal,
  Copy,
  ShieldAlert,
  Search,
  X,
  ChevronDown,
  HelpCircle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { getSpaceDisplayName } from "@shared/display-name";

interface RoomDetailProps {
  room: Room;
  onUpdate: (room: Room) => void;
}

export function RoomDetail({ room, onUpdate }: RoomDetailProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("info");

  // Local state for edits
  const [name, setName] = useState(room.name);
  const [pmsId, setPmsId] = useState(room.pmsId || "");
  const [ttlockId, setTtlockId] = useState(room.ttlockId || "");
  const [ordering, setOrdering] = useState(room.ordering?.toString() || "");
  const [floor, setFloor] = useState(room.floor || "");
  const [label, setLabel] = useState(room.label || "");
  const [isDreamBoks, setIsDreamBoks] = useState(room.isDreamBoks || false);
  const [selectedCommonAreas, setSelectedCommonAreas] = useState<string[]>(room.commonAreas);
  const [searchQuery, setSearchQuery] = useState(room.name.split("-")[0] + "-"); // Pre-fill with prefix
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);

  const { data: lockDevices = [] } = useQuery({
    queryKey: ["lockDevices"],
    queryFn: lockDevicesAPI.getAll,
  });

  const [isAddingBed, setIsAddingBed] = useState(true); // Default to true for mockup

  const roomPins = mockPins.filter(p => p.roomId === room.id);
  const roomLogs = mockLogs.filter(l => l.message.includes(room.name));

  const handleSaveInfo = () => {
    onUpdate({
      ...room,
      name: name,
      pmsId: pmsId,
      ttlockId: ttlockId === "" ? null : ttlockId,
      floor: floor,
      label: label || null,
      ordering: parseInt(ordering) || 0,
      pmsStatus: pmsId ? "mapped" : "unmapped",
      isDreamBoks: isDreamBoks
    });
    setIsEditingName(false);
    toast({
      title: "Room Updated",
      description: "General configuration has been saved successfully.",
    });
  };

  const handleToggleCommonArea = (areaId: string) => {
    if (selectedCommonAreas.includes(areaId)) {
      setSelectedCommonAreas(selectedCommonAreas.filter(id => id !== areaId));
    } else {
      setSelectedCommonAreas([...selectedCommonAreas, areaId]);
    }
  };

  const handleSaveCommonAreas = () => {
    onUpdate({
      ...room,
      commonAreas: selectedCommonAreas
    });
    toast({
      title: "Access Updated",
      description: "Linked common areas have been updated.",
    });
  };

  // Mock matches for the smart connection dropdown
  const mockMatches = [
    { id: "1", label: `${room.name.split("-")[0]}.3 - connected to ${room.name.split("-")[0]}-03` },
    { id: "2", label: `${room.name.split("-")[0]}.2 - connected to ${room.name.split("-")[0]}-02` },
    { id: "3", label: `${room.name.split("-")[0]}.8 - connected to ${room.name.split("-")[0]}-08` },
    { id: "4", label: `${room.name.split("-")[0]}.6 - connected to ${room.name.split("-")[0]}-06` },
    { id: "5", label: `${room.name.split("-")[0]}.5 - connected to ${room.name.split("-")[0]}-05` },
  ];

  const mockDeletedPMS = [
      "312.3 (deleted)",
      "313.4 (deleted)",
      "113.8 (deleted)",
      "212.2 (deleted)",
      "113.4 (deleted)",
      "412.4 (deleted)"
  ];

  return (
    <div className="h-full flex flex-col bg-background rounded-xl border shadow-sm overflow-hidden">
      {/* Header Section */}
      <div className="px-8 pt-8 pb-4">
        <div className="flex items-start justify-between mb-4">
          <div className="space-y-1">
            {isEditingName ? (
                <div className="flex items-center gap-2">
                    <Input 
                        value={name} 
                        onChange={(e) => setName(e.target.value)} 
                        className="text-3xl font-bold tracking-tight h-10 w-[200px]"
                        autoFocus
                    />
                    <Button size="sm" onClick={handleSaveInfo}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setIsEditingName(false)}>Cancel</Button>
                </div>
            ) : (
                <div className="flex items-center gap-2 group">
                    <h2 className="text-3xl font-bold tracking-tight text-foreground leading-none">
                    {getSpaceDisplayName(name, label)}
                    </h2>
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setIsEditingName(true)}
                    >
                        <FileText className="w-4 h-4 text-muted-foreground" />
                    </Button>
                </div>
            )}
            <div className="inline-flex items-center justify-center px-1.5 py-0.5 border rounded-[4px] text-[11px] font-medium text-foreground bg-white shadow-sm min-w-[24px] h-5">
               {room.pmsId || room.name}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="px-3 py-1.5 text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 gap-2 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-primary"></span>
              Good
              <ChevronDown className="w-3 h-3 text-primary ml-1" />
            </Badge>
            <Button variant="outline" size="icon" className="h-9 w-9 bg-white">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs Section */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-8 border-b">
          <TabsList className="bg-transparent p-0 h-auto gap-8">
            <TabsTrigger 
              value="info"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              Info
            </TabsTrigger>
            <TabsTrigger 
              value="beds"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all gap-2"
            >
              Beds
              <span className="bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded text-xs font-bold">
                  {room.beds}
              </span>
            </TabsTrigger>
            <TabsTrigger 
              value="common"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              Common Area
            </TabsTrigger>
            <TabsTrigger 
              value="ekeys"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              eKeys
            </TabsTrigger>
            <TabsTrigger 
              value="passcodes"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              Passcodes
            </TabsTrigger>
             <TabsTrigger 
              value="cards"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              Cards
            </TabsTrigger>
            <TabsTrigger 
              value="qr"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              QR code
            </TabsTrigger>
             <TabsTrigger 
              value="records"
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all"
            >
              Records
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 overflow-y-auto p-8 bg-white">
          {/* INFO TAB */}
          <TabsContent value="info" className="mt-0 space-y-8 max-w-4xl">
             <div className="text-muted-foreground leading-relaxed">
                You can map your room to the PMS room or create beds and connect them to the PMS one by one.
             </div>

             <div className="space-y-6">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <Label htmlFor="floor" className="text-muted-foreground font-normal">Floor (Optional)</Label>
                    <Input
                        id="floor"
                        value={floor}
                        onChange={(e) => setFloor(e.target.value)}
                        className="max-w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="label" className="text-muted-foreground font-normal flex items-center gap-1">
                        Label (Optional)
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60" />
                    </Label>
                    <Input
                        id="label"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="e.g. Room, Bed, Front"
                        className="max-w-full"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="ordering" className="text-muted-foreground font-normal flex items-center gap-1">
                        Ordering (Optional)
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60" />
                    </Label>
                    <Input
                        id="ordering"
                        value={ordering}
                        onChange={(e) => setOrdering(e.target.value)}
                        className="max-w-full"
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="pms-id" className="text-muted-foreground font-normal">PMS ID (Optional)</Label>
                    <div className="relative">
                        <Input 
                            id="pms-id" 
                            value={pmsId} 
                            onChange={(e) => setPmsId(e.target.value)} 
                            className="pr-8 border-primary ring-1 ring-primary"
                        />
                         <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                         </div>
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="ttlock-device" className="text-muted-foreground font-normal">TTLock Device (Optional)</Label>
                    <Select value={ttlockId || "none"} onValueChange={(value) => setTtlockId(value === "none" ? "" : value)}>
                      <SelectTrigger id="ttlock-device" data-testid="select-ttlock-device">
                        <SelectValue placeholder="Select TTLock device" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No lock</SelectItem>
                        {lockDevices
                          .filter(device => device.lockType === "room")
                          .map(device => (
                            <SelectItem key={device.id} value={device.ttlockId} data-testid={`option-ttlock-${device.ttlockId}`}>
                              {device.name} ({device.mac})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                </div>

                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox 
                    id="is-dreamboks" 
                    checked={isDreamBoks} 
                    onCheckedChange={(checked) => setIsDreamBoks(checked === true)}
                  />
                  <Label htmlFor="is-dreamboks" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    DreamBoks Unit
                  </Label>
                </div>
             </div>

             <div className="pt-8 mt-8 border-t flex justify-end">
                <Button onClick={handleSaveInfo} className="gap-2">
                  <Save className="w-4 h-4" />
                  Save Changes
                </Button>
             </div>

             <div className="pt-4">
                <p className="text-muted-foreground text-sm max-w-xl leading-relaxed">
                  Goki will detect room locks and your room/bed configuration automatically and generates PIN/Key at check-in time.
                </p>
             </div>
          </TabsContent>

          {/* BEDS TAB */}
          <TabsContent value="beds" className="mt-0 space-y-6 max-w-4xl">
            
            <div className="flex items-center justify-between">
                 <h3 className="text-lg font-medium text-muted-foreground">Add more beds</h3>
                 {!isAddingBed && (
                    <Button onClick={() => setIsAddingBed(true)} className="bg-primary hover:bg-primary/90 text-white">
                        Create
                    </Button>
                 )}
                 {isAddingBed && (
                     <Button className="bg-primary hover:bg-primary/90 text-white w-[100px]">
                         Create
                     </Button>
                 )}
            </div>

            {isAddingBed && (
                <div className="flex items-center gap-4 p-4 border rounded-lg shadow-sm bg-white">
                    <div className="w-32">
                        <Input defaultValue="bed 1" className="bg-white" />
                    </div>
                    
                    <div className="flex-1 relative">
                        <div className="relative">
                            <Input defaultValue="Search for PMS" className="pr-8 text-muted-foreground" />
                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                <span className="text-xs">^</span>
                            </div>
                        </div>
                        
                        {/* Dropdown simulation */}
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-xl z-50 max-h-[240px] overflow-y-auto">
                            {mockDeletedPMS.map((item, i) => (
                                <div key={i} className="px-4 py-2.5 text-sm hover:bg-gray-50 cursor-pointer text-gray-700">
                                    {item}
                                </div>
                            ))}
                        </div>
                    </div>
                    
                    <Button variant="ghost" onClick={() => setIsAddingBed(false)}>
                        Close
                    </Button>
                </div>
            )}

          </TabsContent>


          <TabsContent value="common" className="mt-0 space-y-6 max-w-4xl">
             <Card>
              <CardHeader>
                <CardTitle>Linked Common Areas</CardTitle>
                <CardDescription>Select which common doors this room's PIN should open.</CardDescription>
              </CardHeader>
              <CardContent>
                 <div className="space-y-1">
                   {mockCommonAreas.map(area => (
                     <div key={area.id} className="flex items-center space-x-3 p-3 hover:bg-muted/50 rounded-lg transition-colors">
                       <Checkbox 
                         id={area.id} 
                         checked={selectedCommonAreas.includes(area.id)} 
                         onCheckedChange={() => handleToggleCommonArea(area.id)}
                       />
                       <div className="grid gap-1.5 leading-none">
                         <Label htmlFor={area.id} className="font-medium cursor-pointer">
                           {area.name}
                         </Label>
                         <p className="text-xs text-muted-foreground">
                           Battery: {area.battery}%
                         </p>
                       </div>
                       {selectedCommonAreas.includes(area.id) && (
                         <Badge variant="secondary" className="ml-auto text-[10px]">All Days</Badge>
                       )}
                     </div>
                   ))}
                 </div>
                 <div className="mt-6 pt-4 border-t flex justify-end">
                   <Button className="gap-2" onClick={handleSaveCommonAreas}>
                     <Save className="w-4 h-4" />
                     Update Access
                   </Button>
                 </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* EKEYS TAB (New) */}
          <TabsContent value="ekeys" className="mt-0 space-y-6 max-w-4xl">
            <Card>
               <CardHeader className="flex flex-row items-center justify-between">
                 <div>
                    <CardTitle>eKeys</CardTitle>
                    <CardDescription>Manage digital keys sent to users</CardDescription>
                 </div>
                 <div className="flex gap-2">
                    <Input placeholder="Enter name or account" className="w-[200px]" />
                    <Button variant="outline">Send eKey</Button>
                 </div>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md">
                      <div className="grid grid-cols-6 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-1">Name</div>
                          <div className="col-span-1">Recipient Account</div>
                          <div className="col-span-1">Assigner</div>
                          <div className="col-span-1">Assigning Time</div>
                          <div className="col-span-1">Validity Period</div>
                          <div className="col-span-1 text-right">Unlock link</div>
                      </div>
                      <div className="p-8 text-center text-muted-foreground text-sm">
                          No eKeys found
                      </div>
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="passcodes" className="mt-0 space-y-6 max-w-4xl">
             {/* ... (PINs content from previous implementation) ... */}
             <div className="flex items-center gap-3 p-4 bg-secondary/30 text-secondary-foreground border border-secondary rounded-lg text-sm">
              <Info className="w-5 h-5 shrink-0 text-primary" />
              <p>Guest Passcodes are generated automatically from MEWS reservations. Create manual Passcodes for staff or temporary access.</p>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-lg">Active Passcodes</h3>
                <Button size="sm" className="gap-2" onClick={() => toast({ title: "Create Passcode", description: "Manual Passcode creation modal would open here." })}>
                  <Plus className="w-4 h-4" />
                  New Manual Passcode
                </Button>
              </div>

              <div className="grid gap-3">
                {roomPins.map(pin => (
                  <div key={pin.id} className="flex items-center justify-between p-4 bg-card border rounded-xl shadow-sm">
                    <div className="flex items-start gap-4">
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center",
                        pin.type === 'guest' ? "bg-secondary text-primary" : 
                        pin.type === 'cleaner' ? "bg-primary/10 text-primary" :
                        "bg-gray-100 text-gray-600"
                      )}>
                        {pin.type === 'guest' ? <Key className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{pin.name}</span>
                          {(() => {
                            const isUsed = (pin.status as string) === 'used';
                            const isExpired = !isUsed && new Date(pin.validTo) < new Date();
                            const isActive = pin.status === 'active';
                            const isError = pin.status === 'error';
                            
                            return (
                              <Badge 
                                variant={isUsed ? 'default' : isExpired ? 'destructive' : isActive ? 'secondary' : isError ? 'destructive' : 'outline'} 
                                className={`uppercase text-[10px] ${isUsed ? 'bg-green-500 text-white' : isExpired ? 'bg-red-500 text-white' : isActive ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : ''}`}
                              >
                                {isUsed ? 'used' : isExpired ? 'expired' : pin.status}
                              </Badge>
                            );
                          })()}
                        </div>
                        <div className="text-sm text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{pin.code}</span>
                          <span>•</span>
                          <span>{format(new Date(pin.validFrom), "MMM d, HH:mm")} - {format(new Date(pin.validTo), "MMM d, HH:mm")}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm">Details</Button>
                      {pin.type !== 'guest' && (
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              {roomPins.length === 0 && (
                <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl">
                  No active Passcodes for this room.
                </div>
              )}
            </div>
          </TabsContent>
          

          {/* CARDS TAB (New) */}
          <TabsContent value="cards" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader className="flex flex-row items-center justify-between">
                 <div>
                    <CardTitle>IC Cards</CardTitle>
                    <CardDescription>Manage physical access cards</CardDescription>
                 </div>
                 <Button variant="outline">Add Card</Button>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md">
                      <div className="grid grid-cols-4 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-1">Card Number</div>
                          <div className="col-span-1">Name</div>
                          <div className="col-span-1">Validity</div>
                          <div className="col-span-1 text-right">Action</div>
                      </div>
                      <div className="p-8 text-center text-muted-foreground text-sm">
                          No cards registered
                      </div>
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          {/* QR CODE TAB (New) */}
          <TabsContent value="qr" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader className="flex flex-row items-center justify-between pb-2">
                 <div className="flex items-center gap-2 w-full">
                    <div className="relative flex-1 max-w-md">
                        <Input placeholder="Please enter the name" className="pr-8" />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                            <Search className="w-4 h-4 text-muted-foreground" />
                        </div>
                    </div>
                 </div>
                 <div className="flex gap-2 shrink-0">
                    <Button variant="outline" className="text-primary hover:text-primary border-primary/20 hover:bg-primary/5">Add QR code</Button>
                    <Button variant="outline" className="text-destructive hover:text-destructive border-destructive/20 hover:bg-destructive/5">Clear</Button>
                 </div>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md overflow-hidden">
                      <div className="grid grid-cols-12 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-2">Name</div>
                          <div className="col-span-2">Assigner</div>
                          <div className="col-span-3">Assigning Time</div>
                          <div className="col-span-2">Validity Period</div>
                          <div className="col-span-1">Status</div>
                          <div className="col-span-2">Operation</div>
                      </div>
                      
                      {mockQrCodes.length > 0 ? (
                        <div className="divide-y">
                            {mockQrCodes.map(qr => (
                                <div key={qr.id} className="grid grid-cols-12 p-4 text-sm items-center hover:bg-muted/20 transition-colors">
                                    <div className="col-span-2 font-medium">{qr.name}</div>
                                    <div className="col-span-2 text-muted-foreground">{qr.assigner}</div>
                                    <div className="col-span-3 text-muted-foreground">{qr.assigningTime}</div>
                                    <div className="col-span-2 text-muted-foreground">{qr.validityPeriod}</div>
                                    <div className="col-span-1 text-muted-foreground">{qr.status}</div>
                                    <div className="col-span-2 flex flex-col gap-1 text-xs">
                                        <div className="flex gap-3">
                                            <button className="text-primary hover:underline">Copy link</button>
                                            <button className="text-primary hover:underline">Edit</button>
                                            <button className="text-primary hover:underline">More</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                      ) : (
                        <div className="p-8 text-center text-muted-foreground text-sm">
                            No QR codes active
                        </div>
                      )}
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="records" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader>
                 <CardTitle>Records</CardTitle>
                 <CardDescription>Unlock records and activity logs</CardDescription>
               </CardHeader>
               <CardContent>
                 <ScrollArea className="h-[400px] pr-4">
                   <div className="space-y-4">
                     {roomLogs.length > 0 ? roomLogs.map(log => (
                       <div key={log.id} className="flex gap-3 text-sm">
                         <div className="font-mono text-xs text-muted-foreground w-32 shrink-0">
                           {format(new Date(log.timestamp), "MMM d, HH:mm:ss")}
                         </div>
                         <div className="flex-1">
                           <p>{log.message}</p>
                           <p className="text-xs text-muted-foreground mt-0.5">Source: {log.source}</p>
                         </div>
                       </div>
                     )) : (
                       <p className="text-sm text-muted-foreground">No records found for this room.</p>
                     )}
                   </div>
                 </ScrollArea>
               </CardContent>
             </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

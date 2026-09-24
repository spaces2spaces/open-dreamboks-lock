import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, Loader2, ArrowRight, AlertCircle, Link as LinkIcon, RefreshCw } from "lucide-react";
import { mockLockDevices, mockRooms, mockCommonAreas } from "@/lib/mockData";

interface ImportConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "importing" | "mapping" | "completed";

export function ImportConnectModal({ open, onOpenChange }: ImportConnectModalProps) {
  const [step, setStep] = useState<Step>("importing");
  const [importProgress, setImportProgress] = useState(0);
  
  // Demo state for mapping
  const [unmappedItems, setUnmappedItems] = useState([
    { id: "m-205", type: "Room", name: "205", mewsId: "mews-205", suggestedLock: "l-205" },
    { id: "m-kitchen", type: "Common Area", name: "Staff Kitchen", mewsId: "mews-kitchen", suggestedLock: "l-kitchen" },
    { id: "m-new", type: "Room", name: "301 (New)", mewsId: "mews-301", suggestedLock: null }
  ]);

  // Reset when opening
  useEffect(() => {
    if (open) {
      setStep("importing");
      setImportProgress(0);
      
      // Simulate import process
      const interval = setInterval(() => {
        setImportProgress(prev => {
          if (prev >= 100) {
            clearInterval(interval);
            setStep("mapping");
            return 100;
          }
          return prev + 20;
        });
      }, 500);
      
      return () => clearInterval(interval);
    }
  }, [open]);

  const handleConfirmMapping = () => {
    setStep("completed");
  };

  const handleFinish = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden bg-white">
        <div className="p-6 pb-2">
          <DialogHeader>
            <DialogTitle className="text-xl">Import & Connect</DialogTitle>
            <DialogDescription>
              Syncing Spaces from MEWS and Locks from TTLock.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Step 1: Importing */}
        {step === "importing" && (
          <div className="p-12 flex flex-col items-center justify-center text-center space-y-6">
            <div className="relative">
               <RefreshCw className="w-12 h-12 text-primary animate-spin" />
               <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary">
                 {importProgress}%
               </div>
            </div>
            <div className="space-y-1">
              <h3 className="font-medium text-lg">Fetching data...</h3>
              <p className="text-muted-foreground text-sm">Connecting to MEWS API and TTLock Cloud</p>
            </div>
            <div className="w-full max-w-xs bg-muted rounded-full h-2 overflow-hidden">
               <div className="bg-primary h-full transition-all duration-300 ease-out" style={{ width: `${importProgress}%` }} />
            </div>
          </div>
        )}

        {/* Step 2: Mapping */}
        {step === "mapping" && (
          <div className="flex flex-col h-[500px]">
             <div className="px-6 py-4 bg-secondary/30 border-y border-secondary flex items-start gap-3">
               <AlertCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
               <div className="text-sm text-foreground">
                 <p className="font-medium">Found 3 unmapped spaces</p>
                 <p className="opacity-90 mt-1">The system has detected new spaces in MEWS. Please confirm the matching TTLock devices below.</p>
               </div>
             </div>

             <ScrollArea className="flex-1 p-6">
               <div className="space-y-6">
                  {unmappedItems.map((item) => (
                    <div key={item.id} className="border rounded-xl p-4 shadow-sm bg-card">
                       <div className="flex items-center gap-3 mb-4">
                          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground">
                             {item.type === 'Room' ? 'R' : 'C'}
                          </div>
                          <div>
                             <h4 className="font-bold text-base">{item.name}</h4>
                             <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">MEWS: {item.mewsId}</Badge>
                                <ArrowRight className="w-3 h-3" />
                                <Badge variant="outline" className="bg-secondary/20 text-primary border-secondary">Unmapped</Badge>
                             </div>
                          </div>
                       </div>

                       <div className="flex items-center gap-3 bg-muted/30 p-3 rounded-lg border border-dashed border-muted-foreground/20">
                          <LinkIcon className="w-4 h-4 text-primary" />
                          <div className="flex-1">
                             <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                               Map to TTLock Device
                             </label>
                             <Select defaultValue={item.suggestedLock || ""}>
                                <SelectTrigger className="h-9 bg-white w-full">
                                   <SelectValue placeholder="Select a lock..." />
                                </SelectTrigger>
                                <SelectContent>
                                   <SelectItem value="l-205">Lock 205 (Suggested)</SelectItem>
                                   <SelectItem value="l-kitchen">Lock Staff Kitchen (Suggested)</SelectItem>
                                   <SelectItem value="l-unused-1">Lock 301 (Unused)</SelectItem>
                                   <SelectItem value="l-unused-2">Lock 302 (Unused)</SelectItem>
                                   <SelectItem value="none">No Lock (Virtual Space)</SelectItem>
                                </SelectContent>
                             </Select>
                          </div>
                          {item.suggestedLock && (
                             <Badge className="bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 h-6 mt-6">
                                Auto-match
                             </Badge>
                          )}
                       </div>
                    </div>
                  ))}
               </div>
             </ScrollArea>

             <div className="p-4 border-t bg-muted/10 flex justify-between items-center">
                <p className="text-xs text-muted-foreground">3 items to be updated</p>
                <div className="flex gap-2">
                   <Button variant="outline" onClick={handleFinish}>Cancel</Button>
                   <Button onClick={handleConfirmMapping} className="bg-primary hover:bg-primary/90">
                      Confirm Mapping
                   </Button>
                </div>
             </div>
          </div>
        )}

        {/* Step 3: Completed */}
        {step === "completed" && (
           <div className="p-12 flex flex-col items-center justify-center text-center space-y-6 h-[400px]">
              <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-2">
                 <Check className="w-8 h-8" />
              </div>
              <div className="space-y-2">
                <h3 className="font-bold text-2xl text-foreground">Sync Complete</h3>
                <p className="text-muted-foreground max-w-[300px] mx-auto">
                   All spaces and locks are now synchronized. The system will automatically generate PINs for new reservations.
                </p>
              </div>
              
              <div className="grid grid-cols-2 gap-4 w-full max-w-xs mt-6">
                 <div className="bg-muted/30 p-3 rounded-lg text-center">
                    <div className="text-2xl font-bold">12</div>
                    <div className="text-xs text-muted-foreground uppercase font-medium tracking-wider">Rooms</div>
                 </div>
                 <div className="bg-muted/30 p-3 rounded-lg text-center">
                    <div className="text-2xl font-bold">5</div>
                    <div className="text-xs text-muted-foreground uppercase font-medium tracking-wider">Common</div>
                 </div>
              </div>

              <Button size="lg" className="w-full max-w-xs mt-8" onClick={handleFinish}>
                 Done
              </Button>
           </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

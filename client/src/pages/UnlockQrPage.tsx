import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Lock, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { useSearch } from "wouter";

export default function UnlockQrPage() {
  const searchString = useSearch();
  const [status, setStatus] = useState<"loading" | "success" | "error" | "invalid">("loading");
  const [message, setMessage] = useState("Unlocking door...");
  const [lockName, setLockName] = useState<string | null>(null);

  useEffect(() => {
    document.title = "DreamBoks - Unlocking";
    
    console.log("[UnlockQrPage] searchString:", searchString);
    console.log("[UnlockQrPage] window.location:", window.location.href);
    
    const params = new URLSearchParams(searchString);
    const reservationNumber = params.get("r");
    const lastName = params.get("l");
    const lockId = params.get("lock");

    console.log("[UnlockQrPage] Parsed params:", { reservationNumber, lastName, lockId });

    if (!reservationNumber || !lastName || !lockId) {
      console.log("[UnlockQrPage] Missing params - showing invalid state");
      setStatus("invalid");
      setMessage("Invalid QR code. Please use the digital key app.");
      return;
    }

    performUnlock(reservationNumber, lastName, lockId, params.get("p") || undefined);
  }, [searchString]);

  const performUnlock = async (reservationNumber: string, lastName: string, lockId: string, pin?: string) => {
    console.log("[UnlockQrPage] Performing unlock:", { reservationNumber, lastName, lockId });
    try {
      const response = await fetch("/api/public/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber, lastName, lockId, pin }),
      });

      console.log("[UnlockQrPage] Response status:", response.status);
      const data = await response.json();
      console.log("[UnlockQrPage] Response data:", data);

      if (!response.ok) {
        console.log("[UnlockQrPage] Error response:", data.error);
        setStatus("error");
        setMessage(data.error || "Failed to unlock door");
        return;
      }

      console.log("[UnlockQrPage] Unlock successful!");
      setStatus("success");
      setLockName(data.lockName || "Door");
      setMessage("Door unlocked successfully!");
      
      if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
      }
    } catch (error) {
      console.error("[UnlockQrPage] Fetch error:", error);
      setStatus("error");
      setMessage("Connection error. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#c8d5e9] to-white flex items-center justify-center p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardContent className="p-8">
          <div className="flex flex-col items-center text-center">
            {status === "loading" && (
              <>
                <div className="w-24 h-24 rounded-full bg-blue-100 flex items-center justify-center mb-6">
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
                </div>
                <h1 className="text-xl font-bold text-[#232321] mb-2">Unlocking...</h1>
                <p className="text-muted-foreground">Please wait</p>
              </>
            )}

            {status === "success" && (
              <>
                <div className="w-24 h-24 rounded-full bg-green-100 flex items-center justify-center mb-6 animate-pulse">
                  <CheckCircle2 className="w-12 h-12 text-green-600" />
                </div>
                <h1 className="text-xl font-bold text-green-700 mb-2">Unlocked!</h1>
                <p className="text-muted-foreground">{lockName || "Door"} is now open</p>
                <p className="text-sm text-muted-foreground mt-4">You can close this page</p>
              </>
            )}

            {status === "error" && (
              <>
                <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center mb-6">
                  <XCircle className="w-12 h-12 text-red-600" />
                </div>
                <h1 className="text-xl font-bold text-red-700 mb-2">Unlock Failed</h1>
                <p className="text-muted-foreground">{message}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-6 px-6 py-2 bg-[#cc352a] text-white rounded-full hover:bg-[#a82b22] transition-colors"
                >
                  Try Again
                </button>
              </>
            )}

            {status === "invalid" && (
              <>
                <div className="w-24 h-24 rounded-full bg-amber-100 flex items-center justify-center mb-6">
                  <AlertTriangle className="w-12 h-12 text-amber-600" />
                </div>
                <h1 className="text-xl font-bold text-amber-700 mb-2">Invalid Link</h1>
                <p className="text-muted-foreground">{message}</p>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

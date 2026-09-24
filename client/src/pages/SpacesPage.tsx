import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { roomsAPI } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";

export default function SpacesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");

  const { data: rooms = [], isLoading: roomsLoading } = useQuery({
    queryKey: ["rooms"],
    queryFn: roomsAPI.getAll,
  });

  const syncSpacesMutation = useMutation({
    mutationFn: roomsAPI.sync,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast({
        title: "MEWS spaces synchronized",
        description: `${data.imported} imported, ${data.updated} updated (${data.total} total)`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to sync MEWS spaces",
        description: error.message || "Check MEWS credentials in Settings",
        variant: "destructive",
      });
    },
  });

  const filteredRooms = rooms
    .filter((r) => r.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Spaces</h1>
          <p className="text-muted-foreground">
            {rooms.length} spaces synkroniseret fra MEWS
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => syncSpacesMutation.mutate()}
          disabled={syncSpacesMutation.isPending}
          data-testid="button-sync-spaces"
        >
          <RefreshCw className="w-4 h-4" />
          {syncSpacesMutation.isPending ? "Syncing..." : "Sync Spaces"}
        </Button>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="mb-4">
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Search className="w-4 h-4" />
              </div>
              <Input
                placeholder="Søg efter spaces..."
                className="pl-9 bg-white border-gray-200"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                data-testid="input-search-spaces"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
            {roomsLoading ? (
              <div className="col-span-full text-center text-muted-foreground py-8">
                Loading spaces...
              </div>
            ) : filteredRooms.length === 0 ? (
              <div className="col-span-full text-center text-muted-foreground py-8">
                Ingen spaces fundet
              </div>
            ) : (
              filteredRooms.map((room) => (
                <div
                  key={room.id}
                  className="flex items-center px-3 py-2 border rounded-md bg-white hover:bg-muted/20 transition-colors"
                  data-testid={`room-item-${room.id}`}
                >
                  <span className="text-sm font-semibold">{room.name}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </DashboardLayout>
  );
}

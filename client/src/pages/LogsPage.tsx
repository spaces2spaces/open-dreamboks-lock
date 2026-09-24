import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useQuery } from "@tanstack/react-query";
import { fetchAPI } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";

export default function LogsPage() {
  const { data: logs = [], isLoading, isError } = useQuery({
    queryKey: ["logs"],
    queryFn: () => fetchAPI("/logs?limit=100"),
    refetchInterval: 10000,
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Logs</h1>
          <p className="text-muted-foreground">
            Monitor all integration events, errors, and access attempts.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {isError ? (
              <div className="text-center py-8 text-destructive">Failed to load logs. Please try again.</div>
            ) : isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading logs...</div>
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No logs found</div>
            ) : (
              <ScrollArea className="h-[600px]">
                <div className="space-y-4">
                  {logs.map((log: any) => (
                  <div
                    key={log.id}
                    className="flex items-start gap-4 p-4 border rounded-lg bg-card hover:bg-muted/20 transition-colors"
                  >
                    <div className="font-mono text-xs text-muted-foreground w-36 shrink-0 pt-1">
                      {format(new Date(log.timestamp), "MMM d, yyyy HH:mm:ss")}
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            log.level === "error"
                              ? "destructive"
                              : log.level === "warning"
                              ? "secondary"
                              : "outline"
                          }
                          className="uppercase text-[10px]"
                        >
                          {log.level}
                        </Badge>
                        <span className="font-medium text-sm">{log.source}</span>
                      </div>
                      <p className="text-sm">{log.message}</p>
                    </div>
                  </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

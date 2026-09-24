import { Room } from "@/lib/mockData";
import { Battery, Bed, Cloud, CloudOff, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSpaceDisplayName } from "@shared/display-name";

interface RoomCardProps {
  room: Room;
  isSelected: boolean;
  onClick: () => void;
}

export function RoomCard({ room, isSelected, onClick }: RoomCardProps) {
  const getBatteryLabel = (level: number) => {
    if (level > 80) return "Full battery";
    if (level > 50) return "Good battery";
    if (level > 20) return "Low battery";
    return "Critical battery";
  };

  const getFloorColor = (roomName: string) => {
    // All floor indicators should be red as per design request
    return "bg-primary";
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative p-4 rounded-xl border transition-all cursor-pointer hover:shadow-md bg-card",
        isSelected
          ? "border-l-4 border-l-primary border-r-transparent border-t-transparent border-b-transparent"
          : "border-transparent hover:border-border"
      )}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-sm",
            getFloorColor(room.name)
          )}
        >
          {room.floor || "1"}
        </div>
        <div className="flex flex-col">
          <h3 className="font-bold text-lg text-foreground leading-none">{getSpaceDisplayName(room.name, room.label)}</h3>
          {room.isDreamBoks && (
             <span className="text-[10px] font-medium text-primary mt-1 bg-primary/10 px-1.5 py-0.5 rounded-sm w-fit">DreamBoks</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 bg-muted/30 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground">
          <Bed className="w-3.5 h-3.5" />
          <span>
            {room.beds} {room.beds === 1 ? "bed" : "beds"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 bg-muted/30 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground">
          {room.pmsStatus === "mapped" ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-primary" />
              <span>Mapped to PMS</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5 text-primary/50" />
              <span>No PMS</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 bg-muted/30 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground">
          <Battery className="w-3.5 h-3.5 text-muted-foreground" />
          <span>{getBatteryLabel(room.battery)}</span>
        </div>
      </div>
    </div>
  );
}

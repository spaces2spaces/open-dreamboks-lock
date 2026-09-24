import { storage } from "./storage";

async function seed() {
  console.log("Starting database seed...");

  // Create common areas
  const commonAreas = [
    { name: "2F Toilet", battery: 84, floor: "2F" },
    { name: "3F Toilet", battery: 89, floor: "3F" },
    { name: "Laundry", battery: 92, floor: "1F" },
    { name: "Main Entrance", battery: 78, floor: "1F" },
  ];

  const createdCommonAreas = [];
  for (const area of commonAreas) {
    const created = await storage.createCommonArea(area);
    createdCommonAreas.push(created);
    console.log(`Created common area: ${area.name}`);
  }

  // Create rooms
  const toiletIds = createdCommonAreas.filter(a => a.name.includes("Toilet")).map(a => a.id);
  
  const rooms = [
    { name: "Capsule 201", type: "room", beds: 1, pmsStatus: "mapped", pmsId: "RM-201", battery: 95, floor: "2F", ordering: 1, commonAreas: [toiletIds[0]], isDreamBoks: true },
    { name: "Capsule 202", type: "room", beds: 1, pmsStatus: "mapped", pmsId: "RM-202", battery: 88, floor: "2F", ordering: 2, commonAreas: [toiletIds[0]], isDreamBoks: true },
    { name: "Capsule 203", type: "room", beds: 1, pmsStatus: "mapped", pmsId: "RM-203", battery: 92, floor: "2F", ordering: 3, commonAreas: [toiletIds[0]], isDreamBoks: true },
    { name: "Dorm 301", type: "dorm", beds: 4, pmsStatus: "mapped", pmsId: "DM-301", battery: 87, floor: "3F", ordering: 4, commonAreas: [toiletIds[1]], isDreamBoks: true },
    { name: "Dorm 302", type: "dorm", beds: 6, pmsStatus: "mapped", pmsId: "DM-302", battery: 90, floor: "3F", ordering: 5, commonAreas: [toiletIds[1]], isDreamBoks: true },
    { name: "Capsule 204", type: "room", beds: 1, pmsStatus: "unmapped", battery: 93, floor: "2F", ordering: 6, commonAreas: [toiletIds[0]], isDreamBoks: false },
  ];

  const createdRooms = [];
  for (const room of rooms) {
    const created = await storage.createRoom(room);
    createdRooms.push(created);
    console.log(`Created room: ${room.name}`);
  }

  // Reservations are synced from MEWS only - no seed data needed
  console.log("Skipping reservation seed - using MEWS sync only");

  // Create sample settings
  const defaultSettings = [
    { key: "ttlock_api_key", value: "" },
    { key: "mews_environment", value: "demo" },
    { key: "mews_client_token", value: "" },
    { key: "mews_access_token", value: "" },
    { key: "ttlock_username", value: "" },
    { key: "ttlock_password", value: "" },
    { key: "gateway_provider", value: "Twilio" },
    { key: "gateway_api_key", value: "" },
    { key: "gateway_sender_id", value: "" },
  ];

  for (const setting of defaultSettings) {
    await storage.setSetting(setting.key, setting.value);
    console.log(`Created setting: ${setting.key}`);
  }

  // PINs are generated automatically via MEWS automation - no seed data needed
  console.log("Skipping PIN seed - using automation engine only");

  console.log("Database seeding completed!");
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seeding failed:", error);
    process.exit(1);
  });

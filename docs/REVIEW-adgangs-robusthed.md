# Grundig gennemgang: adgangs-robusthed (aftalt 21/7 2026)

**Mål:** En gæst må ALDRIG blive låst ude om natten igen. Denne gennemgang skal
finde og lukke alle stier hvor en aktiv gæst kan ende uden en fungerende kode.

Kør: start en Claude-session og sig *"kør gennemgangen"* — dette er scopet.
Arbejd på gren `claude/charming-allen-yein79`. Verificér med `tsc` + `npm test`.
Commit undervejs, men **præsentér en plan FØR merge til main**.

## Baggrund (hændelse 20.–21. juli)
Gateway-udfald på Capsule Inn's fællesdøre → koder manglede på hovedindgang/
reception; gæster låst ude om natten. Delvist afhjulpet med to fixes:
- `import-group`-endpoint (genskab tenant-låse) — commit på `main`.
- PIN-repair fra hver time → **hvert 5. min** (`pin_repair_interval_minutes`),
  commit `e9b2db6`.

Men den dybere risiko er IKKE lukket endnu (se nedenfor).

## Fokusområder

### 1. "Missing key → marked deleted" (HØJESTE PRIORITET)
`server/automation.ts` ~linje **1591** og ~**1882**: en manglende nøgle på en lås
markerer PIN'en som `deleted` i stedet for at gen-pushe den.
- Kan en *endnu-ikke-pushet* fællesdør-kode (fejlede under gateway-udfald) blive
  slettet frem for gen-pushet?
- Hvornår kører hvert job (schedule)? Race mod PIN-repair?
- Er der/bør der være en **grace-periode** før sletning?
- Bør "missing" på en online lås trigge **re-push** frem for delete?

### 2. Alle "gæst uden kode"-stier
- Gateway offline: `failedLockIds` springes over — verificér at det holder overalt.
- PIN-repair (`repairActivePinsWithMissingLocks`, additiv) — dækker den alle låstyper?
- Orphan-cleanup (automation.ts ~1780) — schedule + slette-kriterier.
- Lås-sync-sletninger (`/api/sync-ttlocks` trin 5) — samme mønster som Downtown-wipe `be830a5`.

### 3. Safety-valve
- Ingen job må **masse-slette** koder/låse. Fx: hvis "0 tilgængelige/synlige" →
  slet ALDRIG (afbryd i stedet). Overvej tærskel + advarsel.

### 4. Fixes + tests
Implementér sikre rettelser MED dækkende tests (nat-/gateway-udfald-scenarier).

## Leverance
Plan → godkendelse → implementering på gren → tsc+test grønt → plan før merge.

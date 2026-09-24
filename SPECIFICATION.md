# Kravspecifikation: DreamBoks Management System

## 1. Systemets Formål
At automatisere gæsteadgang til "DreamBoks" sovekapsler ved at fungere som en intelligent mellemvare (middleware), der synkroniserer data mellem **MEWS PMS** (Booking) og **TTLock** (Smart Locks).
*   Systemet skal understøtte både **DreamBoks-enheder** (sovekapsler) og **generelle døre** (hoveddør, trapperum, fællesarealer) på samme lokation.
*   Første implementation foretages mod **MEWS Demo** miljøet, med mulighed for nemt at skifte til **Production** via indstillingerne.

## 2. Arkitektur & Roller
*   **Frontend:** Web-baseret Dashboard (React) til administration, overvågning og manuel styring.
*   **Backend:** Server (Node.js) der håndterer logik, webhooks og API-kald 24/7.
*   **Database:** Central lagring (PostgreSQL) af konfigurationer, mappings og log-historik.

## 3. Moduler & Funktionalitet

### 3.1. Indstillinger (Global Settings)
Systemet skal kunne konfigureres via UI uden kode-ændringer.
*   **MEWS Integration:**
    *   Understøttelse af både **Demo** og **Production** miljøer (URL switch).
    *   Input-felter til `Client Token` og `Access Token`.
*   **TTLock Integration:**
    *   Login via `Username` og `Password` (Admin konto).
    *   API Access konfiguration (Client ID/Secret).
*   **Communication Gateway:**
    *   Opsætning af SMS/Email provider (f.eks. Twilio/SendGrid).
    *   Felter til `API Key`, `Sender ID` (Afsender navn).

### 3.2. Lokale- & Låsestyring (Spaces)
*   **Manuel Styring (CRUD):**
    *   Mulighed for manuelt at oprette nye værelser/spaces.
    *   Mulighed for at ændre navn på eksisterende værelser.
    *   Mulighed for at slette værelser.
*   **Mapping-struktur:**
    *   **Room ↔ TTLock Lock ID:** En fysisk lås kobles til et overordnet værelse.
    *   **Bed ↔ Room:** Senge (beds) oprettes under et værelse. Systemet finder den rette fysiske lås via værelset (parent).
*   **Senge-konfiguration:** Understøttelse af sovesale (Dorms), hvor ét værelse har flere senge (beds), som kan reserveres enkeltvis i MEWS. Alle senge i samme værelse deler den samme fysiske TTLock-lås, men hver reservation får sin egen unikke PIN-kode.
*   **DreamBoks Markering:** En "checkbox" på hvert værelse, der definerer om enheden er en "DreamBoks". (Bruges til statistik).
*   **Fællesarealer:** Mulighed for at linke et værelse til fællesdøre (f.eks. "Hovedindgang").
*   **Status:** Visning af batteriniveau og online/offline status for hver lås.

### 3.3. Reservations-flow & Automatik (Hjernen)
1.  **Trigger:** Systemet lytter på Webhooks fra MEWS.
    *   **PIN Oprettelse:** Sker specifikt når reservationens status ændres til **"Checked-in"** i MEWS (ikke kun ved oprettelse).
2.  **Validering:**
    *   Er værelset/sengen mappet til en lås?
3.  **Handling (Adgang):**
    *   Systemet kalder TTLock API.
    *   **Unik Kode:** Der genereres én fælles PIN-kode pr. reservation (bed).
    *   **Tildeling:** Koden tildeles til:
        1.  Den TTLock-lås, der er mappet til værelset/sengen.
        2.  Alle TTLock-låse, der er mappet som "Common Areas" for dette værelse.
    *   **Gyldighed:** Koden sættes til at virke fra `Check-in tid` til `Check-out tid`.
4.  **Synkronisering & Ændringer:**
    *   **Dato-ændring:** Ved ændring af ankomst-/afrejsedato i MEWS skal systemet justere PIN-kodens gyldighed i TTLock.
    *   **Annullering/Checkout:** Ved status `Canceled`, `No-show` eller `Checked-out` skal PIN-koden deaktiveres/slettes i TTLock.
    *   **Gem i MEWS:** Den genererede PIN-kode skal sendes tilbage og gemmes på reservationen i MEWS (i et custom field eller note), så personalet kan se den.
5.  **Kommunikation:**
    *   Systemet sender koden til gæsten (via Email/SMS Gateway).
    *   Beskeden indeholder: Værelsesnummer, PIN-kode, og gyldighedsperiode.

### 3.4. Dashboard & Statistik (KPI'er)
Statistikken skal give et økonomisk og driftsmæssigt overblik.
*   **Filtrering:** **KUN** data fra værelser markeret som "DreamBoks" inkluderes.
*   **Nøgletal (Vises som YTD og Nuværende Måned):**
    *   Total Revenue (Omsætning).
    *   Nights Sold (Solgte nætter).
    *   ADR (Gennemsnitspris pr. nat).
    *   Occupancy Rate (Belægningsprocent).
    *   RevPAR (Revenue Per Available Room).
*   **Grafer:** Historisk udvikling pr. måned for indeværende år.

### 3.5. Logning & Sporbarhed (Records)
For at kunne fejlsøge og dokumentere drift.
*   **Reservations Log:** En detaljeret tidslinje på hver reservation (f.eks. *"Checked-in modtaget", "PIN oprettet", "SMS sendt", "Check-out modtaget - PIN slettet"*).
*   **Lock Activity Log:** Systemet skal hente og vise hændelser fra TTLock pr. lås (dør):
    *   Tidspunkt for åbning.
    *   Hvilken PIN/brugertype (Reservation PIN, Staff PIN, Admin PIN).
    *   (Hvis muligt) Gæstens navn/reservations-ID.
    *   Visning: Loggen vises i UI’et på lås-/værelsesniveau og kan filtreres.

## 4. Design Guidelines (S2S)
*   **Farver:**
    *   Primary: Persian Red (`#cc352a`)
    *   Accent: Columbian Blue (`#c8d5e9`)
    *   Text: Eerie Black (`#232321`)
    *   Backgrounds: White / Light Gray.
    *   **INGEN GRØN:** (Bruges ikke til "Succes" - brug i stedet blå/neutral eller ikoner).
*   **Typografi:**
    *   UI/Tekst: `Source Sans 3`
    *   Data/Koder/ID'er: `Source Code Pro`
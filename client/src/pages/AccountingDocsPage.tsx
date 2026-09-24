import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BookOpenText, Printer } from "lucide-react";

// ── Bookkeeping — static documentation for the bookkeeper (owner request
// 1/8): a current-state explanation of how kiosk/hourly sales, revenue and
// payments hang together in MEWS. No changelog/history on this page — it
// describes how the setup works NOW. Update it when the MEWS setup changes.

// GUIDs for the NEW per-product accounting categories (1013/1014/1015, set up
// by the bookkeeper 3/8) cannot be read out: accountingCategories/getAll and
// products/getAll are outside the connector scope (probed 3/8 → 401, same as
// rates/getAll). Add them here if MEWS Partner Success ever opens the scope.
const IDS: Array<[string, string]> = [
  ['Service "Stay Night 15:00" (bruges til timebookinger)', "29a2b0a6-d556-4af1-8826-b44e008efe69"],
  ['Produkt "Early check-in (per hour)"', "fd764fcd-7a23-482a-a440-b48d0113ac79"],
  ['Produkt "Late check-out per hour"', "fb4cf531-b152-44d0-87e6-b48d012450b2"],
  ['Produkt "Hour Bookings" (timebookinger)', "4fcaad20-853f-4fe0-920d-b499008d29b5"],
  ['Rate til timebookinger', "29451a4b-e75e-4bf4-a930-b45c00dd4f38"],
  ['Accounting category "Stay – HOSTEL sales – 25%" (konto 1010)', "4b457114-37ee-439c-9c62-b46600adac36"],
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold mt-8 mb-2">{children}</h2>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left text-xs uppercase tracking-wide text-muted-foreground font-medium px-3 py-2 whitespace-nowrap">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top border-t ${className}`}>{children}</td>;
}

export default function AccountingDocsPage() {
  return (
    <DashboardLayout>
      <div className="max-w-4xl print:max-w-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BookOpenText className="w-6 h-6" /> Bookkeeping
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Sådan hænger kiosk- og timesalg sammen i MEWS — omsætning, betaling og afstemning · Hotel Capsule Inn
            </p>
          </div>
          <Button variant="outline" onClick={() => window.print()} className="print:hidden shrink-0">
            <Printer className="w-4 h-4 mr-2" /> Print / gem som PDF
          </Button>
        </div>

        <SectionTitle>1 · De tre salgstyper og hvor omsætningen lander</SectionTitle>
        <p className="text-sm text-muted-foreground mb-3">
          DreamBoks (kiosk- og gæstesystemet) sælger tre ting uden om receptionen. Alt sammen ender som almindelige
          posteringer i MEWS med 25 % dansk moms:
        </p>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr><Th>Salg</Th><Th>Hvad gæsten køber</Th><Th>Pris</Th><Th>Sådan ser det ud i MEWS</Th></tr>
              </thead>
              <tbody>
                <tr>
                  <Td className="font-medium whitespace-nowrap">Early check-in</Td>
                  <Td>Tidligere adgang til kapslen, betalt pr. time (kiosk eller telefon)</Td>
                  <Td className="whitespace-nowrap tabular-nums">37,50 kr./time</Td>
                  <Td>Produktlinje <strong>"Early check-in (per hour)"</strong> på gæstens eksisterende reservation. Antal = antal timer.</Td>
                </tr>
                <tr>
                  <Td className="font-medium whitespace-nowrap">Late check-out</Td>
                  <Td>Senere afrejse, betalt pr. time (loft kl. 15:00)</Td>
                  <Td className="whitespace-nowrap tabular-nums">37,50 kr./time</Td>
                  <Td>Produktlinje <strong>"Late check-out per hour"</strong> på gæstens eksisterende reservation. Antal = antal timer.</Td>
                </tr>
                <tr>
                  <Td className="font-medium whitespace-nowrap">Timebooking</Td>
                  <Td>Kapsel på timebasis uden overnatningsbooking (via hotellets timeside)</Td>
                  <Td className="whitespace-nowrap tabular-nums">fx 399 kr./pakke</Td>
                  <Td>Reservation på <strong>"Stay Night 15:00"</strong> til <strong>0 kr.</strong> + hele det betalte beløb som produktlinje <strong>"Hour Bookings"</strong> på reservationen.</Td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground mt-2">
          Timebookinger oprettes på hotellets <em>almindelige</em> overnatnings-service — de gamle MEWS-services
          "DayStay", "Power Nap Capsule" og "Hourly stay - 4h package" bruges <strong>ikke</strong> og skal ignoreres i
          rapporter. Produkternes "Base price" i MEWS er uden betydning: DreamBoks sender altid det faktisk betalte
          beløb med på hver linje, og priserne styres i DreamBoks' indstillinger.
        </p>

        <SectionTitle>2 · Betalingen — hvordan pengene kommer ind og afstemmes</SectionTitle>
        <Card>
          <CardContent className="pt-4 text-sm space-y-3">
            <p>
              Alle tre salgstyper betales med kort via <strong>MEWS payment requests</strong> (MEWS' egen
              betalingsløsning, Mews Payments). DreamBoks opretter payment requesten, gæsten betaler på sin telefon
              eller kiosken, og betalingen lander direkte i MEWS — DreamBoks rører aldrig selv pengene og har ingen
              egen betalingsgateway.
            </p>
            <p>
              <strong>Early check-in / late check-out:</strong> payment requesten knyttes til gæstens eksisterende
              reservation. Når gæsten har betalt, ligger betalingen på reservationens regning og udligner
              produktlinjen — reservationens balance går i 0.
            </p>
            <p>
              <strong>Timebookinger:</strong> gæsten betaler <em>før</em> reservationen findes, så payment requesten
              knyttes til kundeprofilen. Når betalingen er gennemført, opretter DreamBoks reservationen (0 kr.) med
              "Hour Bookings"-produktlinjen, og betalingen udligner den. Resultatet er det samme: balance 0.
            </p>
            <p>
              <strong>Afstemning:</strong> omsætning og betaling ligger altid på samme reservation og matcher 1:1 —
              produktlinjens beløb = payment requestens beløb. Betalinger bærer ingen produktinfo i MEWS;{" "}
              <em>hvad</em> der er solgt aflæses på produktlinjerne (Order Items-rapporten), <em>at</em> der er betalt
              aflæses på betalingen. Udbetaling til banken og kortgebyrer følger hotellets almindelige Mews
              Payments-aftale, præcis som alle andre onlinebetalinger i MEWS.
            </p>
            <p>
              <strong>Ubetalt = intet salg:</strong> gennemføres betalingen ikke, oprettes der hverken produktlinje
              eller reservation (timebooking) / produktlinje (early/late) — der kan altså aldrig stå omsætning i MEWS
              som ikke er betalt via en payment request.
            </p>
          </CardContent>
        </Card>

        <SectionTitle>3 · Kontering</SectionTitle>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr><Th>Post i MEWS</Th><Th>Accounting category</Th><Th>Konto</Th></tr>
              </thead>
              <tbody>
                <tr><Td>Early check-in (per hour) — produkt</Td><Td>Early check-in (per hour) — m/moms</Td><Td className="tabular-nums">1014</Td></tr>
                <tr><Td>Late check-out per hour — produkt</Td><Td>Late check-out (per hour) — m/moms</Td><Td className="tabular-nums">1015</Td></tr>
                <tr><Td>Hour Bookings — produkt (timebookinger)</Td><Td>Hour Booking — m/moms</Td><Td className="tabular-nums">1013</Td></tr>
                <tr><Td>Betalingerne (alle tre typer)</Td><Td>MEWS Online Payments</Td><Td className="tabular-nums">5836</Td></tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground mt-2">
          Hver af de tre salgstyper har sin egen konto (opsat af bogholderiet 3/8 og tilknyttet produkterne i MEWS),
          så de kan følges direkte i MEWS' Accounting Report og i eksporten — adskilt fra almindelig overnatning på
          konto 1010. Betalingerne ligger på konto 5836 sammen med øvrige onlinebetalinger.
        </p>

        <SectionTitle>4 · Kontoplanen i MEWS (til afstemning)</SectionTitle>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr><Th>Konto</Th><Th>Navn</Th><Th>Moms</Th><Th>DreamBoks-salg?</Th></tr>
              </thead>
              <tbody>
                <tr><Td className="tabular-nums">1010</Td><Td>HOSTEL salg</Td><Td>m/moms</Td><Td>Nej — almindelig overnatning</Td></tr>
                <tr><Td className="tabular-nums">1011</Td><Td>Profit insignificant</Td><Td>—</Td><Td>Nej</Td></tr>
                <tr><Td className="tabular-nums">1012</Td><Td>Loss insignificant</Td><Td>—</Td><Td>Nej</Td></tr>
                <tr><Td className="tabular-nums">1013</Td><Td>Hour Booking</Td><Td>m/moms</Td><Td><strong>Ja — timebookinger</strong></Td></tr>
                <tr><Td className="tabular-nums">1014</Td><Td>Early check-in (per hour)</Td><Td>m/moms</Td><Td><strong>Ja — early check-in</strong></Td></tr>
                <tr><Td className="tabular-nums">1015</Td><Td>Late check-out (per hour)</Td><Td>m/moms</Td><Td><strong>Ja — late check-out</strong></Td></tr>
                <tr><Td className="tabular-nums">1030</Td><Td>HOSTEL salg</Td><Td>u/moms</Td><Td>Nej</Td></tr>
                <tr><Td className="tabular-nums">1031</Td><Td>No-show fees</Td><Td>m/moms</Td><Td>Nej</Td></tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground mt-2">
          Kontonumrene er meldt ud af bogholderiet 3/8-2026 og sat op i MEWS samme dag. Alt DreamBoks-salg er
          m/moms (25 %) — DreamBoks sender altid dansk moms (TaxCode DK-S) med på hver produktlinje.
        </p>

        <SectionTitle>5 · Tekniske referencer (til supportsager)</SectionTitle>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr><Th>Objekt</Th><Th>MEWS-id</Th></tr>
              </thead>
              <tbody>
                {IDS.map(([label, id]) => (
                  <tr key={id}>
                    <Td>{label}</Td>
                    <Td><code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">{id}</code></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground mt-6 mb-2">
          Vedligeholdes af DreamBoks — siden beskriver den aktuelle opsætning og opdateres når konteringen ændres.
        </p>
      </div>
    </DashboardLayout>
  );
}

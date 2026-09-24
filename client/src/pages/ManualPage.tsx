import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LifeBuoy, Printer } from "lucide-react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { settingsAPI } from "@/lib/api";
import { MANUAL_TOPICS } from "@/lib/manual-topics";

// ── Vejledning — static plain-Danish staff guide (owner request 6/8): how
// door codes work with MEWS across every flow (overnight, time-booking,
// early/late, upsell), and what happens when a guest is moved on the
// timeline. Sub-topics surface as sub-menu items under "Vejledning" in the
// sidebar (DashboardLayout). Same static-docs pattern as AccountingDocsPage:
// the pages describe how it works NOW — update them when the flows change.

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold mt-8 mb-2">{children}</h2>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left text-xs uppercase tracking-wide text-muted-foreground font-medium px-3 py-2 whitespace-nowrap">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top border-t ${className}`}>{children}</td>;
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">{i + 1}</span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function OvernatningTopic() {
  return (
    <>
      <SectionTitle>Sådan virker dørkoden for en almindelig reservation</SectionTitle>
      <Card>
        <CardContent className="pt-6">
          <Steps
            items={[
              <>Reservationen kommer automatisk ind fra MEWS — der skal ikke oprettes noget manuelt.</>,
              <>Systemet laver en dørkode og lægger den på kapslens lås og indgangsdørene. Gæsten får koden automatisk på SMS/mail før ankomst.</>,
              <>Koden virker fra check-in-tid på ankomstdagen til check-ud-tid på afrejsedagen — købt early check-in eller late check-out udvider tidsrummet af sig selv.</>,
              <>Første gang gæsten bruger koden, bliver reservationen automatisk checket ind i MEWS.</>,
              <>Ved afrejse udløber koden af sig selv. Ingen manuelle skridt.</>,
            ]}
          />
        </CardContent>
      </Card>

      <SectionTitle>Flytte en overnattende gæst til en anden kapsel</SectionTitle>
      <Card className="mb-10">
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            <strong>Før gæsten er ankommet:</strong> Træk bare reservationen til en anden kapsel på MEWS-timelinen.
            Koden flytter automatisk med (samme cifre), og gæsten får ny besked. Du skal ikke gøre andet.
          </p>
          <p>
            <strong>Efter gæsten er ankommet:</strong> Koden flytter også automatisk med til den nye kapsel — men
            gæsten står ikke og kigger på sin telefon, når du flytter. Flyt derfor kun en ankommet gæst, når
            gæsten <strong>ved det</strong> (I har talt/skrevet sammen), så ingen bliver overrasket over, at koden
            åbner en anden dør.
          </p>
          <p className="text-muted-foreground">
            Gælder flytningen en <strong>time-booking</strong>, gælder der en særlig sikkerhed — se siden "Time-booking".
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function TidsbookingTopic() {
  return (
    <>
      <SectionTitle>1 · Sådan virker en time-booking</SectionTitle>
      <Card>
        <CardContent className="pt-6">
          <Steps
            items={[
              <>Gæsten booker og betaler på hjemmesiden (eller en medarbejder opretter bookingen under <strong>Time Booking</strong>).</>,
              <>Systemet vælger en ledig kapsel og laver en <strong>4-cifret dørkode</strong>, der kun virker i det bookede tidsrum.</>,
              <>Koden lægges automatisk på kapslens lås og på indgangsdørene, og gæsten får den på SMS (og mail).</>,
              <>Første gang gæsten taster koden, bliver reservationen <strong>automatisk checket ind</strong> i MEWS.</>,
              <>Når tiden udløber, holder koden op med at virke af sig selv, reservationen checkes automatisk ud i MEWS, og rengøringen har fået SMS om tidspunktet.</>,
            ]}
          />
          <p className="text-sm text-muted-foreground mt-4">
            Der er altså ingen manuelle skridt — hverken ved ankomst eller afrejse.
          </p>
        </CardContent>
      </Card>

      <SectionTitle>2 · Flytte en time-booking i MEWS — FØR gæsten er ankommet</SectionTitle>
      <Card>
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            Træk bare reservationen til en anden kapsel på MEWS-timelinen. Systemet opdager det inden for
            ca. 5 minutter og gør resten selv:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Koden flyttes til den nye kapsel — <strong>samme cifre</strong>.</li>
            <li>Gæsten får en SMS med den nye kapsel og en påmindelse om, at koden er den samme.</li>
            <li>Rengøringen får besked om den nye kapsel.</li>
          </ul>
          <p className="text-muted-foreground">Du skal ikke gøre andet.</p>
        </CardContent>
      </Card>

      <SectionTitle>3 · Flytte en time-booking i MEWS — EFTER gæsten er ankommet</SectionTitle>
      <Card className="mb-10">
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            Typisk situation: gæsten står ved sin kapsel, og den er ikke klar — f.eks. ikke rengjort.
            Flyt gæsten til en anden kapsel i MEWS, og det er det. Systemet reagerer inden for ca. 5 minutter:
          </p>
          <Steps
            items={[
              <>Gæstens kode kommer <strong>også</strong> til at virke på den nye kapsel — samme cifre.</>,
              <>Gæsten får en SMS: <em>"Your capsule has changed to Capsule X. Your door code is the same."</em></>,
              <>Koden <strong>bliver ved med at virke på den gamle kapsel</strong>, indtil gæsten har åbnet den nye dør. På den måde kan ingen blive låst ude — heller ikke en gæst, der ligger og sover og ikke ser sin telefon.</>,
              <>Når gæsten åbner den nye kapsel første gang, gør systemet flytningen færdig: koden fjernes fra den gamle dør, og den gamle kapsel bliver ledig igen.</>,
            ]}
          />
          <p>
            Mens flytningen venter på gæsten, holder systemet <strong>begge</strong> kapsler optaget, så ingen
            andre kan booke dem.
          </p>
          <p>
            <strong>Fortrudt, eller flyttet ved en fejl?</strong> Flyt bare reservationen tilbage i MEWS — systemet
            fjerner selv den ekstra kode igen.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function EarlyLateTopic() {
  return (
    <>
      <SectionTitle>Early check-in — tidligere adgang, betalt pr. valgt starttid</SectionTitle>
      <Card>
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            Gæster med en reservation kan købe tidligere adgang via kiosken eller linket på deres telefon.
            Prisen afhænger af starttiden (jo tidligere, jo dyrere), og gæsten vælger selv tidspunktet.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Ved køb udvides dørkodens gyldighed automatisk, så den virker fra den købte starttid — samme cifre.</li>
            <li>Er den købte starttid <strong>ude i fremtiden</strong>, sker der ingenting før da — koden åbner først fra den valgte tid.</li>
            <li>Kapslen skal være klarmeldt (rengjort) før tidlig adgang — systemet holder selv øje og skriver til gæsten, når kapslen er klar.</li>
            <li>Beløbet bogføres automatisk i MEWS med moms. Ingen manuelle posteringer.</li>
          </ul>
        </CardContent>
      </Card>

      <SectionTitle>Late check-out — senere afrejse, betalt pr. time</SectionTitle>
      <Card className="mb-10">
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            Gæster kan købe senere udtjekning fra deres telefon (op til kl. 15:00). Prisen afhænger af
            tidspunktet (jo senere, jo dyrere).
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Dørkoden forlænges automatisk til den købte tid — samme cifre.</li>
            <li>Afrejsetidspunktet flyttes automatisk i MEWS, så kapslen ikke kan sælges dobbelt — heller ikke som time-booking.</li>
            <li>MEWS' automatiske morgen-udcheck rører ikke en gæst, der har betalt for at blive længere.</li>
            <li>Beløbet bogføres automatisk i MEWS med moms.</li>
          </ul>
          <p className="text-muted-foreground">
            Priser og tidspunkter for begge dele styres under <strong>Settings</strong> — spørg ejeren, før de ændres.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function MersalgTopic() {
  return (
    <>
      <SectionTitle>Automatiske tilbuds-SMS'er</SectionTitle>
      <Card>
        <CardContent className="pt-6 text-sm space-y-3">
          <p>
            Systemet sender selv mersalgs-tilbud til gæsterne — der er ingen manuel udsendelse:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Early check-in-tilbud</strong> sendes til gæster, der ankommer, med et link hvor de kan købe tidligere adgang.</li>
            <li><strong>Late check-out-tilbud</strong> sendes kl. 19:00 aftenen før afrejse til morgendagens afrejser.</li>
            <li>Linket i SMS'en åbner kun gæstens <strong>eget</strong> tilbud med gæstens egen reservation — det kan ikke bruges af andre.</li>
            <li>Er gæstens telefonnummer ugyldigt, sendes tilbuddet på mail i stedet.</li>
          </ul>
        </CardContent>
      </Card>

      <SectionTitle>Opfølgning på Marketing-siden</SectionTitle>
      <Card className="mb-10">
        <CardContent className="pt-6 text-sm space-y-3">
          <ul className="list-disc pl-5 space-y-1">
            <li>Under <strong>Marketing</strong> ses dag-for-dag-historik over udsendelser, klik og køb.</li>
            <li>Der kommer en automatisk salgsrapport på mail hver dag kl. 12:00.</li>
            <li>Test-SMS kan sendes fra Marketing-siden — den går kun til testnummeret, aldrig til gæster.</li>
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

function ReglerTopic() {
  return (
    <>
      <SectionTitle>Fem gyldne regler</SectionTitle>
      <Card>
        <CardContent className="pt-6">
          <Steps
            items={[
              <><strong>Gæstens kode ændres aldrig.</strong> Alle flytninger og reparationer sker med de samme cifre. Systemet reparerer selv en kode, der mangler på en lås — altid med de cifre, gæsten allerede har fået.</>,
              <><strong>Ret aldrig koder manuelt i TTLock-appen.</strong> Hotellet er ubemandet, så alt skal kunne ske automatisk og på afstand — manuelle rettelser bliver overskrevet af systemet og kan låse gæsten ude.</>,
              <><strong>Annullér aldrig et check-in i MEWS for at kunne flytte en gæst.</strong> Flyt bare reservationen — systemet håndterer resten, uanset om gæsten er ankommet eller ej.</>,
              <><strong>Flyt ikke en ankommet gæst uden at gæsten ved det</strong> — undtagen time-bookinger, hvor systemet selv beskytter gæsten (koden virker på begge kapsler, indtil gæsten er flyttet).</>,
              <><strong>Giv systemet ca. 5 minutter.</strong> MEWS-ændringer opdages automatisk kort efter. Ser noget forkert ud, kommer der en advarselsmail, der fortæller, hvad du skal gøre.</>,
            ]}
          />
        </CardContent>
      </Card>

      <SectionTitle>Advarselsmails — hvad betyder de?</SectionTitle>
      <p className="text-sm text-muted-foreground mb-3">
        Alle advarsler sendes til rapport-mailadressen. De fleste situationer reparerer systemet selv —
        mailen er et ekstra sæt øjne, og den skriver altid, hvis du skal gøre noget.
      </p>
      <Card className="mb-10">
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr><Th>Mailen handler om…</Th><Th>Det betyder</Th><Th>Det skal du gøre</Th></tr>
            </thead>
            <tbody>
              <tr>
                <Td className="font-medium">"…flyttet i MEWS efter ankomst — koden virker nu på både X og Y"</Td>
                <Td>En ankommet time-gæst er flyttet på timelinen. Systemet har lagt koden på begge kapsler og venter på, at gæsten bruger den nye dør.</Td>
                <Td>Ingenting — medmindre flytningen var en fejl: flyt så reservationen tilbage i MEWS.</Td>
              </tr>
              <tr>
                <Td className="font-medium">"…flyttet i MEWS, men koden fulgte IKKE med"</Td>
                <Td>Systemet kunne ikke flytte koden — den nye kapsel er optaget, har ingen lås, eller låsen er offline. Gæstens kode virker stadig på den <strong>gamle</strong> kapsel.</Td>
                <Td>Læs detaljen i mailen: flyt reservationen tilbage, eller flyt den til en anden (ledig) kapsel.</Td>
              </tr>
              <tr>
                <Td className="font-medium">Manglende dørkode på en lås</Td>
                <Td>En gæsts kode mangler på en dør, og automatisk reparation er ikke lykkedes endnu.</Td>
                <Td>Følg mailens anvisning. Systemet bliver ved med at forsøge selv.</Td>
              </tr>
              <tr>
                <Td className="font-medium">Gateway/lås offline</Td>
                <Td>En dørs internetforbindelse er nede — koder kan ikke lægges på eller fjernes, før den er online igen.</Td>
                <Td>Tjek strøm/net på gatewayen. Koder, der ventede, lægges automatisk på, når den kommer online.</Td>
              </tr>
              <tr>
                <Td className="font-medium">Lås-sync afbrudt (sikkerhedsbremse)</Td>
                <Td>En synkronisering ville have slettet flere låse end normalt — systemet stoppede for en sikkerheds skyld, og intet blev slettet.</Td>
                <Td>Kontakt ejeren/administratoren, før der syncs igen.</Td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}

const TOPIC_CONTENT: Record<string, { title: string; subtitle: string; render: () => React.ReactElement }> = {
  overnatning: {
    title: "Overnatning & dørkoder",
    subtitle: "Sådan virker dørkoden for almindelige reservationer — og sådan flytter du en gæst",
    render: OvernatningTopic,
  },
  tidsbooking: {
    title: "Time-booking",
    subtitle: "Sådan virker dørkoder til time-bookinger — og hvad der sker, når du flytter en gæst i MEWS",
    render: TidsbookingTopic,
  },
  "early-late": {
    title: "Early check-in & Late check-out",
    subtitle: "Tilkøb af tidligere adgang og senere afrejse — alt sker automatisk",
    render: EarlyLateTopic,
  },
  mersalg: {
    title: "Mersalgs-SMS",
    subtitle: "De automatiske tilbud til gæsterne, og hvor du følger med",
    render: MersalgTopic,
  },
  regler: {
    title: "Gyldne regler & alarmer",
    subtitle: "Reglerne, der beskytter gæsternes adgang — og hvad advarselsmails betyder",
    render: ReglerTopic,
  },
};

export default function ManualPage() {
  const [location] = useLocation();

  // Hourly-only topics hidden for tenants without time-booking (same gate as
  // the Time Booking menu item).
  const { data: hourlySetting } = useQuery({
    queryKey: ["settings", "hourly_rentals_enabled"],
    queryFn: () => settingsAPI.getOne("hourly_rentals_enabled").catch(() => null),
  });
  const hourlyEnabled = hourlySetting?.value === "true";

  const slug = location.replace(/^\/manual\/?/, "") || "overnatning";
  const allowed = MANUAL_TOPICS.some(t => t.slug === slug && (!t.hourlyOnly || hourlyEnabled));
  const topic = TOPIC_CONTENT[allowed ? slug : "overnatning"];
  const Body = topic.render;

  return (
    <DashboardLayout>
      <div className="max-w-4xl print:max-w-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <LifeBuoy className="w-6 h-6" /> Vejledning · {topic.title}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{topic.subtitle}</p>
          </div>
          <Button variant="outline" onClick={() => window.print()} className="print:hidden shrink-0">
            <Printer className="w-4 h-4 mr-2" /> Print / gem som PDF
          </Button>
        </div>
        <Body />
      </div>
    </DashboardLayout>
  );
}

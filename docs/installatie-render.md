# Installatie bij Render (zelf te regelen, zonder serverbeheer)

Met deze route heeft u geen eigen server of hulp van een hostingpartij nodig. [Render](https://render.com) draait het voorraadbeheer 24/7, regelt HTTPS en start het programma vanzelf opnieuw op als er iets misgaat. Alles gaat via de website van Render en het dashboard; u hoeft geen commando's te typen.

**Eén server voor al uw webshops.** Alle webshops draaien samen op één server, elk met een eigen database, eigen koppelingen en een eigen synchronisatie. Ze zitten elkaar niet in de weg. Een storing of foute sleutel bij de ene webshop heeft geen invloed op de andere.

- **Kosten:** **$7,25 per maand** voor alle webshops samen (prijzen per oktober 2026, exclusief btw):

  | Onderdeel | Prijs | Nodig | Per maand |
  |---|---|---|---|
  | Workspace *Hobby* | gratis | 1 Render-account is genoeg (collega's loggen in op het dashboard, niet bij Render) | $0 |
  | Server *Starter* (512 MB, 0,5 CPU, altijd aan) | $7 | 1 (ruim voldoende voor 4 webshops) | $7,00 |
  | Opslag (persistent disk) | $0,25 per GB | 1 GB (databases van alle webshops + 14 dagelijkse back-ups) | $0,25 |
  | Dataverkeer | 5 GB inbegrepen, daarna $0,15/GB | ± 1–1,5 GB voor 4 webshops (alles wordt gecomprimeerd) | $0 |
  | Eigen webadres (custom domain) | 2 inbegrepen, daarna $0,25 per stuk | 1 (bijv. voorraad.tochtstripdeur.nl) | $0 |
  | Build-minuten (installeren van updates) | 500 inbegrepen | enkele minuten per update | $0 |
  | Task runs / Workflows, databases, cron jobs | per gebruik | niet gebruikt | $0 |

  Let op het verschil: het **workspace-plan** (Hobby, Pro, Scale – onder *Billing → Change plan*) is uw account; laat dat op **Hobby**. **Starter** is het *server-type* (instance type) en wordt automatisch gekozen door het bestand `render.yaml` wanneer u installeert via **New → Blueprint** (stap 1). U ziet het terug in het overzicht vóór u op *Apply* klikt.

  Render rekent per seconde af. Kies **niet** de gratis *Free*-server: die valt na 15 minuten zonder bezoek in slaap en haalt dan geen Bol.com-orders meer op.
- **Locatie:** Frankfurt (EU). Er worden geen klantgegevens opgeslagen: alleen ordernummers, artikelnummers en aantallen, plus de namen en e-mailadressen van uw collega's.
- **Webshops:** blijven gewoon waar ze nu staan. Daar verandert niets aan.

Reken voor de installatie op ongeveer een half uur, plus ongeveer 20 minuten per webshop.

---

## Stap 1 – Account aanmaken en installeren (± 10 minuten)

1. Ga naar [render.com](https://render.com) en kies **Get Started**. Meld u aan **met GitHub**, met het account dat toegang heeft tot `nkiburg-digitalness/Nick-Kiburg`.
2. Voeg onder **Billing** een betaalmethode toe (nodig voor het Starter-abonnement en de opslag).
3. Kies rechtsboven **New → Blueprint**.
4. Koppel GitHub als daarom gevraagd wordt en geef Render toegang tot de repository **Nick-Kiburg**.
5. Kies de repository **Nick-Kiburg** en als branch **`claude/inventory-management-realtime-sync-axcymf`**. Render leest dan het bestand `render.yaml` en stelt alles zelf in: servertype, regio Frankfurt, opslag, back-ups en een geheime sleutel om de API-sleutels van uw webshops versleuteld op te slaan.
6. Render vraagt drie waarden:
   - `ADMIN_EMAIL`: uw e-mailadres (hiermee logt u in)
   - `ADMIN_NAME`: uw naam
   - `ADMIN_PASSWORD`: een sterk wachtwoord van minimaal 10 tekens
7. Klik **Apply**. Render bouwt en start het programma; dat duurt een paar minuten.
8. Open daarna de service **voorraadbeheer**. Bovenaan staat het webadres, bijv. `https://voorraadbeheer-xxxx.onrender.com`. Open het en log in. 🎉

> Render maakt automatisch een `SECRET_KEY` aan (service → **Environment**). Wijzig of verwijder die niet: zonder deze sleutel kan het programma de opgeslagen API-sleutels van de webshops niet meer lezen.

## Stap 2 – Eigen webadres (optioneel, ± 10 minuten)

Wilt u een eigen adres, bijv. `https://voorraad.tochtstripdeur.nl`, in plaats van het onrender.com-adres? Eén adres is genoeg voor alle webshops.

1. Render → service **voorraadbeheer** → **Settings** → **Custom Domains** → **Add** → `voorraad.tochtstripdeur.nl`. Render toont nu welk **CNAME-record** nodig is (het onrender.com-adres).
2. Voeg dat record toe waar de DNS van het domein wordt beheerd:
   - **In Plesk:** Websites & Domeinen → tochtstripdeur.nl → **DNS-instellingen** → **Record toevoegen** → type **CNAME**, domeinnaam `voorraad`, waarde `voorraadbeheer-xxxx.onrender.com`.
   - Kunt u de DNS niet zelf aanpassen? Vraag uw hostingpartij dan alleen om dit ene CNAME-record toe te voegen. Dat is een standaardverzoek.
3. Klik in Render op **Verify**. Render regelt het HTTPS-certificaat automatisch; dat kan tot een uur duren.

## Stap 3 – Webshops toevoegen (± 20 minuten per webshop)

In het dashboard: menu rechtsboven → **Webshops beheren** → **+ Webshop toevoegen**. Herhaal dit voor elke webshop.

1. **Naam, webadres en kleur.** De kleur helpt om de webshops in het dashboard snel uit elkaar te houden.
2. **WooCommerce-sleutels.** WordPress-beheer van díe webshop → **WooCommerce → Instellingen → Geavanceerd → REST API → Sleutel toevoegen**: omschrijving "Voorraadbeheer", rechten **Lezen/Schrijven**. Kopieer de *Consumer key* en het *Consumer secret* naar het formulier.
3. **Bol.com (alleen als deze webshop ook op Bol.com verkoopt).** Bol.com Partnerplatform → **Instellingen → API-instellingen** → Retailer API → **Credentials aanmaken**. Kopieer de *Client ID* en het *Client secret* naar het formulier. Verkoopt de webshop niet op Bol.com? Laat de velden dan leeg.
4. Klik **Opslaan**. Het dashboard toont nu de **webhook-gegevens** van deze webshop: een eigen Aflever-URL en een eigen Geheim.
5. **Webhooks aanmaken.** WordPress-beheer van die webshop → **WooCommerce → Instellingen → Geavanceerd → Webhooks → Webhook toevoegen**, twee keer:

   | | Webhook 1 | Webhook 2 |
   |---|---|---|
   | Naam | Voorraad – order aangemaakt | Voorraad – order bijgewerkt |
   | Status | Actief | Actief |
   | Onderwerp | Order aangemaakt | Order bijgewerkt |
   | Aflever-URL | de Aflever-URL uit het dashboard (eindigt op `/webhooks/woocommerce/<webshop>`) | idem |
   | Geheim | het Geheim uit het dashboard | idem |
   | API-versie | WP REST API Integration v3 | idem |

   De webhook-gegevens kunt u altijd terugvinden via **Webshops beheren → Webhook-gegevens**.
6. Klik op **Verbinding testen**. U ziet direct of WooCommerce (en Bol.com) de sleutels accepteert.

De sleutels worden versleuteld opgeslagen en daarna nooit meer getoond. Wilt u een sleutel vervangen? Vul dan bij **Bewerken** alleen dat veld in; lege velden houden hun huidige waarde.

## Stap 4 – Producten inlezen en live gaan (per webshop)

Menu rechtsboven → **Importeren / exporteren** → kies bovenaan de **webshop**.

1. **Producten uit webshop overnemen.** Haalt alle producten (ook variaties) op en koppelt ze op SKU.
2. **Productlijst downloaden.** Open hem in Excel en vul per product aan:
   - de **EAN**: nodig om Bol.com-orders te herkennen;
   - de **levertijd** en **veiligheidsmarge** in dagen;
   - de juiste **voorraad**, als die afwijkt.

   Sla op als CSV en kies **CSV uploaden**.
3. **Verkoophistorie inlezen.** Leest 90 dagen aan orders in, zodat de voorspelling meteen klopt.

> **Let op:** vanaf het moment van koppelen is de voorraad in dit systeem **leidend**. Die voorraad wordt naar de webshop gestuurd en, zodra het Bol-offer-ID bekend is, ook naar Bol.com. Controleer dus vóór het koppelen of de voorraadstanden kloppen.

## Stap 5 – Collega's toevoegen

Menu rechtsboven → **Gebruikers beheren**. Per collega kiest u:
- **een rol:** alleen bekijken, medewerker of beheerder;
- **welke webshops die collega mag zien:** standaard alle. Klik op "Alle webshops" in de kolom *Webshops* om dat te beperken.

## Dagelijks gebruik

- **Alle webshops:** per webshop een kaart met producten, voorraad, verkopen van vandaag en de status van de koppelingen. Daaronder één lijst met alle producten die bijna of al uitverkocht zijn, met de webshop erbij.
- **Tabblad per webshop:** de volledige productlijst, voorspellingen en grafieken van die webshop. Het getal op een tabblad is het aantal producten dat bijna of al uitverkocht is.

## Onderhoud

| Wat | Hoe |
|---|---|
| Nieuwe versie | gaat automatisch: Render installeert elke nieuwe versie van de branch |
| Webshop toevoegen of verwijderen | dashboard → **Webshops beheren** (een verwijderde webshop blijft als reservekopie op de schijf bewaard) |
| Logboek | dashboard → *Live activiteit*, of Render → service → **Logs** |
| Back-ups | elke dag automatisch op de opslagschijf, per webshop (14 dagen bewaard) |
| Wachtwoord beheerder kwijt | Render → service → **Shell** → `node scripts/user.js wachtwoord <e-mail>` |
| Stoppen | Render → service → **Settings** → *Suspend* (of *Delete* om alles te verwijderen) |

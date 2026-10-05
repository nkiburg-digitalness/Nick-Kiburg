# Voorraadbeheer voor meerdere webshops

Centraal voorraadbeheer voor **WooCommerce-webshops** en **Bol.com**, voor één of meer webshops in één dashboard (bijv. tochtstripdeur.nl en drie andere webshops):

- **Meerdere webshops, één dashboard** – een tab per webshop plus een overzicht *Alle webshops*. Elke webshop heeft een eigen voorraad, eigen koppelingen en een eigen database; ze zitten elkaar niet in de weg.
- **Real-time synchronisatie** – verkoopt u een artikel via Bol.com, dan wordt de voorraad in de webshop direct aangepast, en omgekeerd. Bol.com is per webshop optioneel.
- **Eén centrale voorraad per webshop** – het systeem is leidend; de webshop en Bol.com krijgen altijd dezelfde, actuele voorraad.
- **Uitverkoopvoorspelling** – per product: gemiddelde verkoop per dag, over hoeveel dagen het uitverkocht is, uiterste besteldatum en een besteladvies.
- **Live dashboard** – voorraad, synchronisatiestatus per kanaal, grafieken en een live activiteitenlog.
- **Voor het hele team** – eigen login per collega met een rol en, desgewenst, toegang tot alleen bepaalde webshops; bij elke mutatie staat wie hem heeft geboekt.
- **24/7 online** – draait op een server (niet op een laptop), met automatische herstart en dagelijkse back-up.

Geen externe afhankelijkheden: alleen Node.js 22.13 of hoger (met ingebouwde SQLite).

![Dashboard](docs/dashboard.png)

## Snel proberen (demo)

```bash
npm run demo
```

Open <http://localhost:3000> en log in met `demo@tochtstripdeur.nl` / `demo-wachtwoord` (staat ook op de inlogpagina). De demo vult vier voorbeeldwebshops (twee met Bol.com) met producten en 90 dagen verkoophistorie, en plaatst regelmatig gesimuleerde orders, zodat u de live-synchronisatie ziet. Er wordt niets naar Bol.com of de webshop gestuurd.

## Meerdere webshops

- **Alle webshops** (eerste tab): per webshop een kaart met producten, voorraad, verkopen van vandaag en de status van de koppelingen, plus één lijst met alles wat bijna of al uitverkocht is – met de webshop erbij.
- **Een tab per webshop**: de volledige productlijst, voorspellingen en grafieken van die webshop. Het getal op de tab = aantal producten dat bijna of al uitverkocht is.
- **Gescheiden**: elke webshop heeft een eigen database, eigen WooCommerce- en (optioneel) Bol.com-koppeling, een eigen webhook-adres en een eigen synchronisatie. Een storing of verkeerde sleutel bij de ene webshop raakt de andere niet.
- **Beheer** (menu → *Webshops beheren*): webshops toevoegen, sleutels invullen of vervangen, verbinding testen, Bol.com los- of aankoppelen. De sleutels worden versleuteld opgeslagen.

![Eén webshop](docs/webshop.png)

![Webshops beheren](docs/webshops-beheren.png)

## Hoe het werkt

```
 Bol.com  ──(orders ophalen, elke 60 s)──┐                ┌──(voorraad PUT)──▶ Bol.com
                                         ▼                │
                               Centrale voorraad (SQLite) ─┤  wachtrij met automatische herhaling
                                         ▲                │
 Webshop  ──(webhook, direct)────────────┘                └──(voorraad PUT)──▶ Webshop
          ──(vangnet: elke 5 min)
```

1. **Order binnen.** De webshop meldt nieuwe en gewijzigde orders direct via een webhook (met een vangnet-controle elke 5 minuten). Bol.com heeft geen order-webhooks; het systeem vraagt daarom elke 60 seconden nieuwe en gewijzigde orders op.
2. **Boeken in het grootboek.** Elke orderregel wordt precies één keer geboekt (dubbele meldingen worden herkend). Wordt een order geannuleerd, dan komt de voorraad automatisch terug.
3. **Doorzetten naar alle kanalen.** De nieuwe voorraad wordt naar Bol.com én de webshop gestuurd. Lukt dat niet (storing, rate limit), dan probeert het systeem het automatisch opnieuw met oplopende wachttijd. Meerdere verkopen kort na elkaar leveren één update op met de laatste stand.

Welke orders tellen mee?

| Kanaal | Telt als verkocht | Komt terug op voorraad |
|---|---|---|
| Webshop | status *In behandeling*, *In de wacht*, *Afgerond* | *Geannuleerd*, *Mislukt*, *In afwachting van betaling* (en *Terugbetaald* als `WOO_RESTOCK_ON_REFUND=true`) |
| Bol.com | elke (FBR-)orderregel: aantal − geannuleerd aantal | geannuleerde (deel)aantallen |

## De voorspelling

Voor elk product, over de gekozen periode (standaard 30 dagen, in te stellen op 7–90 dagen):

| | Berekening |
|---|---|
| **Gemiddelde verkoop per dag** | verkochte stuks (Bol.com + webshop) ÷ verkoopdagen |
| **Uitverkocht over** | huidige voorraad ÷ gemiddelde verkoop per dag |
| **Verwachte uitverkoopdatum** | vandaag + "uitverkocht over" |
| **Bestelpunt** | gemiddelde per dag × (levertijd + veiligheidsmarge) |
| **Bestellen vóór** | uitverkoopdatum − levertijd − veiligheidsmarge |
| **Besteladvies** | gemiddelde per dag × (levertijd + marge + 60 dagen) − voorraad |

- **Verkoopdagen**: dagen waarop het product uitverkocht was, tellen niet mee – anders lijkt een product langzamer te verkopen dan het doet. Nieuwe producten worden gemiddeld over de dagen dat ze bestaan (minimaal 7).
- **Status**: *Uitverkocht* (voorraad 0), *Nu bestellen* (uitverkocht binnen de levertijd), *Binnenkort bestellen* (binnen levertijd + marge), *Op voorraad*.
- **Trend**: de verkoop van de laatste 7 dagen vergeleken met het gemiddelde, zodat u ziet of een product aantrekt (bijv. in het stookseizoen).
- Levertijd en veiligheidsmarge stelt u per product in.

![Productdetail met voorraadverloop, prognose en verkopen per kanaal](docs/product-detail.png)

## Toegang voor collega's

Iedereen logt in met een eigen e-mailadres en wachtwoord, vanaf elke computer, tablet of telefoon.

| Rol | Mag |
|---|---|
| **Alleen bekijken** | voorraad, voorspellingen, grafieken en mutaties inzien |
| **Medewerker** | ook leveringen, voorraadtellingen en productgegevens boeken |
| **Beheerder** | ook collega's toevoegen/blokkeren, wachtwoorden resetten en producten verwijderen |

- **Eerste beheerder**: zet `ADMIN_EMAIL`, `ADMIN_NAME` en `ADMIN_PASSWORD` in `.env`; het account wordt bij de eerste start aangemaakt.
- **Collega toevoegen**: menu rechtsboven → *Gebruikers beheren* → naam, e-mail en rol. U krijgt een tijdelijk wachtwoord om door te geven; de collega wijzigt het via *Mijn account*.
- **Iemand vertrekt**: *Blokkeren* – de toegang stopt direct, ook op apparaten waar diegene nog ingelogd was. Eerder geboekte mutaties blijven bewaard.
- **Wachtwoord vergeten**: een beheerder klikt *Nieuw wachtwoord*. Is de enige beheerder het wachtwoord kwijt: `npm run gebruiker -- wachtwoord <e-mail>` op de server.

![Gebruikersbeheer](docs/gebruikers.png)

Beveiliging: wachtwoorden worden versleuteld (scrypt) opgeslagen, sessies lopen via een beveiligde cookie (30 dagen), na 8 foute pogingen volgt een pauze van 15 minuten, en verzoeken vanaf andere websites worden geweigerd.

## 24/7 online: hosting

Het systeem moet op een server draaien die altijd aan staat – niet op een laptop. Dan blijven de synchronisatie en het dashboard werken, ook 's nachts en in het weekend. De server moet via **HTTPS** bereikbaar zijn (bijv. `https://voorraad.digitalness.nl`), omdat WooCommerce daar zijn meldingen naartoe stuurt.

Wat er voor continu gebruik al in zit:

- **Automatisch herstarten** na een storing of herstart van de server (Docker `restart: unless-stopped` + health check).
- **Niets gemist na uitval**: gemiste Bol.com-orders worden per dag opgehaald, gemiste webshoporders via de vangnet-controle, en voorraadupdates die nog in de wachtrij stonden worden alsnog verstuurd.
- **Dagelijkse back-up** van de database (standaard 14 dagen bewaard, in `data/backups`, bij Docker in het volume onder `/data/backups`).

### Optie A: Render – zelf te regelen, geen serverbeheer (aanbevolen)

Alles via de website van Render, zonder commando's: het meegeleverde `render.yaml` stelt de server, de EU-regio (Frankfurt), de opslag en de back-ups automatisch in. $7,25 per maand voor al uw webshops samen (Starter-server $7 + 1 GB opslag $0,25; de Hobby-workspace is gratis). Volg **[docs/installatie-render.md](docs/installatie-render.md)**.

### Optie B: bestaande VPS met Plesk (bijv. Snel.com)

Draait de webshop op een VPS met Plesk en mag daar Docker op? Dan kan het voorraadbeheer naast de webshop draaien, op een eigen subdomein en begrensd in geheugen en processorkracht. Bij een managed VPS moet de hostingpartij hieraan meewerken. Volg **[docs/installatie-plesk.md](docs/installatie-plesk.md)**.

### Optie C: eigen server (VPS) met Docker

Een kleine VPS in Nederland/Duitsland (bijv. TransIP, Hetzner, DigitalOcean Amsterdam; ± €5–10 per maand, 1 GB geheugen is ruim voldoende), voor wie zelf een server kan beheren.

1. Maak een VPS aan met Ubuntu en installeer Docker (`curl -fsSL https://get.docker.com | sh`).
2. Laat een subdomein (bijv. `voorraad.digitalness.nl`) met een **A-record** naar het IP-adres van de server wijzen (bij uw domeinbeheerder).
3. Zet de code op de server, maak `.env` aan (`cp .env.example .env`) en vul `DOMAIN`, de beheerder en de koppelingen in.
4. Start: `docker compose up -d --build`

Caddy (zit in `docker-compose.yml`) regelt automatisch een gratis HTTPS-certificaat. Bijwerken naar een nieuwe versie: code verversen en opnieuw `docker compose up -d --build`.

Andere platforms (Railway, Fly.io) kunnen de `Dockerfile` ook draaien. Kies daar een **EU-regio**, koppel een **persistente schijf** op `/data` en draai precies **één** instantie.

Gewone webhosting (waar de WordPress-webshop op staat) is meestal niet geschikt, omdat daar geen programma continu kan draaien.

### Zonder Docker

```bash
cp .env.example .env      # en vul de gegevens in
npm start                 # laat dit draaien via bijv. systemd of pm2, achter een HTTPS-proxy (TRUST_PROXY=true)
```

## Installatie

### 1. Server

Zie [24/7 online: hosting](#247-online-hosting). Vul in `.env` in elk geval de eerste beheerder in (`ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`).

### 2. Webshops toevoegen en koppelen

In het dashboard: menu rechtsboven → **Webshops beheren** → **+ Webshop toevoegen**, per webshop:

1. **Naam, webadres en kleur.**
2. **WooCommerce-sleutels:** WooCommerce → **Instellingen → Geavanceerd → REST API** → sleutel toevoegen met rechten **Lezen/Schrijven**.
3. **Bol.com-sleutels (optioneel):** Partnerplatform → **Instellingen → API-instellingen** → Retailer API → credentials aanmaken. Producten worden aan Bol-orders gekoppeld via de **EAN**; het Bol **offer-ID** wordt bij de eerste Bol-order automatisch opgehaald (of vul het zelf in bij het product).
4. **Webhooks:** na het opslaan toont het dashboard per webshop een eigen Aflever-URL (`https://<uw-server>/webhooks/woocommerce/<webshop>`) en een eigen geheim. Maak daarmee in WooCommerce → **Instellingen → Geavanceerd → Webhooks** twee webhooks aan: **Order aangemaakt** en **Order bijgewerkt** (API-versie v3).
5. **Verbinding testen** controleert direct of de sleutels werken.

De sleutels worden versleuteld opgeslagen met `SECRET_KEY` en nooit meer teruggestuurd naar de browser. Zorg dat bij elk product in WooCommerce de **SKU** is ingevuld; "Voorraad beheren" wordt bij de eerste synchronisatie automatisch aangezet.

### 4. Producten inlezen en live gaan

Het makkelijkst via het dashboard: menu rechtsboven → **Importeren / exporteren** → kies de webshop:

1. **Producten uit webshop overnemen** (gekoppeld op SKU).
2. **Productlijst downloaden**, in Excel EAN, levertijd en veiligheidsmarge aanvullen, en als CSV weer **uploaden**.
3. **Verkoophistorie inlezen** (90 dagen, verandert de voorraad niet).

Of op de commandoregel:

```bash
# Optie A: alle producten (incl. variaties) uit de webshop overnemen, gekoppeld op SKU
npm run import -- <webshop-id> --woocommerce

# Optie B: een CSV-bestand (zie voorbeeld-producten.csv)
npm run import -- <webshop-id> producten.csv
```

Vul daarna per product de **EAN** (voor Bol.com), **levertijd** en **veiligheidsmarge** in – via het dashboard of de CSV. Controleer de voorraadstanden (een telling kan via het dashboard) en start de server: vanaf dat moment is deze voorraad leidend en wordt hij naar beide kanalen gestuurd.

```bash
# Optioneel: verkoophistorie van de afgelopen 90 dagen inlezen, zodat de voorspelling
# direct klopt. Dit verandert de voorraad niet.
npm run backfill -- <webshop-id>
```

Orders die vóór het live-gaan zijn geplaatst, tellen alleen mee als historie voor de voorspelling – ze zitten immers al in de ingevoerde voorraad.

## Dagelijks gebruik

- **Levering ontvangen**: open het product → *Levering ontvangen* → aantal. De nieuwe voorraad gaat direct naar beide kanalen.
- **Voorraadtelling / correctie**: open het product → *Voorraadtelling*; het verschil wordt als correctie geboekt.
- **Kanaal loopt achter?** De kolom *Kanalen* toont per kanaal de laatst doorgestuurde voorraad (✓ = gelijk aan de centrale voorraad). Met *Voorraad opnieuw naar kanalen sturen* forceert u een update.
- Elke mutatie staat met datum, kanaal en ordernummer in de mutatielijst van het product.

## CSV-kolommen

`sku` (verplicht), `name`, `ean`, `stock`, `lead_time_days`, `safety_days`, `woo_product_id`, `woo_variation_id`, `bol_offer_id`. Scheidingsteken `;` of `,`. Bestaande producten worden bijgewerkt; een ingevulde `stock` wordt als voorraadtelling geboekt.

## Goed om te weten

- **Webshopplatform**: de koppeling is voor **WooCommerce**. Voor een ander platform (bijv. Shopify of Lightspeed) is een extra koppeling nodig met dezelfde functies als `src/channels/woocommerce.js` (`pushStock`, orders boeken).
- **Webshops zijn gescheiden**: hetzelfde artikelnummer in twee webshops zijn twee aparte producten met elk een eigen voorraad. Een gedeelde voorraad tussen webshops wordt niet ondersteund.
- **Bol.com**: alleen **FBR**-orders (zelf verzenden) tellen standaard mee; FBB-voorraad ligt bij Bol zelf. Bol accepteert een voorraad van maximaal 999 per aanbieding.
- **Bol.com-vertraging**: omdat Bol.com geen order-webhooks biedt, duurt het maximaal ~60 seconden (`BOL_POLL_INTERVAL_SECONDS`) voordat een Bol-verkoop in de webshop zichtbaar is. Webshopverkopen staan binnen enkele seconden op Bol.com.
- **Overselling**: verkopen beide kanalen tegelijk het laatste stuk, dan kan de voorraad negatief worden; het dashboard toont dit in rood en beide kanalen krijgen 0.
- **Retouren** worden niet automatisch teruggeboekt (de staat van het artikel is onbekend); boek ze via *Levering ontvangen* of een telling.

## Ontwikkeling

```bash
npm test          # unit- en integratietests (Bol.com en WooCommerce API's gesimuleerd)
```

| Map | Inhoud |
|---|---|
| `src/shops.js` | webshops: instellingen (versleutelde sleutels) en per webshop een eigen database, koppelingen en synchronisatie |
| `src/inventory.js` | grootboek per webshop: verkopen, annuleringen, ontvangsten, tellingen |
| `src/forecast.js` | voorspelling (gemiddelde verkoop, dagen tot uitverkocht, besteladvies) |
| `src/sync.js` | wachtrij die voorraad naar de kanalen stuurt, met herhaalpogingen |
| `src/channels/bol.js` | Bol.com Retailer API (orders ophalen, voorraad bijwerken) |
| `src/channels/woocommerce.js` | WooCommerce REST API + webhooks |
| `src/server.js` | HTTP-API, login, webhook-endpoint per webshop en live-updates (Server-Sent Events) |
| `src/secrets.js` | versleuteling van de API-sleutels (AES-256-GCM) |
| `src/auth.js` | gebruikers, rollen, wachtwoorden en sessies |
| `src/backup.js` | dagelijkse back-up van de database |
| `public/` | dashboard |

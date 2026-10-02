# Installatie bij Render (zelf te regelen, zonder serverbeheer)

Met deze route heeft u geen eigen server of hulp van een hostingpartij nodig. [Render](https://render.com) draait het voorraadbeheer 24/7, regelt HTTPS en start het programma vanzelf opnieuw op als er iets misgaat. Alles gaat via de website van Render; u hoeft geen commando's te typen.

- **Kosten:** **$7,25 per maand** (prijzen per oktober 2026, exclusief btw):

  | Onderdeel | Prijs | Nodig | Per maand |
  |---|---|---|---|
  | Workspace *Hobby* | gratis | 1 Render-account is genoeg (collega's loggen in op het dashboard, niet bij Render) | $0 |
  | Server *Starter* (512 MB, 0,5 CPU, altijd aan) | $7 | 1 | $7,00 |
  | Opslag (persistent disk) | $0,25 per GB | 1 GB (database + 14 dagelijkse back-ups, ruim voldoende) | $0,25 |
  | Dataverkeer | 5 GB inbegrepen, daarna $0,15/GB | ± 0,3 GB (alles wordt gecomprimeerd) | $0 |
  | Build-minuten (installeren van updates) | 500 inbegrepen | enkele minuten per update | $0 |
  | Task runs / Workflows, databases, cron jobs | per gebruik | niet gebruikt | $0 |

  Render rekent per seconde af. Kies **niet** de gratis *Free*-server: die valt na 15 minuten zonder bezoek in slaap en haalt dan geen Bol.com-orders meer op.
- **Locatie:** Frankfurt (EU). Er worden geen klantgegevens opgeslagen, alleen ordernummers, artikelnummers en aantallen, plus de namen en e-mailadressen van uw collega's.
- **Webshop:** blijft gewoon bij Snel.com. Er verandert niets aan.

Reken voor de stappen hieronder op ongeveer een uur.

---

## Stap 1 – Account aanmaken en installeren (± 10 minuten)

1. Ga naar [render.com](https://render.com) en kies **Get Started**. Meld u aan **met GitHub**, met het account dat toegang heeft tot `nkiburg-digitalness/Nick-Kiburg`.
2. Voeg onder **Billing** een betaalmethode toe (nodig voor het Starter-abonnement en de opslag).
3. Kies rechtsboven **New → Blueprint**.
4. Koppel GitHub als daarom gevraagd wordt en geef Render toegang tot de repository **Nick-Kiburg**.
5. Kies de repository **Nick-Kiburg** en als branch **`claude/inventory-management-realtime-sync-axcymf`**. Render leest dan het bestand `render.yaml` en stelt alles zelf in: servertype, regio Frankfurt, opslag en back-ups.
6. Render vraagt een paar waarden in te vullen:
   - `ADMIN_EMAIL`: uw e-mailadres (hiermee logt u in)
   - `ADMIN_NAME`: uw naam
   - `ADMIN_PASSWORD`: een sterk wachtwoord van minimaal 10 tekens
   - `BOL_…` en `WOO_…`: **laat deze voor nu leeg**, die vult u in stap 4 in.
7. Klik **Apply**. Render bouwt en start het programma; dat duurt een paar minuten.
8. Open daarna de service **voorraadbeheer**. Bovenaan staat het webadres, bijv. `https://voorraadbeheer-xxxx.onrender.com`. Open het en log in. 🎉

## Stap 2 – Eigen webadres (optioneel, ± 10 minuten)

Wilt u `https://voorraad.tochtstripdeur.nl` gebruiken in plaats van het onrender.com-adres?

1. Render → service **voorraadbeheer** → **Settings** → **Custom Domains** → **Add** → `voorraad.tochtstripdeur.nl`. Render toont nu welk **CNAME-record** nodig is (het onrender.com-adres).
2. Voeg dat record toe waar de DNS van tochtstripdeur.nl wordt beheerd:
   - **In Plesk:** Websites & Domeinen → tochtstripdeur.nl → **DNS-instellingen** → **Record toevoegen** → type **CNAME**, domeinnaam `voorraad`, waarde `voorraadbeheer-xxxx.onrender.com`.
   - Kunt u de DNS niet zelf aanpassen? Vraag Snel.com dan alleen om dit ene CNAME-record toe te voegen. Dat is een standaardverzoek.
3. Klik in Render op **Verify**. Render regelt het HTTPS-certificaat automatisch; dat kan tot een uur duren.

## Stap 3 – Collega's toevoegen

Log in → menu rechtsboven → **Gebruikers beheren**. Zie de README, "Toegang voor collega's".

## Stap 4 – Bol.com en de webshop koppelen (± 20 minuten)

De sleutels vult u in bij Render → service **voorraadbeheer** → **Environment** → waarde aanpassen → **Save changes**. Render start het programma daarna vanzelf opnieuw.

**WooCommerce (webshop)**

1. WordPress-beheer → **WooCommerce → Instellingen → Geavanceerd → REST API → Sleutel toevoegen**: omschrijving "Voorraadbeheer", rechten **Lezen/Schrijven**.
2. Zet de *Consumer key* in `WOO_CONSUMER_KEY` en het *Consumer secret* in `WOO_CONSUMER_SECRET` (bij Render → Environment).
3. WordPress-beheer → **WooCommerce → Instellingen → Geavanceerd → Webhooks → Webhook toevoegen**, twee keer:

   | | Webhook 1 | Webhook 2 |
   |---|---|---|
   | Naam | Voorraad – order aangemaakt | Voorraad – order bijgewerkt |
   | Status | Actief | Actief |
   | Onderwerp | Order aangemaakt | Order bijgewerkt |
   | Aflever-URL | `https://voorraad.tochtstripdeur.nl/webhooks/woocommerce` | idem |
   | Geheim | de waarde van `WOO_WEBHOOK_SECRET` bij Render → Environment | idem |
   | API-versie | WP REST API Integration v3 | idem |

   (Geen eigen webadres ingesteld? Gebruik dan het onrender.com-adres in de Aflever-URL.)

**Bol.com**

1. Bol.com Partnerplatform → **Instellingen → API-instellingen** → Retailer API → **Credentials aanmaken**.
2. Zet de *Client ID* in `BOL_CLIENT_ID` en het *Client secret* in `BOL_CLIENT_SECRET`.

Bovenin het dashboard staan Bol.com en de webshop nu als **gekoppeld**, met het tijdstip van de laatste controle.

## Stap 5 – Producten inlezen en live gaan

Alles in het dashboard: menu rechtsboven → **Importeren / exporteren**.

1. **Producten uit webshop overnemen.** Haalt alle producten op en koppelt ze aan de webshop.
2. **Productlijst downloaden.** Open hem in Excel en vul per product aan:
   - de **EAN**: nodig om Bol.com-orders te herkennen;
   - de **levertijd** en **veiligheidsmarge** in dagen;
   - de juiste **voorraad**, als die afwijkt.

   Sla op als CSV en kies **CSV uploaden**.
3. **Verkoophistorie inlezen.** Leest 90 dagen aan orders in, zodat de voorspelling meteen klopt.

> **Let op:** vanaf het moment van koppelen is de voorraad in dit systeem **leidend**. Die voorraad wordt naar de webshop en (zodra het Bol-offer-ID bekend is) naar Bol.com gestuurd. Controleer dus vóór het koppelen of de voorraadstanden kloppen.

## Onderhoud

| Wat | Hoe |
|---|---|
| Nieuwe versie | gaat automatisch: Render installeert elke nieuwe versie van de branch |
| Logboek | dashboard → *Live activiteit*, of Render → service → **Logs** |
| Back-ups | elke dag automatisch op de opslagschijf (14 dagen bewaard) |
| Wachtwoord beheerder kwijt | Render → service → **Shell** → `node scripts/user.js wachtwoord <e-mail>` |
| Stoppen | Render → service → **Settings** → *Suspend* (of *Delete* om alles te verwijderen) |

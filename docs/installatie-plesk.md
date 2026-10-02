# Installatie op een VPS met Plesk (bijv. Snel.com)

Deze handleiding is voor een VPS met **Plesk**, waar de **webshop ook op draait**. Het voorraadbeheer komt er als apart, afgeschermd programma naast:

```
internet ──HTTPS──▶ Plesk (nginx) ──┬── tochtstripdeur.nl           → WordPress/WooCommerce (ongewijzigd)
                                    └── voorraad.tochtstripdeur.nl  → voorraadbeheer (Docker, alleen lokaal op 127.0.0.1:3000)
```

- **De webshop verandert niet.** Het voorraadbeheer krijgt een eigen subdomein en draait in een eigen container.
- **Het gebruikt maximaal 256 MB geheugen en een halve processorkern**, zodat de webshop er nooit last van heeft.
- **Plesk regelt het HTTPS-certificaat** (Let's Encrypt), zoals voor de webshop.
- **Het programma draait altijd door en start na een herstart van de server vanzelf op.**

> Waarom niet de Node.js-module van Plesk? Die zet programma's stil als er een tijdje niemand op het dashboard kijkt. Dan stopt ook het ophalen van Bol.com-orders. Docker blijft altijd draaien.

---

## Stap 1 – Subdomein aanmaken (zelf, in Plesk)

1. Plesk → **Websites & Domeinen** → **Subdomein toevoegen** → `voorraad` (bij `tochtstripdeur.nl`).
2. Na aanmaken: **SSL/TLS-certificaten** → **Let's Encrypt** → certificaat aanvragen voor `voorraad.tochtstripdeur.nl`.
3. **Hostinginstellingen** → vink *Permanente SEO-veilige 301-omleiding van HTTP naar HTTPS* aan.

Staat de DNS van tochtstripdeur.nl niet in Plesk maar bij uw domeinregistrar? Voeg daar dan een **A-record** toe voor `voorraad`, met hetzelfde IP-adres als de webshop.

## Stap 2 – Snel.com vragen om de installatie (managed VPS)

Bij een managed VPS installeert Snel.com de software. Stuur hun support het bericht hieronder. Vul eerst de map in waar de code komt; het voorstel staat al ingevuld.

> **Onderwerp:** Docker-container installeren naast Plesk voor voorraadbeheer
>
> Beste Snel.com-support,
>
> Wij willen op onze managed VPS (met Plesk) een klein intern programma laten draaien: een voorraadbeheersysteem dat onze WooCommerce-webshop en Bol.com synchroniseert. Het draait als Docker-container en is alleen lokaal bereikbaar op 127.0.0.1:3000; Plesk/nginx stuurt het subdomein voorraad.tochtstripdeur.nl ernaartoe. Kunnen jullie het volgende doen?
>
> 1. Docker Engine met de compose-plugin installeren (of de Plesk Docker-extensie), als die er nog niet is.
> 2. De code plaatsen in `/var/www/vhosts/tochtstripdeur.nl/voorraad-app` (buiten httpdocs), vanuit onze GitHub-repository `nkiburg-digitalness/Nick-Kiburg`, branch `claude/inventory-management-realtime-sync-axcymf`. Wij geven jullie een read-only deploy key (stuur ons daarvoor jullie publieke SSH-sleutel), of wij uploaden de code zelf als ZIP in die map.
> 3. Een datamap aanmaken: `mkdir -p /opt/voorraad-data && chown 1000:1000 /opt/voorraad-data` (neem deze map graag mee in de serverback-up).
> 4. Nadat wij het bestand `.env` in de app-map hebben gezet: in de app-map `docker compose -f docker-compose.plesk.yml up -d --build` uitvoeren.
> 5. Bij het subdomein voorraad.tochtstripdeur.nl onder *Apache & nginx-instellingen → Aanvullende nginx-richtlijnen* de inhoud van `deploy/plesk-nginx.conf` uit de repository plakken. Dat is een reverse proxy naar 127.0.0.1:3000, met buffering uit voor Server-Sent Events.
>
> De container is begrensd op 256 MB geheugen en 0,5 CPU, zodat de webshop er geen last van heeft. Is poort 3000 al in gebruik, dan kan dat met `VOORRAAD_PORT` in `.env` en de poort in de nginx-richtlijnen worden aangepast.
>
> Alvast bedankt!

## Stap 3 – Instellingen (`.env`) invullen (zelf)

Zet uw wachtwoorden en API-sleutels liever niet in een supportticket. Maak het bestand zelf aan:

1. Plesk → **Bestanden** → ga naar de map `voorraad-app` (naast `httpdocs`).
2. Kopieer `.env.example` naar `.env` en vul in:
   - `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`: uw eigen beheerdersaccount (wachtwoord minimaal 10 tekens).
   - `BOL_CLIENT_ID`, `BOL_CLIENT_SECRET`: uit het Bol.com Partnerplatform.
   - `WOO_BASE_URL=https://tochtstripdeur.nl`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET`, `WOO_WEBHOOK_SECRET`: zie de README, "WooCommerce koppelen".
   - `DOMAIN` mag leeg blijven (Plesk regelt het webadres).
3. Laat Snel.com weten dat `.env` klaarstaat (stap 4 uit het bericht).

## Stap 4 – Controleren en koppelen

1. Open `https://voorraad.tochtstripdeur.nl` en log in met uw beheerdersaccount.
2. Zet in `.env` de regel `ADMIN_PASSWORD=` daarna weer leeg. Het account bestaat dan al en het wachtwoord hoeft niet in het bestand te blijven staan.
3. WooCommerce-webhooks ("Order aangemaakt" en "Order bijgewerkt") laten wijzen naar
   `https://voorraad.tochtstripdeur.nl/webhooks/woocommerce`.
4. Producten inlezen en collega's toevoegen: zie de README ("Producten inlezen en live gaan" en "Toegang voor collega's").

Het inlezen van producten doet Snel.com (of iemand met SSH-toegang) in de app-map met:

```bash
docker compose -f docker-compose.plesk.yml exec -u node voorraad node --disable-warning=ExperimentalWarning scripts/import-csv.js --woocommerce
docker compose -f docker-compose.plesk.yml exec -u node voorraad node --disable-warning=ExperimentalWarning scripts/backfill.js
```

## Onderhoud

| Wat | Hoe |
|---|---|
| Nieuwe versie installeren | in de app-map: code bijwerken (`git pull`), dan `docker compose -f docker-compose.plesk.yml up -d --build` |
| Logboek bekijken | `docker logs --tail 200 voorraad` (of de activiteitenlijst in het dashboard) |
| Back-ups | automatisch elke dag in `/opt/voorraad-data/backups` (14 dagen bewaard) |
| Terugzetten van een back-up | container stoppen, `voorraad.db` vervangen door een back-upbestand, container starten |
| Wachtwoord beheerder kwijt | `docker compose -f docker-compose.plesk.yml exec -u node voorraad node scripts/user.js wachtwoord <e-mail>` |

## Alternatief zonder Docker

Wil of kan Snel.com geen Docker installeren, dan kan het programma ook als systemd-service draaien. Het gebruikt dan de Node.js-versie die Plesk al meelevert (versie 22 of hoger). Zie `deploy/voorraad.service`. De nginx-richtlijnen uit stap 2 blijven hetzelfde.

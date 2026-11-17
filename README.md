# Route Planner

Dit project helpt een pakketbezorger om afleverroutes te plannen. Je geeft een lijst met adressen op en kiest hoeveel ritten er nodig zijn of hoeveel chauffeurs beschikbaar zijn. Het programma controleert de adressen, verdeelt de leveringen over de chauffeurs en probeert het totale aantal gereden kilometers zo klein mogelijk te maken. Het resultaat bestaat uit kaarten en adressenlijsten in de juiste volgorde. Ook vergelijkt het programma de nieuwe routes met de bestaande routes, zodat je kunt zien of er kilometers worden bespaard.

Alle effectieve workflowstappen draaien in containers, inclusief de PowerShell-entrypoints. Scripts in `./scripts/` zijn dunne hostlaunchers: `setup.ps1` bouwt centraal alle benodigde containerimages en kan databereiding uitvoeren; `start.ps1` start de langlopende services zonder build of health-wait; de overige scripts voeren hun eenmalige workflowcontainer uit met vooraf gebouwde images. De host voert zelf geen workflow- of dataverwerkingslogica uit. De workflow plant pakketbezorging voor ongeveer 400 adressen en een lijst van ongeveer 10 chauffeurs. Per planning wordt óf het gewenste aantal ritten óf het aantal in te zetten chauffeurs opgegeven. Iedere geselecteerde chauffeur krijgt minstens één levering; het doel is de totale afstand over alle ritten te minimaliseren. Iedere chauffeur ontvangt een kaart van de toegewezen route op een OSM-achtergrondkaart en een adressenlijst in de juiste stopvolgorde. OSM-data en Valhalla-tegels worden in containers voorbereid of bijgewerkt buiten een normale planningsrun. Adresgeocodering is een aparte stap: OSM-routeringsdata zet adressen niet vanzelf om naar coördinaten.

## Invoerbestand

De planning ontvangt een puntkomma-gescheiden CSV met deze kolommen en volgorde:

```text
rit;naam;straat;nr.;postcode;gemeente;aantal;bellen;Opmerking;opmerking;klas
```

### Locatie en privacy

Nieuwe invoerversies worden opgeslagen op dit pad, relatief vanaf de repository-root en buiten de projectmap en Git-repository:

```text
../jdc.routePlanner-private-data/input/ritten-<UTC-tijdstempel>.csv
```

De map met private data mag geen onderdeel worden van deze repository of VS Code-workspace. De CSV-bestanden bevatten GDPR-gevoelige gegevens: kopieer ze niet naar de projectmap, testfixtures, logs of prompts. De adrescontrole krijgt de invoermap read-only; de API krijgt alleen deze invoermap schrijfbaar om het gekozen bestand op te slaan. Bewaar ook rapporten, kaarten en adressenlijsten met persoonsgegevens buiten de repository.

Open `http://routing.localtest.me` na het starten van de services en kies **Nieuwe versie**. Selecteer een UTF-8-CSV met een kopregel (maximaal 10 MB). Het bronbestand wordt uitsluitend lokaal in de browser gelezen; selecteer de vier adreskolommen en bekijk de eerste tien leveringen. Alleen de omgezette CSV wordt via de lokale API verzonden. Kolommen met exact overeenkomende namen uit het schema blijven behouden, inclusief `Opmerking` en `opmerking`; ontbrekende overige velden blijven leeg en niet-herkende kolommen worden niet meegenomen. Invoer met ontbrekende adresvelden of foutieve rijen wordt niet opgeslagen. Iedere opslag maakt atomair een nieuw bestand met een unieke UTC-sleutel in het formaat `yyyyMMddTHHmmssfffffffZ`; eerdere bestanden blijven behouden. De API geeft de beschikbare sleutels via `GET /api/versions`, gebaseerd op de invoerbestanden. Het menu toont de tijd in de lokale tijdzone en ook de exacte UTC-sleutel. Een bestaand `ritten.csv` verschijnt als **Bestaande invoer** met sleutel `legacy`, zonder migratie of wijziging.

De opslag start de adrescontrole niet. Kies de versie en klik bij Geocoding op **Voer nu uit...**. De API controleert of Photon beschikbaar is en vraagt de interne broker om de voorbereide `check-addresses`-container te starten. Na een geslaagde adrescontrole start de broker automatisch de aparte `extract-osm-geometry`-container. De taak blijft lopen totdat ook de geometrie is verwerkt; daarna wordt de review automatisch geladen. Er kan maar één automatische adrescontrole tegelijk lopen. Exitcode `2` van de adrescontrole betekent dat een rapport met te beoordelen adressen is gemaakt en de geometrie alsnog wordt opgehaald; fouten in de geocoder of geometrie-extractie worden gemeld en kunnen opnieuw worden geprobeerd. De status blijft via de containerstatus en het taakvolume beschikbaar na een API- of brokerherstart.

De geometriecontainer leest de lokale PBF uit `OSM_DATA_DIR` read-only en haalt alle OSM-ID's uit het geocodingrapport met `osmium getid` en `osmium export`. Referenties worden uit hetzelfde bestand opgehaald; er is geen netwerktoegang. Ze bewaart `osm-geometry-<sleutel>.geojson` naast het rapport in `OUTPUT_DATA_DIR` (voor `legacy`: `osm-geometry.geojson`). De lokale API levert dit via `GET /api/versions/<sleutel>/osm-geometry` en weigert een bestand dat niet bij het actuele rapport hoort. In `metadata` staan ontbrekende objecten en kandidaten zonder bruikbare OSM-ID, inclusief hun CSV-recordnummers. Een OSM-node blijft een punt; niet iedere node heeft een gekoppelde gebouwcontour. Niet-multipolygonrelaties en onvolledige of ontbrekende geometrieën worden als ontbrekend gemeld. De Photon-dump en de lokale PBF kunnen van verschillende momenten zijn. Handmatig later in Photon gevonden kandidaten zijn niet opgenomen in deze eerste extractie en kunnen daarom een ontbrekende contour tonen.

Voor een bestaande versie met een geocodingrapport kan de geometrie afzonderlijk worden gemaakt of na een PBF-update worden vernieuwd, zonder de review te vervangen:

```powershell
docker compose -f compose.yaml run --rm --no-deps -e CHECK_ADDRESSES_VERSION=20261117T1234561234567Z extract-osm-geometry
```

De adrescontrole kan ook handmatig met de sleutel uit het versiemenu worden gestart, bijvoorbeeld:

```powershell
./scripts/checkAddresses.ps1 -Version '20261117T1234561234567Z'
```

Zonder `-Version` controleert de launcher uitsluitend de oudere `legacy`-invoer. Kies daarna dezelfde versie in de website om haar geocodingreview te openen.

De API draait als niet-rootgebruiker en moet in de geconfigureerde `INPUT_DATA_DIR` bestanden kunnen aanmaken. De integratietests in `tests/InputCsv.Api.Tests.mjs` gebruiken Node.js 26.13.1 en een afzonderlijke API-container met uitsluitend tijdelijke, schrijfbare testmappen voor `/input`, `/source` en `/review`; koppel de echte privémappen nooit aan deze test. De testcontainer deelt het netwerk en dezelfde tijdelijke bind mounts voor `/input` en `/source`, en voert `node --test` uit. `tests/PhotonStub.mjs` biedt een lokale stub voor een geïsoleerde adrescontroletest.

De automatische start vereist toegang tot de Docker-daemon. Alleen `address-check-broker` krijgt `/var/run/docker.sock`; de API bereikt de broker via een apart intern netwerk, zonder gepubliceerde brokerpoort. De broker accepteert alleen geldige versies en controleert de Compose-project- en servicelabels voordat hij de vaste containers `jdc-route-planner-check-addresses-1` en `jdc-route-planner-extract-osm-geometry-1` start. Overschrijf daarom de Compose-projectnaam niet. De broker en de twee jobs delen uitsluitend het beheerde volume `address-check-jobs` voor de versiesleutel; beide jobs mounten dit read-only. `start.ps1` en `reviewAddresses.ps1` maken beide jobcontainers vooraf aan zonder deze te starten. Photon en de overige services blijven draaien na afloop.

**Beveiliging:** toegang tot de Docker-socket is in de praktijk gelijkwaardig aan beheerderstoegang tot de Docker-host, ook bij een niet-rootcontainer. Gebruik deze configuratie alleen op een vertrouwde lokale machine, scherm de lokale API af voor onbevoegden en publiceer de broker nooit extern. De socket moet lokaal op `/var/run/docker.sock` beschikbaar zijn. Docker Desktop gebruikt doorgaans socketgroep `0`; stel op Linux `DOCKER_SOCKET_GID` in op de numerieke groep die schrijfrechten op de socket heeft. Een externe Docker-daemon wordt niet ondersteund. De broker heeft geen directe toegang nodig tot de invoer- of rapportmappen.

De broker-integratietests in `tests/AddressCheckBroker.Tests.mjs` gebruiken een nep-Docker-socket en synthetische gegevens. Bouw hiervoor eerst de API-image en vervolgens `tests/Dockerfile.broker-tests`; die testimage gebruikt een Debian Node-build omdat Node in de niet-Alpine .NET-runtime moet kunnen draaien. Koppel nooit de echte Docker-socket aan deze test.

## Entrypoints

De namen hieronder zijn de container-entrypoints. `CheckAddresses`, `UpdateGeocodeDatabase` en de adresreview zijn geïmplementeerd; de overige entrypoints zijn nog voorstellen. Alle runtime-services staan samen in `compose.yaml`. De setup-jobs FetchOsm en UpdateGeocodeDatabase staan apart in `compose.setup.yaml`. Scripts in `./scripts/` zijn dunne hostlaunchers; het effectieve werk gebeurt in containers. `./scripts/setup.ps1` valideert en bouwt de runtime-images, haalt Traefik op, bouwt beide setup-jobs en controleert daarna het OSM-extract en de Photon-database. Setup start geen langlopende services. `./scripts/start.ps1` start Photon, de reviewwebsite, API en Traefik uit de hoofdstack met bestaande images; het voert geen build, pull of health-wait uit. De overige workflowlaunchers gebruiken eveneens uitsluitend vooraf gebouwde images. `./scripts/checkAddresses.ps1` start de adrescontrole met Photon uit de hoofdstack. `./scripts/reviewAddresses.ps1` start Photon en de reviewservices uit diezelfde stack. `./scripts/updateGeocodeDatabase.ps1` voert de database-updatejob uit `compose.setup.yaml` uit en stopt/herstart Photon zo nodig in `compose.yaml`.

| EntryPoint | Moment | Verantwoordelijkheid in de container |
| --- | --- | --- |
| `FetchOsm` | Eenmalig of bij handmatig verversen | Downloadt het Geofabrik België-extract dat West-Vlaanderen omvat, controleert de MD5 en bewaart de brondata in beheerde opslag. |
| `BuildValhallaTiles` | Eenmalig of na wijzigingen aan data/configuratie | Bouwt of ververst Valhalla-tegels uit het OSM-extract. |
| `UpdateGeocodeDatabase` | Eenmalig en bij een databaseresfresh | Downloadt de officiële Photon Europa-dump, controleert de checksum en importeert alleen landcode `BE` naar een nieuwe lokale database. |
| `CheckAddresses` | Voor iedere planning | Wordt handmatig of via API en interne broker per versie gestart. Valideert de exacte CSV-header en rijen en geocodeert via Photon op het interne Compose-netwerk; dedupliceert identieke aanvragen, herhaalt tijdelijke fouten begrensd en accepteert alleen unieke exacte adresmatches. Overige kandidaten en foutredenen komen in het rapport voor handmatige controle. |
| `extract-osm-geometry` | Na iedere adrescontrole | De Python-entrypoint haalt kandidaatobjecten en hun referenties uit de lokale PBF met Osmium en bewaart geometrieën en ontbrekende objecten als versiegebonden GeoJSON. De container heeft geen netwerktoegang. |
| `ReviewAddresses` | Na iedere geocodingrun | Toont het bronadres en Photon-kandidaten in een lokale Angular-website. De .NET API bewaart bevestigde kandidaatkeuzes en coördinaten, of een onopgeloste beslissing met notitie. |
| `CreateRoutes` | Voor iedere planning | Valideert de gekozen ritten- of chauffeursaantallen, gebruikt Valhalla-kosten om leveringen toe te wijzen en te ordenen, en maakt de definitieve routegegevens. Iedere geselecteerde chauffeur krijgt werk; de totale afstand wordt geminimaliseerd. |
| `CreateDriverOutputs` | Na het maken van de routes | Maakt per chauffeur een OSM-kaart van de route en een adressenlijst in de exacte stopvolgorde. |
| `CreateComparisonReport` | Na het maken van de routes | Groepeert de bestaande routes op `rit`, berekent hun afstanden met Valhalla en maakt een vergelijkingsrapport met een OSM-kaart van de bestaande routes, een aparte kaart van alle berekende routes, afstand per route, totalen en het afstandsverschil. |

Photon draait samen met de reviewwebsite, API en Traefik in `compose.yaml`. Het is alleen via Traefik bereikbaar op `http://photon.localtest.me`; de containerpoort wordt niet rechtstreeks op de host gepubliceerd. Adressen gaan daardoor niet naar de publieke Photon-API. De updater gebruikt de Europese Photon 1.x JSON-dump als bron, maar geeft bij import `-country-codes BE` mee; alleen Belgische gegevens worden in de actieve Photon-index gezet. De Europese dump is ongeveer 13,4 GB gecomprimeerd en staat, samen met de index, in beheerde opslag buiten de repository. Voor de eerste import is extra schijfruimte nodig voor de download en stagingdatabase. De update bouwt eerst een nieuwe index en wisselt die pas na een geslaagde import; de vorige index blijft beschikbaar voor rollback.

`./scripts/fetchOsm.ps1` start de `fetch-osm`-service uit `compose.setup.yaml`. Dezelfde setup-stack bevat de Photon-database-updatejob onder het profiel `maintenance`. De OSM-container downloadt bij iedere handmatige start de nieuwste Geofabrik België-PBF (`https://download.geofabrik.de/europe/belgium-latest.osm.pbf`), verifieert de gepubliceerde MD5 en vervangt de bestaande extract pas na een geslaagde controle. Dit extract dekt heel België en daarmee West-Vlaanderen; het kan dus groter zijn dan het servicegebied. De PBF en `fetch-metadata.json` worden buiten de repository opgeslagen in `../jdc.routePlanner-private-data/osm`; `OSM_DATA_DIR` kan dit pad aanpassen. Downloaden van de brondata bouwt geen Valhalla-tegels. OSM-data © OpenStreetMap contributors, beschikbaar onder de ODbL; zie https://www.openstreetmap.org/copyright.

De Photon-updater logt de huidige fase naar de containeruitvoer. Tijdens downloaden toont `curl` een percentagebalk; tijdens het importeren toont `pv` elke vijf seconden een percentagebalk naar stderr, die Docker ook in de containerlogs verzamelt. Dit meet de invoerstroom, niet de interne indexeringsfase van OpenSearch. Bekijk de uitvoer van `./scripts/updateGeocodeDatabase.ps1` of `docker compose --profile maintenance -f compose.setup.yaml logs -f update-geocode-database` om voortgang te volgen.

De adrescontrole gebruikt de gedeelde PowerShell-base-image uit `containers/powershell/Dockerfile`: Alpine 3.24.3 met de officiële PowerShell 7.6.6 musl-x64-archive. De SHA256 wordt vóór installatie gecontroleerd. De base ondersteunt momenteel `amd64`. De Photon-container gebruikt ook Alpine 3.24.3, met Bash en Java 21; de Photon-entrypoint is `containers/photon/entrypoint.sh`.

Voer eerst `./scripts/setup.ps1` uit. Setup bouwt alle images uit `compose.yaml` en `compose.setup.yaml`, haalt de Traefik-image op en controleert daarna het OSM-extract en de Belgische Photon-index. Ontbrekende datasets worden automatisch opgehaald; bestaande datasets blijven zonder prompt behouden. Gebruik `./scripts/setup.ps1 --force` (of PowerShell-native `./scripts/setup.ps1 -Force`) om bestaande OSM- en Photondata te verversen. Setup start geen services. `./scripts/start.ps1` start Photon, de reviewwebsite, API en Traefik samen uit `compose.yaml` met `--no-build --pull never --detach`, zonder op healthchecks te wachten. De overige scripts bouwen of pullen geen images; voer setup opnieuw uit als een image is gewijzigd. `./scripts/checkAddresses.ps1 -Version <sleutel>` wacht wel op een gezonde Photon-service voordat de adrescontrole wordt uitgevoerd en stopt Photon na afloop als deze launcher hem zelf heeft gestart. De input wordt read-only gemount vanaf `../jdc.routePlanner-private-data/input`; het rapport wordt geschreven naar `../jdc.routePlanner-private-data/output/address-check-<sleutel>.json`. De oudere `legacy`-versie gebruikt `ritten.csv` en `address-check.json`. Deze paden zijn relatief aan de repository-root en kunnen met `INPUT_DATA_DIR`, `OUTPUT_DATA_DIR` en `GEOCODER_DATA_DIR` worden aangepast. De exitcode van de adrescontrole is `0` wanneer alle adressen eenduidig zijn gevonden, `2` bij ongeldige/onopgeloste/ambigue records en `3` bij een geocoderfout. Configuratie- en inputfouten geven exitcode `1`.

Voer na `./scripts/checkAddresses.ps1` `./scripts/reviewAddresses.ps1` uit. De website is beschikbaar op `http://routing.localtest.me`, de API op `http://routing-api.localtest.me` en Photon op `http://photon.localtest.me`. Traefik gebruikt een statische configuratie zonder Docker-socket en publiceert alleen op `127.0.0.1:80`; `localtest.me` resolveert naar localhost. Poort 80 moet vrij zijn. De API leest het geocodingrapport read-only, schrijft de invoer in de apart gemounte invoermap en bewaart de review in de beheerde Docker-volume `jdc-route-planner-review-data`. Per versie staat de review daar als `/review/address-review-<sleutel>.json`; voor `legacy` blijft dit `/review/address-review.json`. Eerdere reviews worden gearchiveerd wanneer het bijbehorende bronrapport of de CSV verandert. Nieuwe geocodingrapporten bevatten een SHA-256 van de invoer, zodat review van een verouderd rapport wordt geweigerd. Oudere rapporten zonder hash worden gecontroleerd op basis van bestandswijzigingstijden. De CSV-rij is de enige reviewidentiteit binnen een versie; `rit` wordt niet als sleutel of reviewlabel gebruikt omdat routegroepen later kunnen wijzigen. De review bevat per CSV-rij de beslissing, gekozen kandidaat en bevestigde coördinaten. Records die onopgelost blijven blokkeren de volgende planningsstap. Latere plannercontainers moeten deze volume read-only mounten en alleen geaccepteerde records gebruiken.

Na een volledig afgeronde review toont **Routeplanning** met OpenLayers alle bevestigde leverlocaties en beschikbare lokale objectcontouren op een OpenStreetMap-kaart. Samenvallende locaties worden gegroepeerd en zijn aanklikbaar; ontbrekende coördinaten en contouren worden gemeld. Dit is een locatieoverzicht, nog geen routeberekening. De achtergrondtegels komen momenteel rechtstreeks van de publieke OpenStreetMap-tegelserver, niet uit de lokale PBF; de browser deelt daarbij zijn IP-adres en het bekeken kaartgebied met die server. De adressen en coördinaten zelf worden niet als adreszoekopdracht verzonden. Voor volledig lokale kaartweergave is een eigen tegelservice nodig.

De geometriecontainer gebruikt Ubuntu 24.04 met `python3` en `osmium-tool`, omdat de gewenste Osmium-binary niet als `osmium-tool`-pakket in de bestaande Alpine 3.24-pakketindex beschikbaar is. De aparte Python-entrypoint verwerkt alleen de geselecteerde kandidaatobjecten; de PBF wordt hierbij gelezen maar niet aangepast. De Osmium-extractie kan bij veel of complexe relaties tijdelijk ruimte in `/tmp` nodig hebben. De synthetische test `tests/ExtractOsmGeometry.Tests.py` gebruikt een zelfgemaakte PBF en vereist geen netwerk of privégegevens.

De reviewwebsite gebruikt Angular 21 en Node.js 26.13.1. Open de repository in de `.devcontainer`; npm-installatie en Angular-ontwikkeling draaien daar, niet op de host. De API target .NET 11. De officiële .NET 11-images zijn voor deze runtime niet als Alpine-tags gepubliceerd; daarom gebruikt de API de gepinde `11.0.100-resolute-amd64` SDK- en `11.0.0-resolute-amd64` runtime-images.

De rijvolgorde binnen iedere bestaande `rit`-groep geldt als de stopvolgorde voor de baseline, omdat de CSV geen aparte stopvolgordekolom bevat. Beide plannen moeten met dezelfde Valhalla-versie, tegels, costing-profiel en regels voor start- en eindpunten worden doorgerekend. Zo is het verschil in totale kilometers vergelijkbaar.

```mermaid
flowchart TD
	subgraph DataPrep["Eenmalig of periodiek: routeringsdata"]
		S0["Host start ./scripts/setup.ps1"] --> B0["Valideer de hoofdstack; build alle images en pull Traefik"]
		B0 --> B0b["Build FetchOsm- en UpdateGeocodeDatabase-images in compose.setup.yaml"]
		B0 --> E8["Container controleert of OSM-extract bestaat en toont de datum"]
		S1["Host start ./scripts/fetchOsm.ps1"] --> A["Setup-stack voert fetch uit met vooraf gebouwd image"]
		A --> B1["OSM-container downloadt extract"]
		B1 --> B["Container bouwt en beheert Valhalla-tegels"]
		S2["Host start ./scripts/updateGeocodeDatabase.ps1"] --> C2["Setup-stack voert updater uit; runtime-Photon wordt beheerd in compose.yaml"]
		C2 --> D2["Download Photon Europa-dump en controleer checksum"]
		D2 --> E2["Importeer alleen BE naar stagingdatabase; wissel na succes"]
		E8 --> E9{"OSM-extract bestaat?"}
		E9 -- "Nee" --> S1
		E9 -- "Ja" --> E10{"Nieuwste extract downloaden?"}
		E10 -- "Ja" --> S1
		E10 -- "Nee" --> E3["Container controleert of de Photon-index bestaat en toont de datum"]
		B --> E3
		E3 --> E4{"Index bestaat?"}
		E4 -- "Nee" --> C2
		E4 -- "Ja" --> E5{"Bijwerken?"}
		E5 -- "Ja" --> C2
		E5 -- "Nee" --> E6["Behoud bestaande index"]
		E2 --> S4["Host start ./scripts/start.ps1"]
		E6 --> S4
		S4 --> S5["Start Photon, web, API en Traefik zonder build of health-wait"]
	end

	subgraph Planning["Per planningsrun"]
		V["Gebruiker kiest een versie of Nieuwe versie"] --> VV{"Nieuwe versie?"}
		VV -- Ja --> U["Browser leest nieuwe bron-CSV lokaal, toont preview en zet gekozen kolommen om"]
		VV -- Nee --> B1a
		U --> U1["API bewaart nieuwe CSV met unieke UTC-versiesleutel"]
		U1 --> B1a["Gebruiker start adrescontrole vanuit de wizard"]
		B1a --> B1b["API controleert Photon; interne broker start voorbereide container"]
		B1b --> F
		S["Host start een dunne planner-launcher"] --> C1["Launcher voert docker compose up uit"]
		C1 --> C["PowerShell-plannercontainer leest adressen, chauffeurs en aantallen in"]
		C --> D["Invoer en aantallen valideren in container"]
		D --> E{"Adressen al coördinaten?"}
		E -- Nee --> F["Adrescontrolecontainer verwerkt gekozen versie via Photon"]
		E -- Ja --> G["Locaties vaststellen"]
		F --> GEO["Aparte Python-container haalt kandidaatobjecten uit lokale OSM-PBF"]
		GEO --> GEO2["Bewaar versiegebonden GeoJSON en ontbrekende objecten"]
		GEO2 --> G
		G --> R["API meldt taakstatus; gebruiker beoordeelt Photon-resultaten op routing.localtest.me"]
		R --> R2["Review API bewaart review per versiesleutel buiten de repository"]
		R2 --> R3["OpenLayers toont bevestigde locaties en lokale contouren op OSM-kaart"]
		R3 --> H
		H --> I["Plannercontainer start benodigde services en controleert gereedheid"]
		I --> J["Valhalla-container berekent afstanden van bestaande ritten per rit-kolom"]
		I --> K["Valhalla-container levert kosten voor de optimalisatie"]
		K --> L["Plannercontainer plant ritten: iedere chauffeur werk en totale km minimaal"]
		L --> N["Valhalla-container maakt berekende routes; plannercontainer valideert plan"]
		N --> O["Plannercontainer maakt per chauffeur een OSM-kaart en adressenlijst in stopvolgorde"]
		J --> P["Plannercontainer maakt vergelijkingsrapport: beide kaarten, km per route, totalen en verschil"]
		N --> P
		O --> P
		P --> M["Plannercontainer rapporteert resultaat en stopt alleen gestarte services"]
	end

	B -. "beschikbare tegels" .-> H
	E2 -. "actieve Belgische Photon-index" .-> F
	B1 -. "lokale OSM-PBF" .-> GEO
	S5 -. "Photon bereikbaar op photon.localtest.me" .-> F
```

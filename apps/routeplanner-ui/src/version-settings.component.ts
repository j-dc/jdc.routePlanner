import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from './environment';

interface StartLocation { label: string; latitude: number; longitude: number; [field: string]: unknown; }
interface SettingRow { key: string; value: string; saved: string; busy: boolean; }
interface MatrixStatus { state: 'idle' | 'running' | 'busy' | 'completed' | 'failed' | 'stale'; message?: string; }
interface PdfStatus { state: 'idle' | 'running' | 'busy' | 'completed' | 'failed'; message?: string; outputDirectory?: string; }
interface RoutePlan {
  metadata: { actualDifferenceSeconds: number };
  totalDistanceMeters: number;
  routes: { driver: number | string; durationSeconds: number; serviceDurationSeconds: number; totalDurationSeconds: number;
    reloadDurationSeconds: number; distanceMeters: number;
    stops: { csvRecordNumber: number }[];
    trips: { packageCount: number; stops: { csvRecordNumber: number }[] }[] }[];
}
interface RouteResult extends RoutePlan {
  oldRoutePlan?: RoutePlan & { unassignedRecords: number[] };
}

@Component({
  selector: 'app-version-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="settings" aria-labelledby="settings-title">
      <h2 id="settings-title">Instellingen</h2>
      <div class="start-location">
        <h3>Startlocatie</h3>
        <p class="settings-current" *ngIf="startLocation as start; else noStart">
          <strong>{{ start.label }}</strong>
          <span>{{ start.latitude | number:'1.5-6' }}, {{ start.longitude | number:'1.5-6' }}</span>
          <button type="button" class="danger" (click)="clearStart()" [disabled]="startBusy">Verwijderen</button>
        </p>
        <ng-template #noStart><p class="settings-empty">Nog geen startlocatie ingesteld.</p></ng-template>
        <form class="settings-add" (ngSubmit)="searchStart()">
          <input name="start-query" type="search" placeholder="Zoek adres in Photon" minlength="3" maxlength="200" [(ngModel)]="startQuery" aria-label="Zoek startlocatie">
          <button type="submit" [disabled]="startQuery.trim().length < 3 || startBusy">{{ startBusy ? 'Bezig…' : 'Zoek' }}</button>
        </form>
        <p class="settings-empty" *ngIf="startSearched && !startResults.length">Geen resultaten gevonden.</p>
        <ul class="settings-list" *ngIf="startResults.length">
          <li class="start-result" *ngFor="let result of startResults">
            <span>{{ result.label }}</span>
            <button type="button" (click)="chooseStart(result)" [disabled]="startBusy">Kies</button>
          </li>
        </ul>
      </div>
      <p class="settings-error" *ngIf="error" role="alert">{{ error }}</p>
      <ul class="settings-list">
        <li>
          <label for="setting-nmbDrivers">Aantal Chauffeurs</label>
          <input id="setting-nmbDrivers" type="text" inputmode="numeric" maxlength="1000" [(ngModel)]="drivers.value" [disabled]="loading || !settingsLoaded || drivers.busy">
          <button type="button" (click)="save(drivers)" [disabled]="loading || !settingsLoaded || drivers.busy || drivers.value === drivers.saved || !validDriverCount">Opslaan</button>
        </li>
        <li>
          <label for="setting-serviceSeconds">LeverTijd (sec)</label>
          <input id="setting-serviceSeconds" type="text" inputmode="numeric" maxlength="1000" [(ngModel)]="serviceSeconds.value" [disabled]="loading || !settingsLoaded || serviceSeconds.busy">
          <button type="button" (click)="save(serviceSeconds)" [disabled]="loading || !settingsLoaded || serviceSeconds.busy || serviceSeconds.value === serviceSeconds.saved || !validServiceSeconds">Opslaan</button>
        </li>
        <li>
          <label for="setting-Capacity">Capaciteit</label>
          <input id="setting-Capacity" type="text" inputmode="numeric" maxlength="1000" [(ngModel)]="capacity.value" [disabled]="loading || !settingsLoaded || capacity.busy">
          <button type="button" (click)="save(capacity)" [disabled]="loading || !settingsLoaded || capacity.busy || capacity.value === capacity.saved || !validCapacity">Opslaan</button>
        </li>
        <li>
          <label for="setting-reloadSeconds">Laadtijd depot (sec)</label>
          <input id="setting-reloadSeconds" type="text" inputmode="numeric" maxlength="1000" [(ngModel)]="reloadSeconds.value" [disabled]="loading || !settingsLoaded || reloadSeconds.busy">
          <button type="button" (click)="save(reloadSeconds)" [disabled]="loading || !settingsLoaded || reloadSeconds.busy || reloadSeconds.value === reloadSeconds.saved || !validReloadSeconds">Opslaan</button>
        </li>
        <li>
          <label for="setting-maxDifferenceMinutes">Maximaal tijdsverschil (min)</label>
          <input id="setting-maxDifferenceMinutes" type="text" inputmode="numeric" maxlength="1000" [(ngModel)]="maxDifferenceMinutes.value" [disabled]="loading || !settingsLoaded || maxDifferenceMinutes.busy">
          <button type="button" (click)="save(maxDifferenceMinutes)" [disabled]="loading || !settingsLoaded || maxDifferenceMinutes.busy || maxDifferenceMinutes.value === maxDifferenceMinutes.saved || !validMaxDifferenceMinutes">Opslaan</button>
        </li>
      </ul>
      <p class="settings-error" *ngIf="drivers.value && !validDriverCount">Vul een positief geheel aantal chauffeurs in.</p>
      <p class="settings-error" *ngIf="!validServiceSeconds && settingsLoaded">Vul een positief geheel aantal seconden in (maximaal 2147483647).</p>
      <p class="settings-error" *ngIf="!validCapacity && settingsLoaded">Vul een positief geheel getal voor de capaciteit in (maximaal 2147483647).</p>
      <p class="settings-error" *ngIf="!validReloadSeconds && settingsLoaded">Vul een niet-negatief geheel aantal seconden laadtijd in (maximaal 2147483647).</p>
      <p class="settings-error" *ngIf="!validMaxDifferenceMinutes && settingsLoaded">Vul een niet-negatief geheel tijdsverschil in minuten in (maximaal 2147483647).</p>
      <p class="settings-empty">Capaciteit is het maximum aantal pakketten per rit. Laadtijd geldt bij tussentijdse terugkeer naar het depot.</p>
    </section>
    <section class="settings" aria-labelledby="route-calculation-title">
      <h2 id="route-calculation-title">Routeberekening</h2>
      <div class="calculation-actions">
        <button type="button" (click)="calculateMatrix()" [disabled]="!settingsLoaded || !startLocation || startBusy || matrixBusy || matrixState === null || matrixState === 'running' || matrixState === 'busy'">{{ matrixState === 'running' || matrixBusy ? 'Bezig…' : 'Bereken Matrix' }}</button>
        <button type="button" (click)="calculateRoute()" [disabled]="routeBusy || routeState === null || routeState === 'running' || routeState === 'busy'">{{ routeState === 'running' || routeBusy ? 'Bezig…' : 'Bereken route' }}</button>
        <button type="button" (click)="renderRouteMaps()" [disabled]="!routeResult || mapBusy || mapState === null || mapState === 'running' || mapState === 'busy'">{{ mapState === 'running' || mapBusy ? 'Bezig…' : 'Render route kaarten' }}</button>
        <button type="button" (click)="createPdfs()" [disabled]="!routeResult || pdfBusy || pdfState === null || pdfState === 'running' || pdfState === 'busy'">Maak chauffeur-PDF's</button>
      </div>
      <p class="settings-empty" *ngIf="settingsLoaded && !startLocation">Stel eerst een startlocatie in om de matrix te berekenen.</p>
      <p class="settings-error" *ngIf="matrixMessage" role="alert">{{ matrixMessage }}</p>
      <p class="settings-empty" *ngIf="matrixState === 'running'">Matrixberekening loopt.</p>
      <p class="settings-empty" *ngIf="matrixState === 'busy'">Een matrixberekening voor een andere versie loopt.</p>
      <p class="settings-empty" *ngIf="matrixState === 'completed'">Matrixberekening voltooid.</p>
      <p class="settings-error" *ngIf="routeMessage" role="alert">{{ routeMessage }}</p>
      <p class="settings-empty" *ngIf="routeState === 'running'">Routeberekening loopt.</p>
      <p class="settings-empty" *ngIf="routeState === 'busy'">Een routeberekening voor een andere versie loopt.</p>
      <p class="settings-error" *ngIf="mapMessage" role="alert">{{ mapMessage }}</p>
      <p class="settings-empty" *ngIf="mapState === 'running'">Routekaarten worden gerenderd.</p>
      <p class="settings-empty" *ngIf="mapState === 'busy'">Routekaarten voor een andere versie worden gerenderd.</p>
      <p class="settings-empty" *ngIf="mapState === 'completed'">Routekaarten staan in de uitvoermap: {{ version }}/route-maps. Maak ze opnieuw na wijzigingen aan de planning.</p>
      <p class="settings-error" *ngIf="pdfMessage" role="alert">{{ pdfMessage }}</p>
      <p class="settings-empty" *ngIf="pdfState === 'running'">Chauffeur-PDF's worden gemaakt.</p>
      <p class="settings-empty" *ngIf="pdfState === 'busy'">PDF's voor een andere versie worden gemaakt.</p>
      <p class="settings-empty" *ngIf="pdfState === 'completed' && pdfOutputDirectory">Laatst gemaakte PDF's in de uitvoermap: {{ pdfOutputDirectory }}. Maak ze opnieuw na wijzigingen aan de planning.</p>
      <div *ngIf="routeResult as result">
        <h3>Nieuwe route indeling</h3>
        <ng-container *ngTemplateOutlet="routeOverview; context: { $implicit: result }"></ng-container>
        <div *ngIf="result.oldRoutePlan as oldPlan">
          <h3>Oude route indeling</h3>
          <p class="settings-error" *ngIf="oldPlan.unassignedRecords.length">
            Deze oude indeling is onvolledig: geen RIT ingevuld voor CSV-records {{ oldPlan.unassignedRecords.join(', ') }}.
          </p>
          <ng-container *ngTemplateOutlet="routeOverview; context: { $implicit: oldPlan }"></ng-container>
        </div>
      </div>
      <ng-template #routeOverview let-plan>
        <p>Totale afstand: {{ plan.totalDistanceMeters / 1000 | number:'1.1-1' }} km.
          Totale duur (som chauffeurs): {{ totalDurationSeconds(plan) / 60 | number:'1.0-1' }} minuten.
          Verschil in totale duur: {{ plan.metadata.actualDifferenceSeconds / 60 | number:'1.0-1' }} minuten.</p>
        <ul>
          <li *ngFor="let route of plan.routes">
            Chauffeur {{ route.driver }}: {{ route.stops.length }} leveringen, {{ route.trips.length }} ritten,
            {{ route.totalDurationSeconds / 60 | number:'1.0-1' }} minuten totaal
            ({{ route.durationSeconds / 60 | number:'1.0-1' }} rijden +
            {{ route.serviceDurationSeconds / 60 | number:'1.0-1' }} leveren +
            {{ route.reloadDurationSeconds / 60 | number:'1.0-1' }} herladen),
            {{ route.distanceMeters / 1000 | number:'1.1-1' }} km.
            <ul>
              <li *ngFor="let trip of route.trips; let index = index">
                Rit {{ index + 1 }} ({{ trip.packageCount }} pakketten):
                <span *ngFor="let stop of trip.stops; let last = last">{{ stop.csvRecordNumber }}{{ last ? '' : ', ' }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </ng-template>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .settings { margin-top: 24px; padding: 18px; border: 1px solid var(--line); background: var(--surface); }
    h2 { margin: 0 0 12px; color: var(--ink); font-size: 19px; }
    h3 { margin: 16px 0 8px; color: var(--ink); font-size: 15px; }
    .settings-current { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 13px; }
    .start-result { grid-template-columns: minmax(0, 1fr) auto !important; font-size: 13px; }
    .settings-list { margin: 0 0 14px; padding: 0; list-style: none; }
    .settings-list li, .settings-add { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr) auto auto; gap: 8px; align-items: center; margin-bottom: 8px; }
    .settings-add { grid-template-columns: minmax(120px, 200px) minmax(0, 1fr) auto; }
    .calculation-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    label { color: var(--muted); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
    input { min-height: 34px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 5px; }
    button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--forest); border-radius: 5px; background: var(--forest); color: white; font-weight: 700; }
    button.danger { background: white; color: var(--red); border-color: var(--red); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .settings-error { padding: 10px 12px; color: var(--red); background: var(--red-pale); font-size: 13px; }
    .settings-empty { color: var(--muted); font-size: 13px; }
  `]
})
export class VersionSettingsComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) version = '';
  @Output() routeAvailabilityChange = new EventEmitter<boolean>();
  drivers: SettingRow = { key: 'nmbDrivers', value: '', saved: '', busy: false };
  serviceSeconds: SettingRow = { key: 'serviceSeconds', value: '60', saved: '', busy: false };
  capacity: SettingRow = { key: 'Capacity', value: '60', saved: '', busy: false };
  reloadSeconds: SettingRow = { key: 'reloadSeconds', value: '10', saved: '', busy: false };
  maxDifferenceMinutes: SettingRow = { key: 'maxDifferenceMinutes', value: '30', saved: '', busy: false };
  settingsLoaded = false;
  startLocation: StartLocation | null = null;
  startQuery = '';
  startResults: StartLocation[] = [];
  startSearched = false;
  startBusy = false;
  loading = false;
  error = '';
  matrixBusy = false;
  matrixState: MatrixStatus['state'] | null = null;
  matrixMessage = '';
  routeBusy = false;
  routeState: MatrixStatus['state'] | null = null;
  routeResult: RouteResult | null = null;
  routeMessage = '';
  mapBusy = false;
  mapState: PdfStatus['state'] | null = null;
  mapMessage = '';
  pdfBusy = false;
  pdfState: PdfStatus['state'] | null = null;
  pdfMessage = '';
  pdfOutputDirectory = '';
  private readonly http = inject(HttpClient);
  private matrixTimer: ReturnType<typeof setTimeout> | undefined;
  private matrixGeneration = 0;
  private routeTimer: ReturnType<typeof setTimeout> | undefined;
  private routeGeneration = 0;
  private mapTimer: ReturnType<typeof setTimeout> | undefined;
  private mapGeneration = 0;
  private pdfTimer: ReturnType<typeof setTimeout> | undefined;
  private pdfGeneration = 0;
  private get url(): string { return `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/settings`; }
  totalDurationSeconds(plan: RoutePlan): number {
    return plan.routes.reduce((total, route) => total + route.totalDurationSeconds, 0);
  }
  get validDriverCount(): boolean { return /^0*[1-9][0-9]*$/.test(this.drivers.value); }
  get validServiceSeconds(): boolean {
    return /^0*[1-9][0-9]*$/.test(this.serviceSeconds.value) && Number(this.serviceSeconds.value) <= 2147483647;
  }
  get validCapacity(): boolean {
    return /^0*[1-9][0-9]*$/.test(this.capacity.value) && Number(this.capacity.value) <= 2147483647;
  }
  get validReloadSeconds(): boolean {
    return /^[0-9]+$/.test(this.reloadSeconds.value) && Number(this.reloadSeconds.value) <= 2147483647;
  }
  get validMaxDifferenceMinutes(): boolean {
    return /^[0-9]+$/.test(this.maxDifferenceMinutes.value) && Number(this.maxDifferenceMinutes.value) <= 2147483647;
  }

  ngOnChanges(): void {
    this.routeAvailabilityChange.emit(false);
    this.drivers = { key: 'nmbDrivers', value: '', saved: '', busy: false };
    this.serviceSeconds = { key: 'serviceSeconds', value: '60', saved: '', busy: false };
    this.capacity = { key: 'Capacity', value: '60', saved: '', busy: false };
    this.reloadSeconds = { key: 'reloadSeconds', value: '10', saved: '', busy: false };
    this.maxDifferenceMinutes = { key: 'maxDifferenceMinutes', value: '30', saved: '', busy: false };
    this.settingsLoaded = false;
    this.loading = false;
    this.startLocation = null;
    this.startResults = [];
    this.startSearched = false;
    this.startQuery = '';
    this.error = '';
    this.matrixBusy = false;
    this.matrixState = null;
    this.matrixMessage = '';
    this.routeBusy = false;
    this.routeState = null;
    this.routeResult = null;
    this.routeMessage = '';
    this.mapBusy = false;
    this.mapState = null;
    this.mapMessage = '';
    this.pdfBusy = false;
    this.pdfState = null;
    this.pdfMessage = '';
    this.pdfOutputDirectory = '';
    clearTimeout(this.matrixTimer);
    const generation = ++this.matrixGeneration;
    clearTimeout(this.routeTimer);
    const routeGeneration = ++this.routeGeneration;
    clearTimeout(this.mapTimer);
    const mapGeneration = ++this.mapGeneration;
    clearTimeout(this.pdfTimer);
    const pdfGeneration = ++this.pdfGeneration;
    if (!this.version || this.version === 'new') return;
    this.refreshMatrixStatus(generation);
    this.refreshRouteStatus(routeGeneration);
    this.refreshMapStatus(mapGeneration);
    this.refreshPdfStatus(pdfGeneration);
    const version = this.version;
    this.loading = true;
    this.http.get<{ startLocation: StartLocation | null; settings: Record<string, string> }>(this.url).subscribe({
      next: document => {
        if (version !== this.version) return;
        this.startLocation = document.startLocation;
        const driverCount = document.settings[this.drivers.key] ?? '';
        this.drivers.value = this.drivers.saved = driverCount;
        const serviceSeconds = document.settings[this.serviceSeconds.key];
        this.serviceSeconds.value = serviceSeconds ?? '60';
        this.serviceSeconds.saved = serviceSeconds ?? '';
        const capacity = document.settings[this.capacity.key];
        this.capacity.value = capacity ?? '60';
        this.capacity.saved = capacity ?? '';
        const reloadSeconds = document.settings[this.reloadSeconds.key];
        this.reloadSeconds.value = reloadSeconds ?? '10';
        this.reloadSeconds.saved = reloadSeconds ?? '';
        const maxDifferenceMinutes = document.settings[this.maxDifferenceMinutes.key];
        this.maxDifferenceMinutes.value = maxDifferenceMinutes ?? '30';
        this.maxDifferenceMinutes.saved = maxDifferenceMinutes ?? '';
        this.settingsLoaded = true;
        this.loading = false;
      },
      error: () => { if (version === this.version) { this.error = 'De instellingen konden niet worden geladen.'; this.loading = false; } }
    });
  }

  ngOnDestroy(): void {
    ++this.matrixGeneration;
    ++this.routeGeneration;
    ++this.mapGeneration;
    ++this.pdfGeneration;
    clearTimeout(this.matrixTimer);
    clearTimeout(this.routeTimer);
    clearTimeout(this.mapTimer);
    clearTimeout(this.pdfTimer);
  }

  private get startUrl(): string { return `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/start-location`; }

  private refreshMatrixStatus(generation: number): void {
    const version = this.version;
    this.http.get<MatrixStatus>(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}/matrix-calculation`).subscribe({
      next: status => {
        if (generation !== this.matrixGeneration) return;
        if (!['idle', 'running', 'busy', 'completed', 'failed', 'stale'].includes(status.state)) {
          this.matrixState = null;
          this.matrixMessage = 'De matrixstatus is ongeldig.';
        } else {
          this.matrixState = status.state;
          this.matrixMessage = status.state === 'failed' || status.state === 'stale'
            ? (status.message || 'De matrixberekening is niet beschikbaar.') : '';
        }
        this.matrixTimer = setTimeout(() => this.refreshMatrixStatus(generation), 3000);
      },
      error: () => {
        if (generation !== this.matrixGeneration) return;
        this.matrixState = null;
        this.matrixMessage = 'De matrixstatus is niet beschikbaar.';
        this.matrixTimer = setTimeout(() => this.refreshMatrixStatus(generation), 3000);
      }
    });
  }

  calculateMatrix(): void {
    const version = this.version;
    const generation = ++this.matrixGeneration;
    clearTimeout(this.matrixTimer);
    this.matrixBusy = true;
    this.matrixMessage = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}/matrix-calculation`, {}).subscribe({
      next: () => {
        if (generation !== this.matrixGeneration) return;
        this.invalidateRoute();
        this.matrixState = 'running';
        this.matrixBusy = false;
        this.refreshMatrixStatus(generation);
      },
      error: (error: unknown) => {
        if (generation !== this.matrixGeneration) return;
        this.matrixState = null;
        this.matrixMessage = error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
          ? error.error.detail : 'De matrixberekening kon niet worden gestart.';
        this.matrixBusy = false;
        this.matrixTimer = setTimeout(() => this.refreshMatrixStatus(generation), 3000);
      }
    });
  }

  private refreshRouteStatus(generation: number): void {
    const version = this.version;
    const url = `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}`;
    this.http.get<MatrixStatus>(`${url}/route-calculation`).subscribe({
      next: status => {
        if (generation !== this.routeGeneration) return;
        this.routeAvailabilityChange.emit(false);
        if (!['idle', 'running', 'busy', 'completed', 'failed', 'stale'].includes(status.state)) {
          this.routeState = null;
          this.routeResult = null;
          this.routeMessage = 'De routestatus is ongeldig.';
        } else {
          this.routeState = status.state;
          this.routeMessage = status.state === 'failed' || status.state === 'stale'
            ? (status.message || 'De routeberekening is niet beschikbaar.') : '';
          if (status.state !== 'completed') this.routeResult = null;
          else {
            this.http.get<RouteResult>(`${url}/routes`).subscribe({
              next: result => {
                if (generation !== this.routeGeneration || this.routeState !== 'completed') return;
                this.routeResult = result;
                this.routeAvailabilityChange.emit(true);
              },
              error: () => {
                if (generation === this.routeGeneration) {
                  this.routeResult = null;
                  this.routeMessage = 'De routes konden niet worden geladen.';
                  this.routeTimer = setTimeout(() => this.refreshRouteStatus(generation), 3000);
                }
              }
            });
            return;
          }
        }
        this.routeTimer = setTimeout(() => this.refreshRouteStatus(generation), 3000);
      },
      error: () => {
        if (generation !== this.routeGeneration) return;
        this.routeAvailabilityChange.emit(false);
        this.routeState = null;
        this.routeResult = null;
        this.routeMessage = 'De routestatus is niet beschikbaar.';
        this.routeTimer = setTimeout(() => this.refreshRouteStatus(generation), 3000);
      }
    });
  }

  calculateRoute(): void {
    const version = this.version;
    const generation = ++this.routeGeneration;
    clearTimeout(this.routeTimer);
    this.routeBusy = true;
    this.routeAvailabilityChange.emit(false);
    this.routeState = null;
    this.routeResult = null;
    this.routeMessage = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}/route-calculation`, {}).subscribe({
      next: () => {
        if (generation !== this.routeGeneration) return;
        this.routeState = 'running';
        this.routeBusy = false;
        this.refreshRouteStatus(generation);
      },
      error: (error: unknown) => {
        if (generation !== this.routeGeneration) return;
        this.routeMessage = error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
          ? error.error.detail : 'De routeberekening kon niet worden gestart.';
        this.routeBusy = false;
        this.routeTimer = setTimeout(() => this.refreshRouteStatus(generation), 3000);
      }
    });
  }

  private refreshMapStatus(generation: number): void {
    const url = `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/route-maps`;
    this.http.get<PdfStatus>(url).subscribe({
      next: status => {
        if (generation !== this.mapGeneration) return;
        if (!['idle', 'running', 'busy', 'completed', 'failed'].includes(status.state)) {
          this.mapState = null;
          this.mapMessage = 'De status van de routekaarten is ongeldig.';
        } else {
          this.mapState = status.state;
          this.mapMessage = status.state === 'failed' ? 'Routekaarten renderen is mislukt. Controleer de containerlogs.' : '';
        }
        if (status.state === 'running' || status.state === 'busy' || this.mapState === null)
          this.mapTimer = setTimeout(() => this.refreshMapStatus(generation), 3000);
      },
      error: () => {
        if (generation !== this.mapGeneration) return;
        this.mapState = null;
        this.mapMessage = 'De status van de routekaarten is niet beschikbaar.';
        this.mapTimer = setTimeout(() => this.refreshMapStatus(generation), 3000);
      }
    });
  }

  renderRouteMaps(): void {
    const generation = ++this.mapGeneration;
    clearTimeout(this.mapTimer);
    this.mapBusy = true;
    this.mapMessage = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/route-maps`, {}).subscribe({
      next: () => {
        if (generation !== this.mapGeneration) return;
        this.mapBusy = false;
        this.mapState = 'running';
        this.refreshMapStatus(generation);
      },
      error: (error: unknown) => {
        if (generation !== this.mapGeneration) return;
        this.mapBusy = false;
        this.mapMessage = error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
          ? error.error.detail : 'Routekaarten renderen kon niet worden gestart.';
        this.mapTimer = setTimeout(() => this.refreshMapStatus(generation), 3000);
      }
    });
  }

  private refreshPdfStatus(generation: number): void {
    const url = `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/driver-pdfs`;
    this.http.get<PdfStatus>(url).subscribe({
      next: status => {
        if (generation !== this.pdfGeneration) return;
        if (!['idle', 'running', 'busy', 'completed', 'failed'].includes(status.state)) {
          this.pdfState = null;
          this.pdfMessage = 'De PDF-status is ongeldig.';
        } else {
          this.pdfState = status.state;
          this.pdfMessage = status.state === 'failed' ? (status.message || 'PDF-generatie mislukt.') : '';
          this.pdfOutputDirectory = status.state === 'completed' ? (status.outputDirectory || '') : '';
        }
        if (status.state === 'running' || status.state === 'busy' || this.pdfState === null)
          this.pdfTimer = setTimeout(() => this.refreshPdfStatus(generation), 3000);
      },
      error: () => {
        if (generation !== this.pdfGeneration) return;
        this.pdfState = null;
        this.pdfMessage = 'De PDF-status is niet beschikbaar.';
        this.pdfTimer = setTimeout(() => this.refreshPdfStatus(generation), 3000);
      }
    });
  }

  createPdfs(): void {
    const generation = ++this.pdfGeneration;
    clearTimeout(this.pdfTimer);
    this.pdfBusy = true;
    this.pdfMessage = '';
    this.pdfOutputDirectory = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/driver-pdfs`, {}).subscribe({
      next: () => {
        if (generation !== this.pdfGeneration) return;
        this.pdfBusy = false;
        this.pdfState = 'running';
        this.refreshPdfStatus(generation);
      },
      error: (error: unknown) => {
        if (generation !== this.pdfGeneration) return;
        this.pdfBusy = false;
        this.pdfMessage = error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
          ? error.error.detail : 'PDF-generatie kon niet worden gestart.';
        this.pdfTimer = setTimeout(() => this.refreshPdfStatus(generation), 3000);
      }
    });
  }

  private invalidateRoute(): void {
    if (!this.routeResult) return;
    ++this.routeGeneration;
    clearTimeout(this.routeTimer);
    this.routeResult = null;
    this.routeState = 'stale';
    this.routeMessage = 'De invoer of instellingen zijn gewijzigd; bereken de routes opnieuw.';
    this.routeAvailabilityChange.emit(false);
  }

  searchStart(): void {
    this.startBusy = true;
    this.error = '';
    this.http.post<StartLocation[]>(`${this.startUrl}/search`, { query: this.startQuery }).subscribe({
      next: results => { this.startResults = results; this.startSearched = true; this.startBusy = false; },
      error: () => { this.error = 'Zoeken in Photon is mislukt.'; this.startBusy = false; }
    });
  }

  chooseStart(result: StartLocation): void {
    this.startBusy = true;
    this.error = '';
    this.http.put<StartLocation>(this.startUrl, result).subscribe({
      next: saved => { this.startLocation = saved; this.startResults = []; this.startSearched = false; this.startQuery = ''; this.startBusy = false; this.invalidateRoute(); },
      error: () => { this.error = 'De startlocatie kon niet worden opgeslagen.'; this.startBusy = false; }
    });
  }

  clearStart(): void {
    this.startBusy = true;
    this.http.delete(this.startUrl).subscribe({
      next: () => { this.startLocation = null; this.startBusy = false; this.invalidateRoute(); },
      error: () => { this.error = 'De startlocatie kon niet worden verwijderd.'; this.startBusy = false; }
    });
  }

  save(row: SettingRow): void {
    row.busy = true;
    this.error = '';
    this.http.put<{ value: string }>(`${this.url}/${encodeURIComponent(row.key)}`, { value: row.value }).subscribe({
      next: result => { row.value = row.saved = result.value; row.busy = false; this.invalidateRoute(); },
      error: () => { this.error = `'${row.key}' kon niet worden opgeslagen.`; row.busy = false; }
    });
  }
}

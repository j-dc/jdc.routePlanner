import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, Input, OnChanges, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from './environment';

interface StartLocation { label: string; latitude: number; longitude: number; [field: string]: unknown; }
interface SettingRow { key: string; value: string; saved: string; busy: boolean; }

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
      </ul>
      <p class="settings-error" *ngIf="drivers.value && !validDriverCount">Vul een positief geheel aantal chauffeurs in.</p>
      <h3>Overige instellingen</h3>
      <p class="settings-empty" *ngIf="!loading && !rows.length">Nog geen instellingen voor deze versie.</p>
      <ul class="settings-list">
        <li *ngFor="let row of rows">
          <label [for]="'setting-' + row.key">{{ row.key }}</label>
          <input [id]="'setting-' + row.key" type="text" maxlength="1000" [(ngModel)]="row.value" [disabled]="row.busy">
          <button type="button" (click)="save(row)" [disabled]="row.busy || row.value === row.saved">Opslaan</button>
          <button type="button" class="danger" (click)="remove(row)" [disabled]="row.busy">Verwijderen</button>
        </li>
      </ul>
      <form class="settings-add" (ngSubmit)="add()">
        <input name="new-key" type="text" placeholder="Sleutel (bv. startLocatie)" maxlength="64" pattern="[A-Za-z0-9_.\\-]+" [(ngModel)]="newKey" aria-label="Nieuwe sleutel">
        <input name="new-value" type="text" placeholder="Waarde" maxlength="1000" [(ngModel)]="newValue" aria-label="Nieuwe waarde">
        <button type="submit" [disabled]="!newKey.trim() || adding">Toevoegen</button>
      </form>
    </section>
    <section class="settings" aria-labelledby="route-calculation-title">
      <h2 id="route-calculation-title">Routeberekening</h2>
      <div class="calculation-actions">
        <button type="button" (click)="calculateMatrix()" [disabled]="matrixBusy">{{ matrixBusy ? 'Bezig…' : 'Bereken Matrix' }}</button>
        <button type="button" (click)="calculateRoute()" [disabled]="routeBusy">{{ routeBusy ? 'Bezig…' : 'Bereken route' }}</button>
      </div>
      <p class="settings-error" *ngIf="matrixMessage" role="alert">{{ matrixMessage }}</p>
      <p class="settings-error" *ngIf="routeMessage" role="alert">{{ routeMessage }}</p>
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
export class VersionSettingsComponent implements OnChanges {
  @Input({ required: true }) version = '';
  rows: SettingRow[] = [];
  drivers: SettingRow = { key: 'nmbDrivers', value: '', saved: '', busy: false };
  settingsLoaded = false;
  startLocation: StartLocation | null = null;
  startQuery = '';
  startResults: StartLocation[] = [];
  startSearched = false;
  startBusy = false;
  newKey = '';
  newValue = '';
  loading = false;
  adding = false;
  error = '';
  matrixBusy = false;
  matrixMessage = '';
  routeBusy = false;
  routeMessage = '';
  private readonly http = inject(HttpClient);
  private get url(): string { return `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/settings`; }
  get validDriverCount(): boolean { return /^0*[1-9][0-9]*$/.test(this.drivers.value); }

  ngOnChanges(): void {
    this.rows = [];
    this.drivers = { key: 'nmbDrivers', value: '', saved: '', busy: false };
    this.settingsLoaded = false;
    this.loading = false;
    this.startLocation = null;
    this.startResults = [];
    this.startSearched = false;
    this.startQuery = '';
    this.error = '';
    this.matrixBusy = false;
    this.matrixMessage = '';
    this.routeBusy = false;
    this.routeMessage = '';
    if (!this.version || this.version === 'new') return;
    const version = this.version;
    this.loading = true;
    this.http.get<{ startLocation: StartLocation | null; settings: Record<string, string> }>(this.url).subscribe({
      next: document => {
        if (version !== this.version) return;
        this.startLocation = document.startLocation;
        const driverCount = document.settings[this.drivers.key] ?? '';
        this.drivers.value = this.drivers.saved = driverCount;
        this.rows = Object.entries(document.settings)
          .filter(([key]) => key !== this.drivers.key)
          .map(([key, value]) => ({ key, value, saved: value, busy: false }));
        this.settingsLoaded = true;
        this.loading = false;
      },
      error: () => { if (version === this.version) { this.error = 'De instellingen konden niet worden geladen.'; this.loading = false; } }
    });
  }

  private get startUrl(): string { return `${environment.reviewApiUrl}/api/versions/${encodeURIComponent(this.version)}/start-location`; }

  calculateMatrix(): void {
    const version = this.version;
    this.matrixBusy = true;
    this.matrixMessage = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}/matrix-calculation`, {}).subscribe({
      next: () => { if (version === this.version) this.matrixBusy = false; },
      error: (error: unknown) => {
        if (version !== this.version) return;
        this.matrixMessage = error instanceof HttpErrorResponse && error.status === 501
          ? 'Matrixberekening is nog niet beschikbaar.'
          : 'De matrixberekening kon niet worden gestart.';
        this.matrixBusy = false;
      }
    });
  }

  calculateRoute(): void {
    const version = this.version;
    this.routeBusy = true;
    this.routeMessage = '';
    this.http.post(`${environment.reviewApiUrl}/api/versions/${encodeURIComponent(version)}/route-calculation`, {}).subscribe({
      next: () => { if (version === this.version) this.routeBusy = false; },
      error: (error: unknown) => {
        if (version !== this.version) return;
        this.routeMessage = error instanceof HttpErrorResponse && error.status === 501
          ? 'Routeberekening is nog niet beschikbaar.'
          : 'De routeberekening kon niet worden gestart.';
        this.routeBusy = false;
      }
    });
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
      next: saved => { this.startLocation = saved; this.startResults = []; this.startSearched = false; this.startQuery = ''; this.startBusy = false; },
      error: () => { this.error = 'De startlocatie kon niet worden opgeslagen.'; this.startBusy = false; }
    });
  }

  clearStart(): void {
    this.startBusy = true;
    this.http.delete(this.startUrl).subscribe({
      next: () => { this.startLocation = null; this.startBusy = false; },
      error: () => { this.error = 'De startlocatie kon niet worden verwijderd.'; this.startBusy = false; }
    });
  }

  add(): void {
    const key = this.newKey.trim();
    if (!key) return;
    if (key === this.drivers.key) {
      this.error = 'Gebruik het vaste veld Aantal Chauffeurs voor deze instelling.';
      return;
    }
    this.adding = true;
    this.error = '';
    this.http.put<{ key: string; value: string }>(`${this.url}/${encodeURIComponent(key)}`, { value: this.newValue }).subscribe({
      next: result => {
        const existing = this.rows.find(row => row.key === result.key);
        if (existing) { existing.value = existing.saved = result.value; }
        else this.rows.push({ key: result.key, value: result.value, saved: result.value, busy: false });
        this.newKey = this.newValue = '';
        this.adding = false;
      },
      error: () => { this.error = 'De instelling kon niet worden opgeslagen. Controleer de sleutel.'; this.adding = false; }
    });
  }

  save(row: SettingRow): void {
    row.busy = true;
    this.error = '';
    this.http.put<{ value: string }>(`${this.url}/${encodeURIComponent(row.key)}`, { value: row.value }).subscribe({
      next: result => { row.value = row.saved = result.value; row.busy = false; },
      error: () => { this.error = `'${row.key}' kon niet worden opgeslagen.`; row.busy = false; }
    });
  }

  remove(row: SettingRow): void {
    row.busy = true;
    this.error = '';
    this.http.delete(`${this.url}/${encodeURIComponent(row.key)}`).subscribe({
      next: () => { this.rows = this.rows.filter(candidate => candidate !== row); },
      error: () => { this.error = `'${row.key}' kon niet worden verwijderd.`; row.busy = false; }
    });
  }
}

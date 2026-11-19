import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Papa from 'papaparse';
import { environment } from './environment';
import { MapLocation, RouteMapComponent } from './route-map.component';
import { VersionSettingsComponent } from './version-settings.component';

interface ReviewAddress {
  street: string;
  houseNumber: string;
  postcode: string;
  municipality: string;
}

interface GeocodingCandidate {
  candidateId: string;
  name: string;
  street: string;
  houseNumber: string;
  postcode: string;
  municipality: string;
  countryCode: string;
  matchedFields: string[];
  matchedFieldCount: number;
  discoveryMethod: string;
  houseNumberMatchMode: string;
  isStrongAddressMatch: boolean;
  municipalityMatchState: string;
  geometryIsValid: boolean;
  longitude: number | null;
  latitude: number | null;
}

interface ReviewRecord {
  csvRecordNumber: number;
  address: ReviewAddress;
  geocodingStatus: string;
  geocodingReason: string;
  candidates: GeocodingCandidate[];
  decision: string;
  selectedCandidateId: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string;
  reviewedAtUtc: string | null;
}

interface ReviewDocument {
  totalRecords: number;
  pendingCount: number;
  acceptedCount: number;
  unresolvedCount: number;
  readyForNextStep: boolean;
  records: ReviewRecord[];
}

interface PhotonSearchResponse {
  review: ReviewDocument;
  resultsReturned: number;
  newCandidatesAdded: number;
}

type ReviewFilter = 'open' | 'all' | 'accepted' | 'unresolved';
type AddressColumn = 'straat' | 'nr.' | 'postcode' | 'gemeente';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, RouteMapComponent, VersionSettingsComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.reviewApiUrl;

  readonly addressColumns: { key: AddressColumn; label: string }[] = [
    { key: 'straat', label: 'Straat' },
    { key: 'nr.', label: 'Huisnummer' },
    { key: 'postcode', label: 'Postcode' },
    { key: 'gemeente', label: 'Gemeente' },
  ];
  private readonly outputHeaders = ['rit', 'naam', 'straat', 'nr.', 'postcode', 'gemeente', 'aantal', 'bellen', 'Opmerking', 'opmerking', 'klas'];
  private fileSelection = 0;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  versions: string[] = [];
  selectedVersion = 'new';
  versionsLoading = true;
  versionError = '';
  step: 'input' | 'review' | 'routes' = 'input';
  csvName = '';
  csvHeaders: string[] = [];
  csvRows: string[][] = [];
  columns: Record<AddressColumn, string> = { straat: '', 'nr.': '', postcode: '', gemeente: '' };
  uploading = false;
  inputError = '';
  inputMessage = '';

  private reviewDocument: ReviewDocument | null = null;
  mapLocations: MapLocation[] = [];
  routeAvailable = false;

  get document(): ReviewDocument | null { return this.reviewDocument; }
  set document(document: ReviewDocument | null) {
    this.reviewDocument = document;
    this.mapLocations = (document?.records ?? [])
      .filter(record => (record.decision === 'accepted' || record.decision === 'auto_accepted') &&
        record.latitude !== null && record.longitude !== null &&
        Number.isFinite(record.latitude) && Number.isFinite(record.longitude) &&
        Math.abs(record.latitude) <= 85.05112878 && Math.abs(record.longitude) <= 180)
      .map(record => ({
        recordNumber: record.csvRecordNumber,
        address: this.addressText(record.address),
        candidateId: record.selectedCandidateId?.toUpperCase() ?? null,
        latitude: record.latitude!,
        longitude: record.longitude!,
      }));
  }

  get missingMapLocations(): number {
    return (this.document?.totalRecords ?? 0) - this.mapLocations.length;
  }
  activeRecordNumber: number | null = null;
  selectedCandidateId = '';
  manualSearchQuery = '';
  notes = '';
  filter: ReviewFilter = 'open';
  loading = false;
  saving = false;
  searching = false;
  errorMessage = '';
  savedMessage = '';
  checkRunning = false;
  checkBusy = false;
  checkStarting = false;
  checkMissing = false;
  checkAvailable = false;
  checkStatusError = '';

  ngOnInit(): void {
    this.http.get<string[]>(`${this.apiUrl}/api/versions`).subscribe({
      next: versions => { this.versions = versions; this.versionsLoading = false; },
      error: error => {
        this.versionsLoading = false;
        this.versionError = this.errorText(error, 'De versies konden niet worden geladen.');
      },
    });
  }

  ngOnDestroy(): void {
    this.clearStatusTimer();
  }

  versionLabel(version: string): string {
    if (version === 'legacy') return 'Bestaande invoer';
    const iso = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(9, 11)}:${version.slice(11, 13)}:${version.slice(13, 15)}.${version.slice(15, 18)}Z`;
    const date = new Date(iso);
    return `${date.toLocaleString('nl-BE', { dateStyle: 'short', timeStyle: 'medium' })}.${version.slice(15, 22)}`;
  }

  selectVersion(version: string): void {
    this.clearStatusTimer();
    this.routeAvailable = false;
    this.selectedVersion = version;
    this.fileSelection++;
    this.csvName = '';
    this.csvHeaders = [];
    this.csvRows = [];
    this.columns = { straat: '', 'nr.': '', postcode: '', gemeente: '' };
    this.inputError = '';
    this.inputMessage = '';
    this.errorMessage = '';
    this.savedMessage = '';
    this.document = null;
    this.activeRecordNumber = null;
    this.checkRunning = false;
    this.checkBusy = false;
    this.checkMissing = false;
    this.checkAvailable = false;
    this.checkStatusError = '';
    if (version === 'new') {
      this.step = 'input';
    } else {
      this.showStep('review');
    }
  }

  showStep(step: 'input' | 'review' | 'routes'): void {
    if (step === 'review' && this.selectedVersion === 'new') return;
    if (step === 'review' && this.loading) return;
    if (step === 'routes' && (!this.document?.readyForNextStep || this.loading || this.saving || this.searching)) return;
    if (step !== 'routes') this.routeAvailable = false;
    this.step = step;
    if (step === 'review') {
      this.loadCheckStatus(this.selectedVersion, true);
    }
  }

  startAddressCheck(): void {
    if (!this.checkMissing || !this.checkAvailable || this.checkStarting || this.checkRunning || this.checkBusy) return;
    const version = this.selectedVersion;
    this.checkStarting = true;
    this.errorMessage = '';
    this.http.post<{ state: string }>(`${this.apiUrl}/api/versions/${version}/address-check`, {}).subscribe({
      next: () => {
        this.checkStarting = false;
        if (version !== this.selectedVersion) return;
        this.checkMissing = false;
        this.checkRunning = true;
        this.scheduleStatus(version);
      },
      error: error => {
        this.checkStarting = false;
        if (version !== this.selectedVersion) return;
        this.errorMessage = this.errorText(error, 'De adrescontrole kon niet worden gestart.');
        if (error instanceof HttpErrorResponse && error.status === 409) this.loadCheckStatus(version, false);
      },
    });
  }

  private loadCheckStatus(version: string, initial: boolean): void {
    this.clearStatusTimer();
    if (initial) this.loading = true;
    this.http.get<{ state: string }>(`${this.apiUrl}/api/versions/${version}/address-check`).subscribe({
      next: status => {
        if (version !== this.selectedVersion) return;
        this.loading = false;
        this.checkAvailable = true;
        this.checkStatusError = '';
        if (status.state === 'running') {
          this.checkRunning = true;
          this.checkBusy = false;
          this.checkMissing = false;
          this.document = null;
          this.errorMessage = '';
          this.scheduleStatus(version);
        } else if (status.state === 'busy') {
          this.checkRunning = false;
          this.checkBusy = true;
          this.checkMissing = false;
          this.document = null;
          this.errorMessage = '';
          this.scheduleStatus(version);
        } else {
          this.checkRunning = false;
          this.checkBusy = false;
          if (status.state === 'failed') {
            this.checkMissing = true;
            this.errorMessage = 'De automatische adrescontrole is mislukt. Probeer opnieuw.';
            this.scheduleStatus(version);
          } else if (status.state === 'idle' && this.checkMissing && !initial) {
            this.scheduleStatus(version);
          } else {
            this.loadReview();
          }
        }
      },
      error: error => {
        if (version !== this.selectedVersion) return;
        this.loading = false;
        this.checkAvailable = false;
        this.checkStatusError = this.errorText(error, 'De status van de adrescontrole is niet beschikbaar.');
        if (this.checkRunning || this.checkBusy || this.checkMissing) this.scheduleStatus(version);
        else this.loadReview();
      },
    });
  }

  private scheduleStatus(version: string): void {
    this.clearStatusTimer();
    this.statusTimer = setTimeout(() => this.loadCheckStatus(version, false), 2000);
  }

  private clearStatusTimer(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  async selectCsv(event: Event): Promise<void> {
    const selection = ++this.fileSelection;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.csvName = '';
    this.csvHeaders = [];
    this.csvRows = [];
    this.columns = { straat: '', 'nr.': '', postcode: '', gemeente: '' };
    this.inputError = '';
    this.inputMessage = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.inputError = 'Het CSV-bestand mag maximaal 10 MB groot zijn.';
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (selection !== this.fileSelection) return;
      const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: false });
      const rows = parsed.data;
      if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
      if (parsed.errors.length) throw new Error('Het CSV-bestand is ongeldig of het scheidingsteken kon niet worden bepaald.');
      const headers = rows.shift();
      if (!headers || headers.length < 4 || !rows.length) throw new Error('Het CSV-bestand moet een kopregel en minstens één levering bevatten.');
      const repeatedHeader = this.outputHeaders.find(header =>
        !this.addressColumns.some(column => column.key === header) &&
        headers.filter(source => source.trim() === header).length > 1);
      if (repeatedHeader) throw new Error(`De kolom ${repeatedHeader} komt meer dan eens voor.`);
      const malformedIndex = rows.findIndex(row => row.length !== headers.length);
      if (malformedIndex >= 0) throw new Error(`CSV-record ${malformedIndex + 2} heeft een onjuist aantal kolommen.`);
      this.csvName = file.name;
      this.csvHeaders = headers;
      this.csvRows = rows;
      for (const column of this.addressColumns) {
        const index = headers.findIndex(header => header.trim().toLowerCase() === column.key);
        if (index >= 0) this.columns[column.key] = String(index);
      }
    } catch (error) {
      if (selection === this.fileSelection) {
        this.inputError = error instanceof Error && error.name !== 'TypeError'
          ? error.message : 'Het bestand kon niet als UTF-8 worden gelezen.';
      }
    }
  }

  get mappingValid(): boolean {
    const values = this.addressColumns.map(column => this.columns[column.key]);
    return values.every(value => value !== '') && new Set(values).size === values.length;
  }

  uploadCsv(): void {
    if (!this.mappingValid || !this.csvRows.length || this.uploading) return;
    const missingIndex = this.csvRows.findIndex(row => this.addressColumns.some(column => !row[Number(this.columns[column.key])].trim()));
    if (missingIndex >= 0) {
      this.inputError = `CSV-record ${missingIndex + 2} mist een verplicht adresveld.`;
      return;
    }
    const indices = this.outputHeaders.map(header => {
      if (header in this.columns) return Number(this.columns[header as AddressColumn]);
      return this.csvHeaders.findIndex(source => source.trim() === header);
    });
    const csv = Papa.unparse({ fields: this.outputHeaders, data: this.csvRows.map(row => indices.map(index => index < 0 ? '' : row[index])) },
      { delimiter: ';', newline: '\r\n' });
    this.uploading = true;
    this.inputError = '';
    this.inputMessage = '';
    this.http.post<{ id: string }>(`${this.apiUrl}/api/versions`, csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }).subscribe({
      next: response => {
        this.uploading = false;
        this.document = null;
        this.activeRecordNumber = null;
        this.versions = [response.id, ...this.versions.filter(version => version !== response.id)];
        this.selectedVersion = response.id;
        this.inputMessage = `${this.csvRows.length} leveringen opgeslagen.`;
      },
      error: error => {
        this.uploading = false;
        this.inputError = this.errorText(error, 'Het invoerbestand kon niet worden opgeslagen.');
      },
    });
  }

  get activeRecord(): ReviewRecord | null {
    return this.document?.records.find(record => record.csvRecordNumber === this.activeRecordNumber) ?? null;
  }

  get visibleRecords(): ReviewRecord[] {
    const records = this.document?.records ?? [];
    if (this.filter === 'open') {
      return records.filter(record => record.decision === 'pending' || record.decision === 'unresolved');
    }
    if (this.filter === 'accepted') {
      return records.filter(record => record.decision === 'accepted' || record.decision === 'auto_accepted');
    }
    if (this.filter === 'unresolved') {
      return records.filter(record => record.decision === 'unresolved');
    }
    return records;
  }

  loadReview(): void {
    this.loading = true;
    this.errorMessage = '';
    this.checkMissing = false;
    this.http.get<ReviewDocument>(`${this.apiUrl}/api/versions/${this.selectedVersion}/review`).subscribe({
      next: document => {
        this.document = document;
        this.loading = false;
        const firstOpen = document.records.find(record => record.decision === 'pending' || record.decision === 'unresolved');
        const selected = firstOpen ?? document.records[0] ?? null;
        if (selected) {
          this.selectRecord(selected);
        }
      },
      error: error => {
        this.loading = false;
        if (error instanceof HttpErrorResponse && error.status === 404) {
          this.checkMissing = true;
          this.scheduleStatus(this.selectedVersion);
        } else {
          this.errorMessage = this.errorText(error, 'Het reviewrapport kon niet worden geladen.');
        }
      },
    });
  }

  selectRecord(record: ReviewRecord): void {
    this.activeRecordNumber = record.csvRecordNumber;
    this.selectedCandidateId = record.selectedCandidateId ??
      record.candidates.find(candidate => candidate.isStrongAddressMatch && candidate.geometryIsValid)?.candidateId ?? '';
    this.manualSearchQuery = [
      [record.address.street, record.address.houseNumber].filter(Boolean).join(' '),
      [record.address.postcode, record.address.municipality].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');
    this.notes = record.notes ?? '';
    this.savedMessage = '';
  }

  setFilter(filter: ReviewFilter): void {
    this.filter = filter;
    if (!this.visibleRecords.some(record => record.csvRecordNumber === this.activeRecordNumber)) {
      const next = this.visibleRecords[0];
      if (next) {
        this.selectRecord(next);
      }
    }
  }

  saveDecision(decision: 'accepted' | 'unresolved'): void {
    if (!this.activeRecord || this.saving) {
      return;
    }
    if (decision === 'accepted' && !this.selectedCandidateId) {
      this.errorMessage = 'Selecteer eerst een kandidaat.';
      return;
    }
    if (decision === 'unresolved' && !this.notes.trim()) {
      this.errorMessage = 'Geef een korte reden op voordat je het adres onopgelost markeert.';
      return;
    }

    this.saving = true;
    this.errorMessage = '';
    this.savedMessage = '';
    const currentRecordNumber = this.activeRecord.csvRecordNumber;
    this.http.put<ReviewDocument>(`${this.apiUrl}/api/versions/${this.selectedVersion}/review/${currentRecordNumber}`, {
      decision,
      candidateId: decision === 'accepted' ? this.selectedCandidateId : null,
      notes: this.notes,
    }).subscribe({
      next: document => {
        this.document = document;
        this.saving = false;
        this.savedMessage = decision === 'accepted' ? 'Locatie bevestigd.' : 'Als onopgelost opgeslagen.';
        const nextOpen = document.records.find(record =>
          (record.decision === 'pending' || record.decision === 'unresolved') &&
          record.csvRecordNumber !== currentRecordNumber);
        const updatedRecord = document.records.find(record => record.csvRecordNumber === currentRecordNumber);
        const next = nextOpen ?? updatedRecord;
        if (next) {
          this.selectRecord(next);
          this.savedMessage = decision === 'accepted' ? 'Locatie bevestigd en opgeslagen.' : 'Onopgelost gemarkeerd en opgeslagen.';
        }
      },
      error: error => {
        this.saving = false;
        this.errorMessage = this.errorText(error, 'De beslissing kon niet worden opgeslagen.');
      },
    });
  }

  searchPhoton(): void {
    if (!this.activeRecord || this.searching) {
      return;
    }

    const query = this.manualSearchQuery.trim();
    if (query.length < 3) {
      this.errorMessage = 'Voer minimaal 3 tekens in om lokaal in Photon te zoeken.';
      return;
    }

    this.searching = true;
    this.errorMessage = '';
    this.savedMessage = '';
    const csvRecordNumber = this.activeRecord.csvRecordNumber;
    this.http.post<PhotonSearchResponse>(`${this.apiUrl}/api/versions/${this.selectedVersion}/review/${csvRecordNumber}/search`, { query }).subscribe({
      next: response => {
        this.document = response.review;
        this.searching = false;
        const added = response.newCandidatesAdded;
        this.savedMessage = added > 0
          ? `Photon vond ${response.resultsReturned} resultaten; ${added} nieuwe kandidaten toegevoegd.`
          : `Photon vond ${response.resultsReturned} resultaten; er waren geen nieuwe kandidaten.`;
      },
      error: error => {
        this.searching = false;
        this.errorMessage = this.errorText(error, 'Zoeken in de lokale Photon-database is mislukt.');
      },
    });
  }

  addressText(address: ReviewAddress): string {
    return [address.street, address.houseNumber, address.postcode, address.municipality]
      .filter(Boolean)
      .join(', ');
  }

  candidateLocation(candidate: GeocodingCandidate): string {
    return [candidate.postcode, candidate.municipality, candidate.countryCode]
      .filter(Boolean)
      .join(' · ') || 'Geen adresdetails';
  }

  openStreetMapUrl(candidate: GeocodingCandidate): string | null {
    const objectMatch = /^(?<type>[NWR])\/(?<id>\d+)$/i.exec(candidate.candidateId);
    if (objectMatch?.groups) {
      const objectType = objectMatch.groups['type'].toUpperCase();
      const objectPath = objectType === 'N' ? 'node' : objectType === 'W' ? 'way' : 'relation';
      return `https://www.openstreetmap.org/${objectPath}/${objectMatch.groups['id']}`;
    }

    if (candidate.latitude === null || candidate.longitude === null ||
        !Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude) ||
        candidate.latitude < -90 || candidate.latitude > 90 ||
        candidate.longitude < -180 || candidate.longitude > 180) {
      return null;
    }

    return `https://www.openstreetmap.org/?mlat=${candidate.latitude}&mlon=${candidate.longitude}#map=18/${candidate.latitude}/${candidate.longitude}`;
  }

  recordLabel(record: ReviewRecord): string {
    if (record.decision === 'unresolved') {
      return 'Onopgelost';
    }
    if (record.decision === 'accepted') {
      return 'Beoordeeld';
    }
    if (record.decision === 'auto_accepted') {
      return 'Automatisch geldig';
    }
    return record.geocodingStatus === 'needs_review' ? 'Controle nodig' : 'Nog te beoordelen';
  }

  private errorText(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      let payload = error.error;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      const message = payload?.detail ?? payload?.title;
      return typeof message === 'string' ? message : `${fallback} (HTTP ${error.status || 'onbekend'})`;
    }
    return fallback;
  }
}
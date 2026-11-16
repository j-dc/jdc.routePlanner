import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from './environment';

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

type ReviewFilter = 'open' | 'all' | 'accepted' | 'unresolved';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.reviewApiUrl;

  document: ReviewDocument | null = null;
  activeRecordNumber: number | null = null;
  selectedCandidateId = '';
  notes = '';
  filter: ReviewFilter = 'open';
  loading = true;
  saving = false;
  errorMessage = '';
  savedMessage = '';

  ngOnInit(): void {
    this.loadReview();
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
    this.http.get<ReviewDocument>(`${this.apiUrl}/api/review`).subscribe({
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
        this.errorMessage = this.errorText(error, 'Het reviewrapport kon niet worden geladen.');
      },
    });
  }

  selectRecord(record: ReviewRecord): void {
    this.activeRecordNumber = record.csvRecordNumber;
    this.selectedCandidateId = record.selectedCandidateId ??
      record.candidates.find(candidate => candidate.isStrongAddressMatch && candidate.geometryIsValid)?.candidateId ?? '';
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
    this.http.put<ReviewDocument>(`${this.apiUrl}/api/review/${currentRecordNumber}`, {
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
      const message = error.error?.detail ?? error.error?.title;
      return typeof message === 'string' ? message : `${fallback} (HTTP ${error.status || 'onbekend'})`;
    }
    return fallback;
  }
}
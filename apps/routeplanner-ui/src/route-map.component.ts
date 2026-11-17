import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild, inject } from '@angular/core';
import Feature from 'ol/Feature';
import Map from 'ol/Map';
import View from 'ol/View';
import GeoJSON from 'ol/format/GeoJSON';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import { fromLonLat } from 'ol/proj';
import Cluster from 'ol/source/Cluster';
import OSM from 'ol/source/OSM';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import { Subscription } from 'rxjs';
import { environment } from './environment';

export interface MapLocation {
  recordNumber: number;
  address: string;
  candidateId: string | null;
  latitude: number;
  longitude: number;
}

@Component({
  selector: 'app-route-map',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="map-workspace" aria-labelledby="map-title">
      <header class="map-heading">
        <div><p class="map-eyebrow">Routeplanning</p><h2 id="map-title">Leverlocaties</h2></div>
        <span class="location-count">{{ locations.length }} op kaart</span>
      </header>
      <p class="map-warning" *ngIf="missingCount" role="alert">{{ missingCount }} leveringen hebben geen bruikbare bevestigde coördinaten.</p>
      <div class="geometry-notice" *ngIf="geometryError || missingContours || geometryRunning || geometryBusy" role="status">
        <span *ngIf="geometryRunning">Lokale geometrie wordt geladen...</span>
        <span *ngIf="!geometryRunning && geometryBusy">Er loopt al een andere verwerking.</span>
        <span *ngIf="!geometryRunning && !geometryBusy && geometryError">{{ geometryError }}</span>
        <span *ngIf="!geometryRunning && !geometryBusy && !geometryError && missingContours">Voor {{ missingContours }} leveringen is geen lokale contour beschikbaar.</span>
        <button *ngIf="!geometryRunning && !geometryBusy" type="button" (click)="refreshGeometry()" [disabled]="geometryStarting">{{ geometryStarting ? 'Starten...' : 'Laad de lokale geometrie' }}</button>
      </div>
      <div class="map-body">
        <div #mapTarget class="map" tabindex="0" aria-label="Kaart met bevestigde leverlocaties"></div>
        <aside class="selection-panel" *ngIf="selectedLocations.length" aria-label="Geselecteerde leveringen">
          <div class="selection-heading"><h3>Leveringen</h3><span>{{ selectedLocations.length }}</span></div>
          <ul><li *ngFor="let location of selectedLocations"><strong>CSV-rij {{ location.recordNumber }}</strong><span>{{ location.address }}</span></li></ul>
        </aside>
      </div>
      <p class="map-empty" *ngIf="!locations.length">Geen bevestigde locaties beschikbaar.</p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .map-workspace { margin-top: 20px; }
    .map-heading, .selection-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .map-heading { margin-bottom: 14px; }
    .map-heading h2, .selection-heading h3 { margin: 0; color: var(--ink); font-size: 19px; }
    .map-eyebrow { margin: 0 0 4px; color: var(--muted); font-size: 11px; font-weight: 750; text-transform: uppercase; }
    .location-count, .selection-heading span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .map-body { display: grid; grid-template-columns: minmax(0, 1fr) auto; border: 1px solid var(--line); background: #dce5df; }
    .map { min-width: 0; height: clamp(400px, 60vh, 700px); }
    .map:focus-visible { outline: 3px solid #eaa35e; outline-offset: -3px; }
    .selection-panel { width: 270px; max-height: clamp(400px, 60vh, 700px); overflow: auto; padding: 18px; border-left: 1px solid var(--line); background: var(--surface); }
    .selection-heading h3 { font-size: 15px; }
    .selection-panel ul { margin: 12px 0 0; padding: 0; list-style: none; }
    .selection-panel li { display: grid; gap: 4px; padding: 11px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; font-size: 12px; }
    .selection-panel li strong { color: var(--muted); font-size: 11px; }
    .map-warning { padding: 10px 12px; color: var(--red); background: var(--red-pale); font-size: 13px; }
    .geometry-notice { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 0 0 14px; padding: 10px 12px; color: var(--red); background: var(--red-pale); font-size: 13px; }
    .geometry-notice button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--forest); border-radius: 5px; background: var(--forest); color: white; font-weight: 700; }
    .geometry-notice button:disabled { cursor: not-allowed; opacity: 0.55; }
    .map-empty { color: var(--muted); font-size: 13px; }
    @media (max-width: 680px) {
      .map-body { grid-template-columns: 1fr; }
      .map { height: 430px; }
      .selection-panel { width: 100%; max-height: 220px; border-top: 1px solid var(--line); border-left: 0; }
    }
  `],
})
export class RouteMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly http = inject(HttpClient);
  @Input() version = '';
  @Input() locations: MapLocation[] = [];
  @Input() missingCount = 0;
  @ViewChild('mapTarget') private mapTarget!: ElementRef<HTMLElement>;

  selectedLocations: MapLocation[] = [];
  geometryError = '';
  geometryRunning = false;
  geometryBusy = false;
  geometryStarting = false;
  missingContours = 0;
  private readonly source = new VectorSource<Feature<Point>>();
  private readonly geometrySource = new VectorSource();
  private geometrySubscription: Subscription | null = null;
  private statusSubscription: Subscription | null = null;
  private startSubscription: Subscription | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private geometryData: object | null = null;
  private map: Map | null = null;

  ngAfterViewInit(): void {
    const clusters = new Cluster({ distance: 36, source: this.source });
    const markers = new VectorLayer({
      source: clusters,
      style: feature => {
        const count = (feature.get('features') as Feature<Point>[]).length;
        return new Style({
          image: new CircleStyle({
            radius: count > 1 ? 14 : 7,
            fill: new Fill({ color: '#1b5945' }),
            stroke: new Stroke({ color: '#ffffff', width: 2 }),
          }),
          text: count > 1 ? new Text({ text: String(count), fill: new Fill({ color: '#ffffff' }), font: '700 12px sans-serif' }) : undefined,
        });
      },
    });
    this.map = new Map({
      target: this.mapTarget.nativeElement,
      layers: [new TileLayer({ source: new OSM() }), new VectorLayer({
        source: this.geometrySource,
        style: new Style({
          fill: new Fill({ color: 'rgba(230, 129, 58, 0.3)' }),
          stroke: new Stroke({ color: '#b04d25', width: 3 }),
        }),
      }), markers],
      view: new View({ center: fromLonLat([3.3, 50.9]), zoom: 10 }),
    });
    this.map.on('singleclick', event => {
      const cluster = this.map?.forEachFeatureAtPixel(event.pixel, feature => feature, { layerFilter: layer => layer === markers });
      const features = cluster?.get('features') as Feature<Point>[] | undefined;
      this.selectedLocations = features?.map(feature => feature.get('location') as MapLocation)
        .sort((first, second) => first.recordNumber - second.recordNumber) ?? [];
    });
    this.updateLocations();
    this.loadGeometry();
    this.checkGeometryStatus(true);
  }

  ngOnChanges(): void {
    if (this.map) {
      this.updateLocations();
      this.updateGeometry();
    }
  }

  ngOnDestroy(): void {
    this.geometrySubscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
    this.startSubscription?.unsubscribe();
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.map?.setTarget(undefined);
    this.map = null;
  }

  private updateLocations(): void {
    this.selectedLocations = [];
    this.source.clear();
    this.source.addFeatures(this.locations.map(location => {
      const feature = new Feature(new Point(fromLonLat([location.longitude, location.latitude])));
      feature.set('location', location);
      return feature;
    }));
    if (this.locations.length) {
      this.map?.getView().fit(this.source.getExtent(), { padding: [48, 48, 48, 48], maxZoom: 15 });
    }
  }

  private loadGeometry(): void {
    this.geometrySubscription?.unsubscribe();
    this.geometryError = '';
    this.geometryData = null;
    this.geometrySource.clear();
    this.geometrySubscription = this.http.get<object>(`${environment.reviewApiUrl}/api/versions/${this.version}/osm-geometry`).subscribe({
      next: data => {
        this.geometryData = data;
        this.updateGeometry();
      },
      error: error => {
        this.geometryError = error instanceof HttpErrorResponse && error.status === 404
          ? 'Lokale OSM-geometrie ontbreekt voor deze versie.'
          : 'Lokale OSM-geometrie kon niet worden geladen.';
      },
    });
  }

  refreshGeometry(): void {
    if (this.geometryStarting || this.geometryRunning || this.geometryBusy) return;
    this.statusSubscription?.unsubscribe();
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.geometryStarting = true;
    this.startSubscription = this.http.post<{ state: string }>(`${environment.reviewApiUrl}/api/versions/${this.version}/osm-geometry`, {}).subscribe({
      next: () => {
        this.geometryStarting = false;
        this.geometryRunning = true;
        this.scheduleGeometryStatus();
      },
      error: error => {
        this.geometryStarting = false;
        const detail = error instanceof HttpErrorResponse ? error.error?.detail : null;
        this.geometryError = typeof detail === 'string' ? detail : 'Lokale OSM-geometrie kon niet worden geladen.';
        if (error instanceof HttpErrorResponse && error.status === 409) this.checkGeometryStatus(false);
      },
    });
  }

  private checkGeometryStatus(initial: boolean): void {
    this.statusSubscription?.unsubscribe();
    this.statusSubscription = this.http.get<{ state: string }>(`${environment.reviewApiUrl}/api/versions/${this.version}/osm-geometry/status`).subscribe({
      next: status => {
        if (status.state === 'running') {
          this.geometryRunning = true;
          this.geometryBusy = false;
          this.scheduleGeometryStatus();
        } else if (status.state === 'busy') {
          this.geometryRunning = false;
          this.geometryBusy = true;
          this.scheduleGeometryStatus();
        } else {
          const wasRunning = this.geometryRunning;
          this.geometryRunning = false;
          this.geometryBusy = false;
          if (status.state === 'completed' && (wasRunning || (initial && this.geometryError))) this.loadGeometry();
          if (status.state === 'failed' && (wasRunning || this.geometryError)) this.geometryError = 'Lokale OSM-geometrie kon niet worden geladen.';
        }
      },
      error: () => {
        if (this.geometryRunning || this.geometryBusy) {
          this.geometryRunning = false;
          this.geometryBusy = false;
          this.geometryError = 'De status van de lokale geometrie is niet beschikbaar.';
        }
      },
    });
  }

  private scheduleGeometryStatus(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.checkGeometryStatus(false), 2000);
  }

  private updateGeometry(): void {
    this.geometrySource.clear();
    if (!this.geometryData) return;
    const selectedIds = new Set(this.locations.map(location => location.candidateId).filter((id): id is string => !!id));
    const features = new GeoJSON().readFeatures(this.geometryData, { featureProjection: 'EPSG:3857' })
      .filter(feature => selectedIds.has(String(feature.getId())) && feature.getGeometry()?.getType() !== 'Point');
    const foundIds = new Set(features.map(feature => String(feature.getId())));
    this.missingContours = this.locations.filter(location => !location.candidateId || !foundIds.has(location.candidateId)).length;
    this.geometrySource.addFeatures(features);
  }
}
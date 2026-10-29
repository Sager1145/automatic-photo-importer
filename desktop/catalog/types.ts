import type {MediaKind, Metadata} from '../shared';

/** Serializable contracts shared by the worker, main process and renderer. */
export type NumericField = 'focalLengthMm'|'fNumber'|'exposureSeconds'|'iso';
export type CategoryField = NumericField|'camera'|'lens'|'format'|'captureYear'|'captureMonth'|'captureDay'|'captureYearMonth'|'nameInitial'|'name'|'mediaKind';
export type MetadataStatus = 'pending'|'ready'|'error';
export type PlacementStatus = 'unchecked'|'inPlace'|'misplaced'|'unclassifiable';
export type RootRole = 'photos'|'videos';
export interface CatalogValues {
  metadataStatus: MetadataStatus;
  metadataError?: string;
  captureRaw?: string;
  captureZone?: string;
  captureYear?: number;
  captureMonth?: number;
  /** Camera-local YYYY-MM-DD, independent of the host time zone. */
  captureDay?: string;
  make?: string;
  makeKey?: string;
  camera?: string;
  cameraKey?: string;
  lens?: string;
  lensKey?: string;
  focalLengthMm?: number;
  fNumber?: number;
  exposureSeconds?: number;
  iso?: number;
}
/** Left closed, right open, except the final bucket (maxInclusive). Absent endpoints are unbounded. */
export interface NumericBucket {min?:number;max?:number;maxInclusive:boolean;}
export interface NumericRange {min?:number;max?:number;maxInclusive?:boolean;}
/** Values/ranges within a filter are OR; separate filters, including repeated fields, are AND. */
export type Filter = ({blockId?:string} & (
  | {kind:'values';field:CategoryField;values:(string|number)[]}
  | {kind:'range';field:NumericField;min?:number;max?:number;/** Defaults true for user-entered closed ranges; false preserves a bucket's exclusive upper edge. */maxInclusive?:boolean}
  | {kind:'ranges';field:NumericField;ranges:NumericRange[]}
  | {kind:'missing';field:CategoryField}
  | {kind:'placement';status:PlacementStatus}));
export interface CatalogQuery {
  libraryId:string;
  facetBlockId?:string;
  filters:Filter[];
  /** Direct children only; absent searches the entire library. Root is ''. */
  parentPath?:string;
  nameContains?:string;
  sort:{field:'name'|'captured'|'format'|NumericField;direction:'asc'|'desc'};
  /** Opaque cursor bound to query conditions and catalog revision. */
  cursor?:string;
  /** Default 200; service caps at 500. */
  limit:number;
}
/** Exact integer decimal strings: no precision loss or BigInt across IPC. */
export interface CatalogStat {size:string;mtimeNs:string;ctimeNs:string;ino:string;dev?:string;}
export interface CatalogLibrary {
  destinationIndex?:number;
  libraryId:string;
  volumeId:string;
  /** False identifies a connection-scoped fallback identity, never reused after reconnect. */
  trustedVolumeId:boolean;
  relativeRoot:string;
  mountPath?:string;
  name:string;
  role:RootRole;
  online:boolean;
  rulesScope:string;
  revision:number;
}
export interface CatalogPlacement {
  status:PlacementStatus;
  actualRelativePath:string;
  expectedRoute?:{role:RootRole;relativePath:string};
  rulesScope:string;
  reason?:string;
  checkedAt?:string;
}
export interface CatalogRecord {
  fileId:string;
  libraryId:string;
  relativePath:string;
  parentPath:string;
  name:string;
  nameSortKey:string;
  nameInitial:string;
  stat:CatalogStat;
  mediaKind:MediaKind;
  /** Lower-case extension without the leading period. */
  extension:string;
  familyId?:string;
  companionOf?:string;
  values:CatalogValues;
  metadataVersion:number;
  /** Internal original interpreted metadata for route reuse, never effective/inherited routes. */
  routingMetadata?:Metadata;
  placement:CatalogPlacement;
  generation?:number;
}
/** File summaries omit raw tags and filesystem mount paths. */
export interface CatalogRow {
  fileId:string;libraryId:string;relativePath:string;parentPath:string;name:string;
  mediaKind:MediaKind;extension:string;size:string;metadataStatus:MetadataStatus;
  values:CatalogValues;placement:CatalogPlacement;companionCount:number;
  missing?:boolean;
}
export interface DirectoryRow {relativePath:string;name:string;count:number;}
export interface CatalogPage {rows:CatalogRow[];total:number;nextCursor?:string;revision:number;}
export interface DirectoryPage {rows:DirectoryRow[];nextCursor?:string;revision:number;}
export interface FieldCoverage {knownCount:number;missingCount:number;errorCount:number;pendingCount:number;}
export interface FacetRow {value:string|number;label:string;count:number;}
/** Counts exclude this block's own field filters (all same-field filters when facetBlockId is absent). */
export interface FacetResult extends FieldCoverage {
  field:CategoryField;rows:FacetRow[];/** Distinct known category rows before pagination; coverage counts files. */total:number;min?:number;max?:number;nextCursor?:string;revision:number;
}
export interface CatalogProgress {discovered:number;read:number;failed:number;total?:number;}
export interface CatalogStatus {
  libraryId:string;online:boolean;revision:number;dirty:boolean;
  state:'idle'|'scanning'|'paused'|'repairing'|'error';
  progress:CatalogProgress;
  total:number;checked:number;misplaced:number;unclassifiable:number;unchecked:number;
  lastCompletedAt?:string;lastCheckedAt?:string;error?:string;
}
export type ScanResult = 'complete'|'partial'|'cancelled';
export interface CatalogScanRun {
  runId:string;libraryId:string;scope:string[];generation:number;startRevision:number;
  startedAt:string;endedAt?:string;result?:ScanResult;
}
/** Only successful scope completion can mark unseen rows missing. Partial failures protect affected subtrees. */
export type CatalogScanEvent =
  | {kind:'begin';libraryId:string;scope:string[]}
  | {kind:'records';runId:string;records:CatalogRecord[]}
  | {kind:'end';runId:string;result:ScanResult};
export type CatalogChange =
  | {kind:'upsert';libraryId:string;record:CatalogRecord;mutationRevision:number}
  | {kind:'move';libraryId:string;fileId:string;oldRelativePath:string;relativePath:string;stat:CatalogStat;mutationRevision:number;placement?:CatalogPlacement}
  | {kind:'missing';libraryId:string;fileId?:string;relativePath:string;mutationRevision:number}
  | {kind:'invalidatePlacement';libraryId:string;rulesScope:string;mutationRevision:number}
  | {kind:'relinkCompanions';libraryId:string;fromFileId:string;toFileId:string;mutationRevision:number};
export interface CatalogMoveEvent {
  action:'organize'|'restore'|'undo'|'duplicateRemoval';
  libraryId:string;fileId?:string;oldRoot:string;oldRelativePath:string;
  newRoot?:string;newRelativePath?:string;stat?:CatalogStat;metadata?:Metadata;
}
export interface Catalog {
  /** Upsert configured libraries; absence/offline never removes indexed records. */
  configure(libraries:CatalogLibrary[]):Promise<void>;
  /** Internal bounded lookup (maximum 500 relative paths); never exposed wholesale to renderer. */
  records(libraryId:string,relativePaths:string[]):Promise<CatalogRecord[]>;
  file(libraryId:string,fileId:string):Promise<CatalogRecord|undefined>;
  beginScan(libraryId:string,scope:string[]):Promise<string>;
  ingest(runId:string,records:CatalogRecord[]):Promise<void>;
  endScan(runId:string,result:ScanResult):Promise<void>;
  apply(changes:CatalogChange[]):Promise<void>;
  query(query:CatalogQuery):Promise<CatalogPage>;
  directories(query:CatalogQuery):Promise<DirectoryPage>;
  facets(query:CatalogQuery,field:CategoryField):Promise<FacetResult>;
  status(libraryId:string):Promise<CatalogStatus>;
  close():Promise<void>;
}

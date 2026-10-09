export type Scope={chatId:string;branchId:string;revision:number;viewMode:'pov'|'author'};
export type Point={x:number;y:number};
export type Bounds=Point&{w:number;h:number};
export type SceneDocument={kind:'atlas-scene';version:1;generator:string;mapId:string;branchId:string;sourceRevision:number;units:'meters'|'cells';metersPerCell:number|null;metricQuality:string;inputSignature?:string;constraints?:Record<string,any>;layout:{kind:'floor'|'city'|'overview';bounds:Bounds;[key:string]:any}};
export type Diagnostic={code:string;path:string;message:string;severity:'warning'|'error';entityId:string|null;retryable:boolean;module:string};

/** 概览（M4）统一定义：与 02 §6.1 / §10 及 src/atlas-ops-normalize.ts 的枚举逐字一致。 */
export type OverviewSurface='mixed'|'urban'|'forest'|'mountain'|'water'|'indoor'|'void';
export type OverviewZoneRole='city'|'settlement'|'forest'|'water'|'mountain'|'ruins'|'district'|'campus'|'land'|'other';
export type OverviewZoneSize='small'|'medium'|'large';
export type OverviewSector='north'|'northeast'|'east'|'southeast'|'south'|'southwest'|'west'|'northwest';
export type OverviewDensity='low'|'medium'|'high';
export type OverviewWidthClass='narrow'|'medium'|'wide';
export type OverviewFeatureType='forest_texture'|'ridge'|'shore'|'building_cluster'|'road_texture'|'ruins_scatter'|'watercourse';
export type SceneQuality='estimated'|'confirmed';

/** AI 可提交的概览约束；程序独占字段（mapId/seed/scale/id/scope）不在其中。 */
export type OverviewSpec={
  mapId?:string;rebuild?:boolean;surface?:OverviewSurface;
  zones?:OverviewZoneSpec[];links?:OverviewLinkSpec[];features?:OverviewFeatureSpec[];
  deletes?:{zones?:string[];links?:string[];features?:string[]};
};
export type OverviewZoneSpec={id:string;name?:string;role?:OverviewZoneRole;size?:OverviewZoneSize;sector?:OverviewSector|'center';near?:string|null;quality?:SceneQuality};
export type OverviewLinkSpec={id:string;name?:string};
export type OverviewFeatureSpec={id:string;type:OverviewFeatureType;zoneId?:string;density?:OverviewDensity;fromSector?:OverviewSector;toSector?:OverviewSector;widthClass?:OverviewWidthClass;decorative?:boolean;quality?:SceneQuality};

/** 生成后的概览布局：形状/路线/地物都可直接绘制，且不含 SQL 实体身份。 */
export type OverviewPin=Point&{id:string;name?:string|null;type?:'location'|'person'|'item'|string;quality?:SceneQuality};
export type OverviewShape={id:string;name?:string|null;polygon:Point[];quality:SceneQuality;locked?:Point};
export type OverviewRoute={id:string;kind:'route';mapId?:string;path:Point[];quality:SceneQuality;dashed:boolean;progress?:number|null;fromLocationId?:string|null;toLocationId?:string|null};
export type OverviewFeature={id:string;type:OverviewFeatureType;zoneId?:string|null;density?:OverviewDensity;decorative:boolean;quality:SceneQuality;path?:Point[];width?:number;polygon?:Point[];fromSector?:OverviewSector;toSector?:OverviewSector;widthClass?:OverviewWidthClass};
export type OverviewLayout={kind:'overview';id:string;name:string;bounds:Bounds;surface:OverviewSurface;pins:OverviewPin[];shapes:OverviewShape[];routes:OverviewRoute[];features:OverviewFeature[];issues?:Array<{id:string;code:string}>};

/** 上下文锁：室内矩形（米）、确认点、任意确认多边形、确认路线几何；空间由 map.metersPerCell 决定。 */
export type LayoutLocks={
  rooms:Record<string,Bounds>;buildings:Record<string,Bounds>;actors:Record<string,Point>;
  points:Record<string,Point>;
  areas:Record<string,{kind:'polygon';quality:'confirmed';name?:string|null;points:Point[]}>;
  routes:Record<string,{quality:SceneQuality;dashed:boolean;path:Point[];fromLocationId?:string|null;toLocationId?:string|null}>;
};
export type PlacementKind='local'|'proxy';

export type GenerateContext={
  scope:Scope;currentScope?:Scope;
  map:{id:string;name?:string;containerLocationId?:string|null;metersPerCell:number|null;scaleQuality?:string;scaleLocked?:boolean;frame:Record<string,any>};
  entities:{locations:string[]|Set<string>;characters:string[]|Set<string>;items:string[]|Set<string>;routes?:string[]|Set<string>};
  locationsById?:Record<string,any>;routesById?:Record<string,any>;placement?:Record<string,PlacementKind>;
  previousScene?:SceneDocument|null;locks?:Partial<LayoutLocks>;seed?:string;
};
export type GenerateResult={ok:boolean;status:string;scene:SceneDocument|null;issues:Diagnostic[];kept?:SceneDocument|null;guard?:{scope:Scope;mapId:string;inputSignature:string};metricProposal?:{metersPerCell:number;scaleQuality:string;basis:Record<string,unknown>}|null};
export type RowMutation={table:string;rowId:string;before:Record<string,any>|null;after:Record<string,any>|null;sourceOpIds:string[];basis:Record<string,unknown>};
export type ScopeTicket={key:string|null;epoch:number};
export type Renderer={state:Record<string,any>;setScene(doc:SceneDocument|null,options?:{preserveCamera?:boolean}):boolean;setCamera(camera:{s:number;x:number;y:number}):boolean;setOverlays(rows:unknown[]):boolean;setBackgroundImage(image:CanvasImageSource|null,bounds:Bounds,opacity?:number):boolean;draw(timestamp?:number):void;schedule():void;zoomBy(mult:number,anchor?:Point):void;fit():void;resize():void;selectById(id:string):any;focus(id:string):boolean;entities():any[];hit(point:Point):any;setPaused(paused:boolean):void;destroy():void};
export declare const KIT_VERSION:string,SCENE_KIND:string,SCENE_VERSION:number,FRAME_SCENE_KEY:string;
export declare const LIMITS:Readonly<Record<string,number>>,DEFAULT_THEME:Readonly<Record<string,string>>,TOOL_NAMES:readonly string[];
export declare const OVERVIEW_FEATURE_TYPES:readonly OverviewFeatureType[];
export declare const OVERVIEW_SURFACES:readonly OverviewSurface[];
export declare const OVERVIEW_ZONE_ROLES:readonly OverviewZoneRole[];
export declare const OVERVIEW_ZONE_SIZES:readonly OverviewZoneSize[];
export declare const OVERVIEW_DENSITIES:readonly OverviewDensity[];
export declare const OVERVIEW_SECTORS:readonly OverviewSector[];
export declare const OVERVIEW_WIDTH_CLASSES:readonly OverviewWidthClass[];
export declare const CITY_ENCLOSURES:readonly ('open'|'wall')[];
export declare const SCENE_QUALITIES:readonly SceneQuality[];
export declare function clone<T>(value:T):T;
export declare function finite(value:unknown):value is number;
export declare function plain(value:unknown):value is Record<string,unknown>;
export declare function bytes(value:unknown):number;
export declare function stable(value:unknown):string;
export declare function diagnostic(code:string,path:string,message:string,options?:Partial<Diagnostic>):Diagnostic;
export declare function failure(code:string,path:string,message:string,extra?:Record<string,unknown>):GenerateResult;
export declare function normalizeScope(value:unknown):Scope;
export declare function scopeKey(value:Scope):string;
export declare function sameScope(a:Scope,b:Scope):boolean;
export declare function createScopeGate():{setScope(scope:Scope):ScopeTicket;capture():ScopeTicket;accept(ticket:ScopeTicket):boolean;invalidate():void};
export declare function parseWholeArguments(value:unknown):Record<string,unknown>;
export declare function checkSceneDocument(value:unknown):Diagnostic[];
export declare function generateFloor(input:Record<string,unknown>|string,context:GenerateContext):GenerateResult;
export declare function generateCity(input:Record<string,unknown>|string,context:GenerateContext):GenerateResult;
export declare function generateOverview(input:OverviewSpec|Record<string,unknown>|string,context:GenerateContext):GenerateResult;
export declare function getSpatialToolDefinitions():Array<{name:string;description:string;inputSchema:Record<string,unknown>}>;
export declare function executeSpatialTool(call:{name:string;arguments:unknown},context:GenerateContext&Record<string,any>):GenerateResult|Record<string,any>;
export declare function pointOnPath(points:Point[],progress:number):Point&{distance:number;total:number}|null;
export declare function placeMarkers(input:{region:Point[];markers:any[];obstacles?:Bounds[];previous?:any[];step?:number;clearance?:number}):Record<string,any>;
export declare function buildOverlays(input:{mapId:string;rows:any[];positions?:any[];selectedEntityId?:string|null;showAllRelations?:boolean}):Record<string,any>;
export declare function buildSceneMutation(input:{result:GenerateResult;mapRow:Record<string,any>;scope:Scope;currentScope:Scope;turnId:string;operationId:string;expectedRowRev:number}):{ok:boolean;status:string;mutation?:RowMutation|null;issues:Diagnostic[]};
export declare function readSceneFrame(frame:unknown,scope:{branchId:string;mapId:string}):{ok:boolean;scene:SceneDocument|null;issues:Diagnostic[]};
export declare function sceneLocationGeometry(scene:SceneDocument):any[];
export declare function unwrapViewResult(value:unknown,mode?:'direct'|'state-map'):Record<string,any>;
export declare function projectMapView(input:{view:Record<string,any>;mapId:string;scope:Scope}):{ok:boolean;status:string;scene:SceneDocument|null;coarseList?:any[];issues:Diagnostic[]};
export declare function filterSceneForView(scene:SceneDocument,options:{scope:Scope;visibleLocations?:string[];visibleCharacters?:string[];visibleItems?:string[];names?:Record<string,string>}):{ok:boolean;scene:SceneDocument|null;issues:Diagnostic[]};
export declare function buildMapTree(maps:any[],locations:any[]):{nodes:any[];childMapsByLocation:Record<string,string[]>;issues:Diagnostic[]};
export declare function publicMapFrame(frame:Record<string,unknown>):Record<string,unknown>;
export declare function hydrateScene(scene:SceneDocument,projection:Record<string,any>):{ok:boolean;scene:SceneDocument|null;issues:Diagnostic[]};
export declare function buildLayoutContext(input:{scope:Scope;mapRow:Record<string,any>;locations?:any[];characters?:any[];items?:any[];routes?:any[]}):{ok:boolean;context?:GenerateContext;issues:Diagnostic[]};
export declare function createSpatialRenderer(options:{canvas:HTMLCanvasElement;onSelect?:(entity:any)=>void;onHover?:(entity:any,point:Point|null)=>void;onViewport?:(viewport:any)=>void;onIssue?:(issue:Diagnostic)=>void;theme?:Record<string,string>;scaleBarWidth?:number;ownsGestures?:boolean;painterFactory?:Function;animate?:boolean}):Renderer;
export declare function compileSceneGroup(options:{request:{kind:'floor'|'city'|'overview';spec:Record<string,unknown>};scope:Scope;currentScope:Scope;mapRow:Record<string,any>;locations:any[];characters?:any[];items?:any[];routes?:any[];turnId:string;operationId:string}):Record<string,any>;
export declare function applySceneGroup(db:any,group:any,ports:{insideCandidateTransaction:true;applyGroups:Function;queryBound:Function;isCurrent:()=>boolean;branchId:string;turnId:string;attemptId?:string}):Record<string,any>;
export declare function prepareInitialFrame(input:{mapRow:Record<string,any>;scope:Scope;currentScope:Scope;locations?:any[];kind?:'floor'|'city'|'overview';widthM?:number;heightM?:number;turnId:string;operationId:string;expectedRowRev:number}):Record<string,any>;

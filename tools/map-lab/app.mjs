import L from 'leaflet';
import { buildAtlasRenderScene, atlasToSimple, simpleToAtlas } from '../../src/atlas-map-render-model.ts';
import { getVisibleGridPaths } from '../../src/atlas-map-grid.ts';
import { createMapLabFixture } from './fixtures.mjs';
window.L = L;
await import('leaflet.markercluster');

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const map = L.map('map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 8, zoomSnap: 0,
  zoomDelta: .5, attributionControl: false, zoomAnimation: false, fadeAnimation: false });
map.createPane('architecture'); map.getPane('architecture').style.zIndex = '250';
const geometry = L.layerGroup().addTo(map);
const labels = L.layerGroup().addTo(map);
const places = L.layerGroup().addTo(map);
const grid = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
grid.classList.add('lab-grid'); map.getContainer().append(grid);
const cameraMemory = new Map();
let scenario = 'school', fixture = createMapLabFixture(), scene, mapId = null, group, gridState;
const originalSources = new Map();
const fixtures = [];
const sceneKey = () => `${scenario}|${mapId}`;
const saveCamera = () => { if (mapId && map._loaded) cameraMemory.set(sceneKey(), { center: map.getCenter(), zoom: map.getZoom() }); };
const areaBounds = area => [atlasToSimple({ x: area.x, y: area.y + area.height }), atlasToSimple({ x: area.x + area.width, y: area.y })];
const pointIcon = (name, kind) => {
  const body = element('span', kind === 'character' ? name.slice(0, 1) : `◆ ${name}`, `lab-pin lab-pin--${kind}`);
  return L.divIcon({ html: body, className: 'lab-icon', iconSize: null });
};
function pointDetail(point) {
  const body = element('div'); body.append(element('strong', point.name));
  body.append(element('p', `${point.kind === 'character' ? '人物' : '地点'} · ${scene.name}`));
  if (point.kind === 'location') {
    const button = element('button', '进入内部地图'); button.dataset.enterId = point.id;
    button.onclick = () => openScene(point.id); body.append(button);
  } else body.append(element('p', point.positionHint || '当前位置已记录'));
  return body;
}
function addArea(area, kind) {
  const rect = L.rectangle(areaBounds(area), { pane: 'architecture', weight: kind === 'outline' ? 3 : 1.5,
    color: kind === 'passage' ? '#a98d55' : '#65918b', fillColor: kind === 'passage' ? '#e7d8b8' : '#adc8bf',
    fillOpacity: kind === 'outline' ? .04 : .19, interactive: Boolean(area.childId) }).addTo(geometry);
  if (area.childId) {
    rect.on('mouseover', () => rect.setStyle({ fillOpacity: .36, weight: 2.5 }));
    rect.on('mouseout', () => rect.setStyle({ fillOpacity: .19, weight: 1.5 }));
    rect.on('click', () => openScene(area.childId));
  }
  if (area.name && kind !== 'outline' && !area.childId) fixtures.push({ area, name: area.name });
}
function renderCrumbs() {
  const ids = [mapId];
  while (ids[0] !== 'world') ids.unshift(fixture.parents[ids[0]] ?? 'world');
  const crumbs = document.querySelector('#crumbs'); crumbs.replaceChildren();
  for (const id of ids) {
    const button = element('button', fixture.names[id] ?? '地点'); button.dataset.mapId = id;
    button.onclick = () => openScene(id); crumbs.append(button);
    if (id !== ids.at(-1)) crumbs.append(element('span', '›'));
  }
}
function updateVisuals() {
  if (!scene) return;
  const size = map.getSize(), origin = map.latLngToContainerPoint(atlasToSimple({ x: 0, y: 0 }));
  gridState = getVisibleGridPaths({ camera: { k: 2 ** map.getZoom(), tx: origin.x, ty: origin.y },
    viewport: { width: size.x, height: size.y }, frame: scene.frame, extent: 'viewport', devicePixelRatio: window.devicePixelRatio });
  grid.setAttribute('viewBox', `0 0 ${size.x} ${size.y}`); grid.replaceChildren();
  for (const [pathData, className] of [[gridState.minorPath, 'minor'], [gridState.majorPath, 'major']]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData); path.setAttribute('class', className); grid.append(path);
  }
  labels.clearLayers();
  for (const fixture of fixtures) {
    if (fixture.area.width * 2 ** map.getZoom() < 60) continue;
    const center = { x: fixture.area.x + fixture.area.width / 2, y: fixture.area.y + fixture.area.height / 2 };
    L.marker(atlasToSimple(center), { interactive: false, icon: L.divIcon({
      html: element('span', fixture.name, 'lab-fixture'), className: 'lab-label', iconSize: null }) }).addTo(labels);
  }
  const unit = scene.frame.cols === 12 ? '12 × 8 格' : `${scene.frame.cols} × ${scene.frame.rows} 格`;
  document.querySelector('#status').textContent = `${scene.name} · ${unit} · ${scene.markers.filter(p => p.kind === 'character').length} 人 · ${scene.truncated ? `${scene.truncated} 项未显示` : '拖动平移，滚轮缩放'}`;
}
function openScene(nextId) {
  saveCamera(); map.closePopup(); geometry.clearLayers(); labels.clearLayers(); places.clearLayers();
  if (group) { group.unspiderfy(); map.removeLayer(group); }
  mapId = nextId; fixtures.length = 0;
  scene = buildAtlasRenderScene({ view: fixture.view, mapId, name: fixture.names[mapId] ?? '地点' });
  if (scene.floorplan) {
    addArea(scene.floorplan.bounds, 'outline');
    scene.floorplan.regions.forEach(area => addArea(area, 'room'));
    scene.floorplan.passages.forEach(area => addArea(area, 'passage'));
  } else if (mapId === '6') {
    addArea({ x: .5, y: .5, width: 11, height: 7, name: '' }, 'outline');
    for (const [name, x, y, width, height] of [['黑板', 4, .8, 4, .4], ['讲台', 5, 1.5, 2, .5],
      ...[2.5, 5.5, 8.5].flatMap(x => [3, 5].map(y => ['课桌', x, y, 1.5, .75]))])
      addArea({ name, x, y, width, height }, 'fixture');
  }
  group = L.markerClusterGroup({ animate: false, maxClusterRadius: 44, showCoverageOnHover: false,
    zoomToBoundsOnClick: false, spiderfyOnMaxZoom: false,
    iconCreateFunction: cluster => L.divIcon({ html: element('span', `${cluster.getChildCount()} 人`, 'lab-cluster'),
      className: 'lab-icon', iconSize: [46, 32] }) });
  for (const point of scene.markers) {
    const pin = L.marker(atlasToSimple(point), { icon: pointIcon(point.name, point.kind), title: point.name });
    pin.atlasPoint = point;
    pin.bindPopup(() => pointDetail(point));
    if (point.kind === 'character') group.addLayer(pin); else pin.addTo(places);
  }
  group.on('clusterclick', event => {
    const body = element('div'), members = event.layer.getAllChildMarkers().sort((a, b) => a.atlasPoint.id.localeCompare(b.atlasPoint.id));
    body.append(element('strong', `${members.length} 人在此`));
    const spread = element('button', '展开标记'); spread.dataset.spread = 'true';
    spread.onclick = () => { map.closePopup(); event.layer.spiderfy(); }; body.append(spread);
    const list = element('div', undefined, 'lab-members');
    for (const pin of members) {
      const button = element('button', pin.atlasPoint.name); button.dataset.memberId = pin.atlasPoint.id;
      button.onclick = () => L.popup().setLatLng(pin.getLatLng()).setContent(pointDetail(pin.atlasPoint)).openOn(map);
      list.append(button);
    }
    body.append(list); L.popup({ maxWidth: 280 }).setLatLng(event.latlng).setContent(body).openOn(map);
  });
  map.addLayer(group);
  const saved = cameraMemory.get(sceneKey());
  if (saved) map.setView(saved.center, saved.zoom, { animate: false });
  else {
    const area = scene.floorplan?.bounds ?? { x: 0, y: 0, width: scene.frame.cols, height: scene.frame.rows };
    map.fitBounds(areaBounds(area), { padding: [28, 28], animate: false });
  }
  renderCrumbs(); updateVisuals();
}
map.on('moveend zoomend resize', () => { saveCamera(); updateVisuals(); });
document.querySelector('#scenario').onchange = event => {
  saveCamera(); mapId = null; scenario = event.target.value; fixture = createMapLabFixture(scenario === 'crowd');
  originalSources.set(scenario, JSON.stringify(fixture)); openScene(scenario === 'building' ? '5' : '6');
};
document.querySelector('#home').onclick = () => openScene('world');
document.querySelector('#locate').onclick = () => { openScene('6'); map.panTo(atlasToSimple({ x: 6, y: 4 })); };
originalSources.set(scenario, JSON.stringify(fixture)); openScene('6');
window.atlasMapLab = { map, openScene, coordinates: { atlasToSimple, simpleToAtlas },
  inspect: () => ({ mapId, scene: structuredClone(scene), grid: gridState, sourcesUnchanged: originalSources.get(scenario) === JSON.stringify(fixture),
    markers: group.getLayers().map(pin => ({ id: pin.atlasPoint.id, latlng: pin.getLatLng(), original: atlasToSimple(pin.atlasPoint) })),
    camera: { ...simpleToAtlas(map.getCenter()), zoom: map.getZoom() } }) };

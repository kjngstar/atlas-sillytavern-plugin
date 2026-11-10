const pt = (x, y) => ({ x, y });

/** Build the road network before placing any parcels. All dimensions scale
 * with the map; the caller keeps the actual building sizes and checks fit. */
export function streetTown(spec) {
  const { width: w, height: h, riverWidth } = spec;
  const unit = Math.min(w, h);
  const river = { cx: w * .68, amplitude: w * .014, width: riverWidth, height: h };
  const riverEdge = river.amplitude + river.width / 2;
  const westLimit = riverWidth ? river.cx - riverEdge - unit * .018 : w * .68;
  const eastLimit = riverWidth ? river.cx + riverEdge + unit * .018 : westLimit;
  const westStreet = westLimit * .39;
  const eastStreet = westLimit * .82;
  const north = h * .22;
  const middle = h * .48;
  const south = h * .75;
  const streets = [];
  const road = (id, a, b, width, fields = {}) => streets.push({ id, a, b, width, ...fields });
  const sideWidth = unit * .035;

  road('avenue', pt(0, middle), pt(westLimit, middle), unit * .052);
  road('town:west-street', pt(westStreet, north), pt(westStreet, south), sideWidth);
  road('town:east-street', pt(eastStreet, north), pt(eastStreet, south), sideWidth);
  road('town:north-street', pt(westStreet, north), pt(eastStreet, north), sideWidth);
  road('town:south-street', pt(westStreet, south), pt(eastStreet, south), sideWidth);

  const eastForest = spec.districts.find(d => d.bank === 'east' && ['forest', 'woods'].includes(d.role));
  const eastDistrict = spec.districts.find(d => d.bank === 'east' && !d.role);
  const easternDestination = eastForest ?? eastDistrict;
  const bridges = spec.bridgeIds ?? [];
  if (easternDestination || bridges.length) {
    const eastLanding = eastLimit + (w - eastLimit) * .26;
    const eastBank = easternDestination ? { districtId: easternDestination.id } : {};
    const crossing = id => id ? { bridgeLocationId: id } : eastBank;
    const hasSouthCrossing = bridges.length ? bridges.length > 1 : !!eastForest;
    road('town:north-crossing', pt(eastStreet, north), pt(eastLanding, north), sideWidth, crossing(bridges[0]));
    if (hasSouthCrossing) {
      road('town:south-crossing', pt(eastStreet, south), pt(eastLanding, south), sideWidth, crossing(bridges[1]));
    }
    if (eastForest && hasSouthCrossing) {
      const outer = eastLimit + (w - eastLimit) * .72;
      const points = [pt(eastLanding, north), pt(outer, north), pt(outer, h * .40),
        pt(outer + (w - outer) * .32, h * .47), pt(outer + (w - outer) * .32, h * .64),
        pt(outer - (w - outer) * .23, south), pt(eastLanding, south)];
      points.slice(1).forEach((b, i) => road('town:forest-path:' + i, points[i], b,
        unit * .022, { kind: 'path', ...eastBank }));
    }
  }

  const terrain = spec.districts.filter(d => d.role).map(d => {
    if (d.role === 'lake') {
      const span = d.bank === 'west' ? westLimit : w - eastLimit;
      const x = d.bank === 'west' ? span * .30 : eastLimit + span * .35;
      const y = h * .875;
      const rx = span * .22, ry = h * .112;
      const shoreline = [.86, 1, .88, .97, .84, .94, .83, .98, .88, 1, .87, .94];
      const polygon = shoreline.map((scale, i) => {
        const angle = i * Math.PI / 6;
        return pt(x + Math.cos(angle) * rx * scale, y + Math.sin(angle) * ry * scale);
      });
      return { ...d, site: pt(x, y), polygon };
    }
    const deep = d.role === 'woods';
    if (d.bank === 'east') {
      const span = w - eastLimit;
      const x = eastLimit + span * (deep ? .31 : .02);
      const top = h * (deep ? .07 : .012);
      const bottom = h * (deep ? .945 : .988);
      const step = span * .09;
      const polygon = [pt(x + step, top), pt(w, top), pt(w, bottom), pt(x, bottom),
        pt(x, h * .79), pt(x + step * 1.5, h * .61), pt(x + step, h * .36), pt(x, h * .22)];
      return { ...d, site: pt(x + (w - x) * (deep ? .58 : .22), h * (deep ? .55 : .87)), polygon };
    }
    const x = westLimit * (deep ? .69 : .96);
    const y = h * (deep ? .11 : .18);
    const polygon = [pt(0, 0), pt(x, 0), pt(x, y * .47), pt(x * .65, y * .62),
      pt(x * .44, y), pt(x * .22, y * 1.2), pt(0, y * 1.55)];
    return { ...d, site: pt(x * .24, y * .48), polygon };
  });
  return { river, westLimit, eastLimit, streets, terrain, parcelGap: unit * .009 };
}

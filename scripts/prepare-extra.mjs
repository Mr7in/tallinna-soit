// Extra world data (run after prepare-city):
//   - index of Maa- ja Ruumiamet textured LOD2 buildings (I3S)  -> public/city/f_X_Y.bin
//   - OpenStreetMap roads, crossings, lamps, traffic lights, bus stops, cameras -> public/city/o_X_Y.json
// Credits: textured buildings Maa- ja Ruumiamet; roads and street furniture © OpenStreetMap contributors (ODbL)
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { toLest } from '../src/lest.js';

const OUT = 'public/city';
const GRID_E = 40500, GRID_N = 5993000, CHUNK = 250;
const OE = 542000, ON = 6589000;
const E0 = 530000, E1 = 560000, N0 = 6570000, N1 = 6600000;
if ( existsSync( OUT + '/extra.json' ) && ! process.env.FORCE_CITY ) { console.log( 'extra data already prepared' ); process.exit( 0 ); }
const CACHE = process.env.CITY_CACHE;
const extra = { facadeChunks: [], osmChunks: [] };

const chunkOfEN = ( E, N ) => [ Math.floor( ( E - GRID_E ) / CHUNK ), Math.floor( ( N - GRID_N ) / CHUNK ) ];

// =============== textured buildings: crawl the I3S node pages once, keep the textured leaves ===============
console.log( 'facades…' );
try {

	const U = 'https://tiles.arcgis.com/tiles/ZYGCYltwz5ExeoGm/arcgis/rest/services/hooned_lod2_tallinn_slpk/SceneServer/layers/0';
	const leaves = [];
	let next = 0, end = false, pages = 0;
	const page = async p => {

		for ( let a = 0; a < 4; a ++ ) {

			try {

				const r = await fetch( `${U}/nodepages/${p}?f=json` );
				if ( r.status === 404 || r.status === 400 ) return null;
				if ( r.ok ) { const j = await r.json(); return j.nodes && j.nodes.length ? j.nodes : null; }

			} catch ( e ) { /* retry */ }
			await new Promise( r => setTimeout( r, 500 * ( a + 1 ) ) );

		}

		return undefined;

	};

	await Promise.all( Array.from( { length: 16 }, async () => {

		while ( ! end ) {

			const p = next ++;
			const ns = await page( p );
			if ( ns === null ) { end = true; break; }
			if ( ! ns ) continue;
			pages ++;
			for ( const n of ns ) {

				if ( n.children && n.children.length ) continue;
				const m = n.mesh;
				if ( ! m || m.material.definition !== 2 || m.geometry.definition !== 1 ) continue;
				leaves.push( [ m.geometry.resource, n.obb.center[ 0 ], n.obb.center[ 1 ], n.obb.center[ 2 ], Math.hypot( ...n.obb.halfSize ), m.material.texelCountHint || 0, m.geometry.vertexCount ] );

			}

		}

	} ) );
	const by = new Map();
	for ( const l of leaves ) {

		const key = chunkOfEN( l[ 1 ], l[ 2 ] ).join( '_' );
		if ( ! by.has( key ) ) by.set( key, [] );
		by.get( key ).push( l[ 0 ], l[ 1 ] - OE, - ( l[ 2 ] - ON ), l[ 3 ], l[ 4 ], l[ 5 ], l[ 6 ] );

	}

	for ( const [ key, a ] of by ) {

		writeFileSync( `${OUT}/f_${key}.bin`, Buffer.from( new Float32Array( a ).buffer ) );
		extra.facadeChunks.push( key.split( '_' ).map( Number ) );

	}

	console.log( 'facade pages', pages, 'leaves', leaves.length, 'chunks', by.size );

} catch ( e ) { console.log( 'facades skipped:', String( e ) ); }

// =============== OpenStreetMap ===============
console.log( 'osm…' );
try {

	let gz;
	const local = CACHE && CACHE + '/Tallinn.osm.gz';
	if ( local && existsSync( local ) ) gz = readFileSync( local );
	else {

		for ( let a = 0; a < 3 && ! gz; a ++ ) {

			try {

				const r = await fetch( 'https://download.bbbike.org/osm/bbbike/Tallinn/Tallinn.osm.gz', { headers: { 'User-Agent': 'tallinna-soit-build/1.0' } } );
				if ( r.ok ) gz = Buffer.from( await r.arrayBuffer() );

			} catch ( e ) { console.log( 'osm fetch failed', String( e ) ); }

		}

	}

	if ( ! gz ) throw new Error( 'no osm download' );
	const xml = gunzipSync( gz ).toString( 'utf8' );
	console.log( 'osm xml', ( xml.length / 1e6 ).toFixed( 0 ), 'MB' );

	// ---- parse (osmium writes one element per line) ----
	let cap = 1 << 21, nn = 0;
	let nid = new Float64Array( cap ), nx = new Float32Array( cap ), nz = new Float32Array( cap );
	const nodeTags = []; // [index, tags]
	const ways = [];
	let cur = null, curTags = null, curType = 0;
	const attr = ( line, k ) => {

		const i = line.indexOf( ' ' + k + '="' );
		if ( i < 0 ) return null;
		const s = i + k.length + 3;
		return line.slice( s, line.indexOf( '"', s ) );

	};

	const unesc = s => s.replace( /&quot;/g, '"' ).replace( /&apos;/g, "'" ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' ).replace( /&amp;/g, '&' );
	let pos = 0;
	while ( pos < xml.length ) {

		let e = xml.indexOf( '\n', pos );
		if ( e < 0 ) e = xml.length;
		const line = xml.slice( pos, e ).trim();
		pos = e + 1;
		if ( line.startsWith( '<node ' ) ) {

			const lat = + attr( line, 'lat' ), lon = + attr( line, 'lon' );
			const { E, N } = toLest( lat, lon );
			if ( nn >= cap ) {

				cap *= 2;
				const a = new Float64Array( cap ); a.set( nid ); nid = a;
				const b = new Float32Array( cap ); b.set( nx ); nx = b;
				const c = new Float32Array( cap ); c.set( nz ); nz = c;

			}

			nid[ nn ] = + attr( line, 'id' );
			nx[ nn ] = E - OE;
			nz[ nn ] = - ( N - ON );
			if ( ! line.endsWith( '/>' ) ) { curType = 1; cur = nn; curTags = {}; }
			nn ++;

		} else if ( line.startsWith( '<way ' ) ) {

			curType = 2; cur = []; curTags = {};

		} else if ( line.startsWith( '<nd ' ) ) {

			cur.push( + attr( line, 'ref' ) );

		} else if ( line.startsWith( '<tag ' ) && curTags ) {

			curTags[ attr( line, 'k' ) ] = unesc( attr( line, 'v' ) );

		} else if ( line === '</node>' ) {

			nodeTags.push( [ cur, curTags ] );
			curTags = null; curType = 0;

		} else if ( line === '</way>' ) {

			if ( curTags.highway || curTags[ 'area:highway' ] || curTags.amenity === 'parking' || /^(fence|hedge|wall)$/.test( curTags.barrier || '' ) ) ways.push( [ cur, curTags ] );
			curTags = null; curType = 0;

		} else if ( line.startsWith( '<relation' ) ) break;

	}

	// node lookup by id (ids are sorted in osmium output; sort defensively)
	let order = null;
	for ( let i = 1; i < nn; i ++ ) if ( nid[ i ] < nid[ i - 1 ] ) { order = true; break; }
	if ( order ) {

		const idx = Array.from( { length: nn }, ( _, i ) => i ).sort( ( a, b ) => nid[ a ] - nid[ b ] );
		const a = new Float64Array( nn ), b = new Float32Array( nn ), c = new Float32Array( nn ), remap = new Int32Array( nn );
		idx.forEach( ( o, i ) => { a[ i ] = nid[ o ]; b[ i ] = nx[ o ]; c[ i ] = nz[ o ]; remap[ o ] = i; } );
		nid = a; nx = b; nz = c;
		for ( const t of nodeTags ) t[ 0 ] = remap[ t[ 0 ] ];

	}

	const find = id => {

		let lo = 0, hi = nn - 1;
		while ( lo <= hi ) {

			const m = ( lo + hi ) >> 1;
			if ( nid[ m ] === id ) return m;
			if ( nid[ m ] < id ) lo = m + 1; else hi = m - 1;

		}

		return - 1;

	};

	console.log( 'nodes', nn, 'tagged', nodeTags.length, 'ways', ways.length );

	// ---- classify roads ----
	const CAR = { motorway: [ 4, 3.6 ], trunk: [ 4, 3.5 ], primary: [ 4, 3.4 ], secondary: [ 2, 3.4 ], tertiary: [ 2, 3.3 ], unclassified: [ 2, 3.0 ], residential: [ 2, 3.0 ], living_street: [ 2, 2.8 ], service: [ 1, 4.0 ], road: [ 2, 3.0 ], busway: [ 2, 3.4 ] };
	const FOOT = { footway: 2.4, pedestrian: 4, path: 1.8, cycleway: 2.4, steps: 2.4, bridleway: 2, corridor: 0, track: 3.2 };
	const MAJOR = new Set( [ 'motorway', 'trunk', 'primary', 'secondary' ] );
	const roads = [];
	const useCount = new Uint8Array( nn );
	const nodeWays = new Map(); // node index -> [road index, position in road]
	for ( const [ refs, t ] of ways ) {

		let hw = t.highway || '';
		const link = hw.endsWith( '_link' );
		if ( link ) hw = hw.slice( 0, - 5 );
		if ( t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage' ) continue;
		if ( t.area === 'yes' || t[ 'area:highway' ] || t.amenity === 'parking' ) continue; // areas handled below
		const pts = refs.map( find );
		if ( pts.some( i => i < 0 ) || pts.length < 2 ) continue;
		let kind, width, lanes = 0, oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || hw === 'motorway';
		if ( CAR[ hw ] ) {

			kind = MAJOR.has( hw ) ? 1 : hw === 'service' ? 3 : 2;
			lanes = parseInt( t.lanes ) || ( link ? 1 : oneway ? Math.max( 1, CAR[ hw ][ 0 ] / 2 ) : CAR[ hw ][ 0 ] );
			if ( t.service === 'parking_aisle' ) lanes = 2;
			if ( t.service === 'driveway' ) lanes = 1;
			width = lanes * CAR[ hw ][ 1 ];
			if ( hw === 'service' ) width = t.service === 'driveway' ? 3 : t.service === 'parking_aisle' ? 5.5 : 4.5;

		} else if ( FOOT[ hw ] ) {

			kind = hw === 'track' ? 5 : hw === 'cycleway' ? 6 : 4;
			width = FOOT[ hw ];

		} else continue;

		const w = parseFloat( t.width );
		if ( w > 1 && w < 40 ) width = w;
		const sw = t.sidewalk || t[ 'sidewalk:both' ] && 'both' || '';
		const side = sw === 'both' || sw === 'yes' ? 3 : sw === 'left' ? 1 : sw === 'right' ? 2 : 0;
		const surf = /paving|sett|cobble|stone|brick/.test( t.surface || '' ) ? 1 : /gravel|dirt|ground|compacted|sand|grass|fine/.test( t.surface || '' ) ? 2 : 0;
		const ri = roads.length;
		roads.push( { pts, kind, width, lanes, oneway: oneway ? 1 : 0, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0, side, surf, hw } );
		if ( kind <= 3 ) pts.forEach( ( p, k ) => {

			useCount[ p ] = Math.min( 255, useCount[ p ] + ( k === 0 || k === pts.length - 1 ? 1 : 2 ) );
			if ( ! nodeWays.has( p ) ) nodeWays.set( p, [] );
			nodeWays.get( p ).push( [ ri, k ] );

		} );

	}

	// ---- spatial hash of car road segments (to orient lamps, stops and cameras) ----
	const CELL = 20, seg = new Map();
	roads.forEach( ( r, ri ) => {

		if ( r.kind > 3 ) return;
		for ( let k = 0; k + 1 < r.pts.length; k ++ ) {

			const a = r.pts[ k ], b = r.pts[ k + 1 ];
			const key = Math.floor( ( nx[ a ] + nx[ b ] ) / 2 / CELL ) + ',' + Math.floor( ( nz[ a ] + nz[ b ] ) / 2 / CELL );
			if ( ! seg.has( key ) ) seg.set( key, [] );
			seg.get( key ).push( ri, k );

		}

	} );
	const nearestRoad = ( x, z, maxD = 25 ) => {

		let best = null, bd = maxD;
		const cx = Math.floor( x / CELL ), cz = Math.floor( z / CELL );
		for ( let i = - 2; i <= 2; i ++ ) for ( let j = - 2; j <= 2; j ++ ) {

			const L = seg.get( ( cx + i ) + ',' + ( cz + j ) );
			if ( ! L ) continue;
			for ( let q = 0; q < L.length; q += 2 ) {

				const r = roads[ L[ q ] ], a = r.pts[ L[ q + 1 ] ], b = r.pts[ L[ q + 1 ] + 1 ];
				const ax = nx[ a ], az = nz[ a ], dx = nx[ b ] - ax, dz = nz[ b ] - az;
				const l2 = dx * dx + dz * dz || 1;
				const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( z - az ) * dz ) / l2 ) );
				const px = ax + dx * t, pz = az + dz * t, d = Math.hypot( x - px, z - pz );
				if ( d < bd ) { bd = d; best = { px, pz, d, dx, dz, r }; }

			}

		}

		return best;

	};

	// ---- per chunk output ----
	const chunks = new Map();
	const C = ( x, z ) => {

		const [ a, b ] = chunkOfEN( x + OE, - z + ON );
		const key = a + '_' + b;
		let c = chunks.get( key );
		if ( ! c ) chunks.set( key, c = { w: [], j: [], x: [], a: [], p: [], b: [] } );
		return c;

	};

	const inside = ( x, z ) => x + OE > E0 && x + OE < E1 && - z + ON > N0 && - z + ON < N1;
	const r2 = v => Math.round( v * 100 ) / 100;
	// terrain heights (DTM tiles written by prepare-city) for bridge decks
	const man = JSON.parse( readFileSync( OUT + '/manifest.json', 'utf8' ) ), T = man.terrain, tileCache = new Map();
	const terrain = ( x, z ) => {

		const E = x + OE, N = - z + ON, span = T.tile * T.cell;
		const tx = Math.floor( ( E - T.e0 ) / span ), ty = Math.floor( ( N - T.n0 ) / span ), key = tx + '_' + ty;
		if ( ! tileCache.has( key ) ) {

			const f = `${OUT}/h_${key}.bin`;
			tileCache.set( key, existsSync( f ) ? new Int16Array( readFileSync( f ).buffer.slice( 0 ) ) : null );

		}

		const d = tileCache.get( key );
		if ( ! d ) return 0;
		const w = T.tile + 1, gx = ( E - T.e0 - tx * span ) / T.cell, gy = ( N - T.n0 - ty * span ) / T.cell;
		const x0 = Math.max( 0, Math.min( w - 2, Math.floor( gx ) ) ), y0 = Math.max( 0, Math.min( w - 2, Math.floor( gy ) ) );
		const ax = gx - x0, ay = gy - y0;
		return ( ( d[ y0 * w + x0 ] * ( 1 - ax ) + d[ y0 * w + x0 + 1 ] * ax ) * ( 1 - ay ) + ( d[ ( y0 + 1 ) * w + x0 ] * ( 1 - ax ) + d[ ( y0 + 1 ) * w + x0 + 1 ] * ax ) * ay ) / 10;

	};

	// bridges: straight decks from abutment to abutment (heights from the terrain at both ends)
	let decks = 0;
	for ( const r of roads ) {

		if ( ! r.bridge ) continue;
		const P = r.pts, cum = [ 0 ];
		for ( let k = 1; k < P.length; k ++ ) cum.push( cum[ k - 1 ] + Math.hypot( nx[ P[ k ] ] - nx[ P[ k - 1 ] ], nz[ P[ k ] ] - nz[ P[ k - 1 ] ] ) );
		const L = cum[ cum.length - 1 ] || 1;
		const hA = terrain( nx[ P[ 0 ] ], nz[ P[ 0 ] ] ), hB = terrain( nx[ P[ P.length - 1 ] ], nz[ P[ P.length - 1 ] ] );
		const ys = P.map( ( p, k ) => {

			const t = cum[ k ] / L;
			return hA + ( hB - hA ) * t + Math.sin( Math.PI * t ) * Math.min( 0.8, L * 0.01 );

		} );
		let piece = null, pkey = null;
		for ( let k = 0; k + 1 < P.length; k ++ ) {

			const mx = ( nx[ P[ k ] ] + nx[ P[ k + 1 ] ] ) / 2, mz = ( nz[ P[ k ] ] + nz[ P[ k + 1 ] ] ) / 2;
			if ( ! inside( mx, mz ) ) { piece = null; continue; }
			const c = C( mx, mz );
			if ( c !== pkey || ! piece ) {

				piece = [ r.kind, r2( r.width ), r.lanes, r.oneway, [ r2( nx[ P[ k ] ] ), r2( nz[ P[ k ] ] ), r2( ys[ k ] ) ] ];
				( c.d || ( c.d = [] ) ).push( piece );
				pkey = c;
				decks ++;

			}

			piece[ 4 ].push( r2( nx[ P[ k + 1 ] ] ), r2( nz[ P[ k + 1 ] ] ), r2( ys[ k + 1 ] ) );

		}

	}

	console.log( 'bridge deck pieces', decks );

	for ( const r of roads ) {

		if ( r.bridge ) continue;
		let piece = null, pkey = null;
		for ( let k = 0; k + 1 < r.pts.length; k ++ ) {

			const a = r.pts[ k ], b = r.pts[ k + 1 ];
			const mx = ( nx[ a ] + nx[ b ] ) / 2, mz = ( nz[ a ] + nz[ b ] ) / 2;
			if ( ! inside( mx, mz ) ) { piece = null; continue; }
			const c = C( mx, mz );
			if ( c !== pkey || ! piece ) {

				piece = [ r.kind, r2( r.width ), r.lanes, r.oneway, r.bridge, r.side, r.surf, [ r2( nx[ a ] ), r2( nz[ a ] ) ] ];
				c.w.push( piece );
				pkey = c;

			}

			piece[ 7 ].push( r2( nx[ b ] ), r2( nz[ b ] ) );

		}

	}

	// junctions: nodes shared by car roads -> round caps, markings stop here
	for ( const [ p, L ] of nodeWays ) {

		if ( useCount[ p ] < 3 || ! inside( nx[ p ], nz[ p ] ) ) continue;
		let w = 0;
		for ( const [ ri ] of L ) w = Math.max( w, roads[ ri ].width );
		C( nx[ p ], nz[ p ] ).j.push( r2( nx[ p ] ), r2( nz[ p ] ), r2( w / 2 ) );

	}

	// direction of a road at one of its nodes
	const dirAt = ( r, k ) => {

		const a = r.pts[ Math.max( 0, k - 1 ) ], b = r.pts[ Math.min( r.pts.length - 1, k + 1 ) ];
		const dx = nx[ b ] - nx[ a ], dz = nz[ b ] - nz[ a ], l = Math.hypot( dx, dz ) || 1;
		return [ dx / l, dz / l ];

	};

	const yawOf = ( dx, dz ) => r2( Math.atan2( dx, dz ) );
	let props = 0, crossings = 0;
	const SPEED_CAMS = [ [ 59.44458723857479, 24.79708873943973 ], [ 59.44265859068342, 24.79388862019304 ], [ 59.44283560291381, 24.792817521716643 ], [ 59.427181984104614, 24.720624787474502 ], [ 59.42719375540255, 24.72011410938542 ] ];
	const lastStop = [];
	const addEdgeProps = ( p, type ) => {

		// a node on the road centre line (signal, give way): poles at the right edge, facing the traffic
		for ( const [ ri, k ] of nodeWays.get( p ) || [] ) {

			const r = roads[ ri ];
			const [ dx, dz ] = dirAt( r, k );
			const off = r.width / 2 + 0.9;
			const dirs = r.oneway ? [ 1 ] : [ 1, - 1 ];
			for ( const s of dirs ) {

				// travelling along s*(dx,dz): right side is (-dz, dx)*s in our frame (x east, z south)
				const rx = - dz * s, rz = dx * s;
				const x = nx[ p ] + rx * off - dx * s * 3, z = nz[ p ] + rz * off - dz * s * 3;
				C( x, z ).p.push( type, r2( x ), r2( z ), yawOf( - dx * s, - dz * s ) );
				props ++;

			}

			break;

		}

	};

	for ( const [ p, t ] of nodeTags ) {

		const x = nx[ p ], z = nz[ p ];
		if ( ! inside( x, z ) ) continue;
		const hw = t.highway;
		if ( hw === 'street_lamp' ) {

			const n = nearestRoad( x, z, 20 );
			C( x, z ).p.push( 1, r2( x ), r2( z ), n ? yawOf( n.px - x, n.pz - z ) : 0 );
			props ++;

		} else if ( hw === 'traffic_signals' ) addEdgeProps( p, 2 );
		else if ( hw === 'give_way' || hw === 'stop' ) addEdgeProps( p, hw === 'stop' ? 8 : 7 );
		else if ( hw === 'bus_stop' || t.public_transport === 'platform' && ( t.bus === 'yes' || t.trolleybus === 'yes' || t.tram === 'yes' ) ) {

			if ( lastStop.some( ( [ a, b ] ) => Math.hypot( a - x, b - z ) < 12 ) ) continue;
			lastStop.push( [ x, z ] );
			const n = nearestRoad( x, z, 30 );
			// shelter faces the road; place it a little behind the stop point
			const yaw = n ? yawOf( n.px - x, n.pz - z ) : 0;
			C( x, z ).p.push( 3, r2( x ), r2( z ), yaw );
			props ++;

		} else if ( hw === 'speed_camera' ) {

			const n = nearestRoad( x, z, 30 );
			C( x, z ).p.push( 4, r2( x ), r2( z ), n ? yawOf( n.dx, n.dz ) : 0 );
			props ++;

		} else if ( t.amenity === 'bench' ) { C( x, z ).p.push( 5, r2( x ), r2( z ), 0 ); props ++; }
		else if ( t.amenity === 'waste_basket' ) { C( x, z ).p.push( 6, r2( x ), r2( z ), 0 ); props ++; }

		// zebra crossings on car roads
		if ( hw === 'crossing' && t.crossing !== 'unmarked' && t.crossing !== 'no' ) {

			const L = nodeWays.get( p );
			if ( ! L ) continue;
			const r = roads[ L[ 0 ][ 0 ] ];
			const [ dx, dz ] = dirAt( r, L[ 0 ][ 1 ] );
			C( x, z ).x.push( r2( x ), r2( z ), yawOf( dx, dz ), r2( r.width ) );
			crossings ++;
			if ( t.crossing === 'traffic_signals' || t[ 'crossing:signals' ] === 'yes' ) addEdgeProps( p, 2 );

		}

	}

	for ( const [ lat, lon ] of SPEED_CAMS ) {

		const { E, N } = toLest( lat, lon );
		const x = E - OE, z = - ( N - ON ), n = nearestRoad( x, z, 30 );
		C( x, z ).p.push( 4, r2( x ), r2( z ), n ? yawOf( n.dx, n.dz ) : 0 );

	}

	// areas: parking lots and pedestrian squares (simple closed ways)
	for ( const [ refs, t ] of ways ) {

		const isPark = t.amenity === 'parking' && ( ! t.parking || t.parking === 'surface' );
		const isPed = ( t.highway === 'pedestrian' && t.area === 'yes' ) || t[ 'area:highway' ] === 'footway' || t[ 'area:highway' ] === 'pedestrian';
		const isIsland = t[ 'area:highway' ] === 'traffic_island';
		if ( ! isPark && ! isPed && ! isIsland ) continue;
		if ( refs.length < 4 || refs[ 0 ] !== refs[ refs.length - 1 ] ) continue;
		const pts = refs.slice( 0, - 1 ).map( find );
		if ( pts.some( i => i < 0 ) ) continue;
		let cx = 0, cz = 0;
		for ( const p of pts ) { cx += nx[ p ]; cz += nz[ p ]; }
		cx /= pts.length; cz /= pts.length;
		if ( ! inside( cx, cz ) ) continue;
		const flat = [];
		for ( const p of pts ) flat.push( r2( nx[ p ] ), r2( nz[ p ] ) );
		C( cx, cz ).a.push( [ isPark ? 0 : isPed ? 1 : 2, flat ] );

	}

	// fences, hedges and walls: cut into ~2 m panels (each one can be knocked down)
	let panels = 0;
	for ( const [ refs, t ] of ways ) {

		const type = t.barrier === 'fence' ? 9 : t.barrier === 'hedge' ? 10 : t.barrier === 'wall' ? 11 : 0;
		if ( ! type ) continue;
		const pts = refs.map( find );
		if ( pts.some( i => i < 0 ) ) continue;
		for ( let k = 0; k + 1 < pts.length; k ++ ) {

			const ax = nx[ pts[ k ] ], az = nz[ pts[ k ] ], bx = nx[ pts[ k + 1 ] ], bz = nz[ pts[ k + 1 ] ];
			const len = Math.hypot( bx - ax, bz - az );
			if ( len < 0.3 ) continue;
			const n = Math.max( 1, Math.round( len / 2 ) ), L = len / n;
			const yaw = r2( Math.atan2( - ( bz - az ), bx - ax ) );
			for ( let q = 0; q < n; q ++ ) {

				const x = ax + ( bx - ax ) * ( q + 0.5 ) / n, z = az + ( bz - az ) * ( q + 0.5 ) / n;
				if ( ! inside( x, z ) ) continue;
				// never across a road
				const rd = nearestRoad( x, z, 12 );
				if ( rd && rd.d < rd.r.width / 2 + 0.3 ) continue;
				C( x, z ).b.push( type, r2( x ), r2( z ), yaw, r2( L ) );
				panels ++;

			}

		}

	}

	console.log( 'fence panels', panels );

	// private yards: OpenStreetMap misses most garden fences, so fence the land-register plots of small
	// residential parcels (Maa- ja Ruumiamet cadastre), with a gate gap on the side facing the street
	try {

		const local = CACHE && CACHE + '/kataster_harju.zip';
		let zipBuf = local && existsSync( local ) ? readFileSync( local ) : null;
		for ( let a = 0; a < 3 && ! zipBuf; a ++ ) {

			try {

				const r = await fetch( 'https://s3.pilw.io/rp-kemit-kataster/ANDMED/Harju_maakond_KATASTER_SHP.zip', { headers: { 'User-Agent': 'tallinna-soit-build/1.0' } } );
				if ( r.ok ) zipBuf = Buffer.from( await r.arrayBuffer() );

			} catch ( e ) { console.log( 'cadastre fetch failed', String( e ) ); }

		}

		if ( ! zipBuf ) throw new Error( 'no cadastre download' );
		const files = unzipSync( new Uint8Array( zipBuf ), { filter: f => /\.(shp|dbf)$/i.test( f.name ) } );
		const shp = Buffer.from( files[ Object.keys( files ).find( n => /\.shp$/i.test( n ) ) ] );
		const dbf = Buffer.from( files[ Object.keys( files ).find( n => /\.dbf$/i.test( n ) ) ] );
		// dbf: find the purpose and area columns
		const nRec = dbf.readUInt32LE( 4 ), hLen = dbf.readUInt16LE( 8 ), rLen = dbf.readUInt16LE( 10 );
		const cols = {};
		for ( let o = 32, off = 1; dbf[ o ] !== 0x0d; o += 32 ) {

			const name = dbf.toString( 'latin1', o, o + 11 ).replace( /\0.*$/, '' );
			cols[ name ] = [ off, dbf[ o + 16 ] ];
			off += dbf[ o + 16 ];

		}

		const field = ( i, name ) => { const [ off, len ] = cols[ name ]; const b = hLen + i * rLen + off; return dbf.toString( 'latin1', b, b + len ).trim(); };
		const seen = new Set();
		let yards = 0, yardPanels = 0, o = 100, rec = 0;
		while ( o + 8 <= shp.length ) {

			const len = shp.readInt32BE( o + 4 ) * 2, c = o + 8;
			o = c + len;
			const i = rec ++;
			if ( shp.readInt32LE( c ) !== 5 || i >= nRec ) continue;
			// bounding box test first (cheap)
			const bx0 = shp.readDoubleLE( c + 4 ), by0 = shp.readDoubleLE( c + 12 ), bx1 = shp.readDoubleLE( c + 20 ), by1 = shp.readDoubleLE( c + 28 );
			if ( bx1 < E0 || bx0 > E1 || by1 < N0 || by0 > N1 ) continue;
			if ( field( i, 'siht1' ) !== 'ELAMUMAA' || field( i, 'siht2' ) ) continue;
			const area = + field( i, 'pindala' );
			if ( ! ( area > 250 && area < 2600 ) ) continue;
			const nParts = shp.readInt32LE( c + 36 ), nPts = shp.readInt32LE( c + 40 );
			if ( nParts !== 1 || nPts > 80 ) continue;
			const p0 = c + 44 + nParts * 4, ring = [];
			for ( let k = 0; k < nPts; k ++ ) ring.push( [ shp.readDoubleLE( p0 + k * 16 ) - OE, - ( shp.readDoubleLE( p0 + k * 16 + 8 ) - ON ) ] );
			yards ++;
			const type = ( i * 2654435761 >>> 0 ) % 10 < 6 ? 12 : 10;
			// the edge closest to a street gets the gate
			let gate = - 1, gateD = 14;
			for ( let k = 0; k + 1 < ring.length; k ++ ) {

				const rd = nearestRoad( ( ring[ k ][ 0 ] + ring[ k + 1 ][ 0 ] ) / 2, ( ring[ k ][ 1 ] + ring[ k + 1 ][ 1 ] ) / 2, 14 );
				if ( rd && rd.r.kind <= 3 && rd.d < gateD ) { gateD = rd.d; gate = k; }

			}

			for ( let k = 0; k + 1 < ring.length; k ++ ) {

				const [ ax, az ] = ring[ k ], [ bx, bz ] = ring[ k + 1 ];
				const key = [ ax.toFixed( 1 ) + ',' + az.toFixed( 1 ), bx.toFixed( 1 ) + ',' + bz.toFixed( 1 ) ].sort().join( '|' );
				if ( seen.has( key ) ) continue;
				seen.add( key );
				const len = Math.hypot( bx - ax, bz - az );
				if ( len < 0.5 ) continue;
				const n = Math.max( 1, Math.round( len / 3 ) ), L = len / n;
				const yaw = r2( Math.atan2( - ( bz - az ), bx - ax ) );
				for ( let q = 0; q < n; q ++ ) {

					const t = ( q + 0.5 ) / n;
					if ( k === gate && Math.abs( t - 0.5 ) * len < 1.8 ) continue;
					const x = ax + ( bx - ax ) * t, z = az + ( bz - az ) * t;
					if ( ! inside( x, z ) ) continue;
					const rd = nearestRoad( x, z, 12 );
					if ( rd && rd.d < rd.r.width / 2 + 0.6 ) continue;
					C( x, z ).b.push( type, r2( x ), r2( z ), yaw, r2( L ) );
					yardPanels ++;

				}

			}

		}

		console.log( 'cadastre yards', yards, 'panels', yardPanels );

	} catch ( e ) { console.log( 'cadastre skipped:', String( e ) ); }

	// lidar trees that stand on a carriageway (mapping noise, overhanging crowns) are removed
	let removed = 0, kept = 0;
	for ( const [ cx, cy ] of ( JSON.parse( readFileSync( OUT + '/manifest.json', 'utf8' ) ).treeChunks || [] ) ) {

		const f = `${OUT}/t_${cx}_${cy}.bin`;
		if ( ! existsSync( f ) ) continue;
		const buf = readFileSync( f ), dv = new DataView( buf.buffer, buf.byteOffset, buf.byteLength );
		const n = dv.getUint32( 0, true ), keep = [];
		const e0 = GRID_E + cx * CHUNK, n0 = GRID_N + cy * CHUNK;
		for ( let i = 0; i < n; i ++ ) {

			const o = 4 + i * 8;
			const x = e0 + dv.getUint16( o, true ) / 100 - OE, z = - ( n0 + dv.getUint16( o + 2, true ) / 100 - ON );
			const rd = nearestRoad( x, z, 15 );
			if ( rd && rd.r.kind <= 2 && rd.d < rd.r.width / 2 + 0.4 ) { removed ++; continue; }
			keep.push( i );
			kept ++;

		}

		if ( keep.length === n ) continue;
		const out = Buffer.alloc( 4 + keep.length * 8 );
		out.writeUInt32LE( keep.length, 0 );
		keep.forEach( ( i, k ) => buf.copy( out, 4 + k * 8, 4 + i * 8, 12 + i * 8 ) );
		writeFileSync( f, out );

	}

	console.log( 'trees on roads removed', removed, 'kept', kept );

	for ( const [ key, c ] of chunks ) {

		writeFileSync( `${OUT}/o_${key}.json`, JSON.stringify( c ) );
		extra.osmChunks.push( key.split( '_' ).map( Number ) );

	}

	console.log( 'osm roads', roads.length, 'props', props, 'crossings', crossings, 'chunks', chunks.size );

} catch ( e ) { console.log( 'osm skipped:', String( e && e.stack || e ) ); }

writeFileSync( `${OUT}/extra.json`, JSON.stringify( extra ) );
console.log( 'extra done' );

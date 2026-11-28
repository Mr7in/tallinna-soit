// Street name plates (run after prepare-extra): Tallinn's corner plates with the street name and house number,
// on the corner buildings at junctions of differently named streets -> public/city/n_X_Y.json + names.json
//   plate: [x, z, yaw, colour, street, house number]; yaw turns +Z to the wall's outward normal
//   colour (Tallinn standard by district): 0 blue (Kesklinn, Põhja-Tallinn, Kristiine, Lasnamäe, Mustamäe,
//   Haabersti), 1 green (Nõmme), 2 white with brown (Pirita), 3 brown (Vanalinn, Kadriorg)
// Data © OpenStreetMap contributors (ODbL)
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { toLest } from '../src/lest.js';

const OUT = 'public/city';
const GRID_E = 40500, GRID_N = 5993000, CHUNK = 250;
const OE = 542000, ON = 6589000;
if ( existsSync( OUT + '/names.json' ) && ! process.env.FORCE_CITY ) { console.log( 'street names already prepared' ); process.exit( 0 ); }

let gz;
const local = process.env.CITY_CACHE && process.env.CITY_CACHE + '/Tallinn.osm.gz';
if ( local && existsSync( local ) ) gz = readFileSync( local );
else for ( let a = 0; a < 3 && ! gz; a ++ ) {

	try {

		const r = await fetch( 'https://download.bbbike.org/osm/bbbike/Tallinn/Tallinn.osm.gz', { headers: { 'User-Agent': 'tallinna-soit-build/1.0' } } );
		if ( r.ok ) gz = Buffer.from( await r.arrayBuffer() );

	} catch ( e ) { console.log( 'osm fetch failed', String( e ) ); }

}

if ( ! gz ) { console.log( 'street names skipped: no osm' ); writeFileSync( OUT + '/names.json', '[]' ); process.exit( 0 ); }
const xml = gunzipSync( gz ).toString( 'utf8' );

// ---- parse (one element per line) ----
const nodes = new Map(); // id -> [x, z]
const ways = new Map(); // id -> refs (every way, for boundary relations)
const streets = [], buildings = [], rels = [];
const STREET = /^(primary|secondary|tertiary|unclassified|residential|living_street|trunk|pedestrian)(_link)?$/;
const unesc = s => s.replace( /&quot;/g, '"' ).replace( /&apos;/g, "'" ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' ).replace( /&amp;/g, '&' );
const attr = ( line, k ) => { const i = line.indexOf( ' ' + k + '="' ); if ( i < 0 ) return null; const s = i + k.length + 3; return line.slice( s, line.indexOf( '"', s ) ); };
let cur = null, tags = null, members = null, wid = 0, pos = 0;
while ( pos < xml.length ) {

	let e = xml.indexOf( '\n', pos ); if ( e < 0 ) e = xml.length;
	const line = xml.slice( pos, e ).trim(); pos = e + 1;
	if ( line.startsWith( '<node ' ) ) {

		const { E, N } = toLest( + attr( line, 'lat' ), + attr( line, 'lon' ) );
		nodes.set( + attr( line, 'id' ), [ E - OE, - ( N - ON ) ] );

	} else if ( line.startsWith( '<way ' ) ) { cur = []; tags = {}; wid = + attr( line, 'id' ); }
	else if ( line.startsWith( '<relation ' ) ) { tags = {}; members = []; }
	else if ( line.startsWith( '<nd ' ) && cur ) cur.push( + attr( line, 'ref' ) );
	else if ( line.startsWith( '<member ' ) && members ) { if ( attr( line, 'type' ) === 'way' ) members.push( [ + attr( line, 'ref' ), attr( line, 'role' ) ] ); }
	else if ( line.startsWith( '<tag ' ) && tags ) tags[ attr( line, 'k' ) ] = unesc( attr( line, 'v' ) );
	else if ( line === '</way>' ) {

		ways.set( wid, cur );
		if ( tags.name && STREET.test( tags.highway || '' ) && tags.area !== 'yes' ) streets.push( [ cur, tags.name ] );
		if ( tags.building && tags[ 'addr:street' ] && tags[ 'addr:housenumber' ] ) buildings.push( [ cur, tags[ 'addr:street' ], tags[ 'addr:housenumber' ] ] );
		cur = null; tags = null;

	} else if ( line === '</relation>' ) {

		if ( tags.boundary === 'administrative' ) rels.push( [ tags.name, + tags.admin_level, members ] );
		tags = null; members = null;

	} else if ( line === '</node>' ) tags = null;
	else if ( line.startsWith( '<node ' ) === false && line.endsWith( '>' ) && line.startsWith( '<node' ) ) tags = {};

}

console.log( 'streets', streets.length, 'addressed buildings', buildings.length, 'boundaries', rels.length );
const pt = id => nodes.get( id );

// ---- districts with their own plate colour: outer rings of the boundary relations ----
function rings( members ) {

	const segs = members.filter( ( [ , r ] ) => r === 'outer' || r === '' ).map( ( [ id ] ) => ways.get( id ) ).filter( Boolean ).map( w => w.slice() );
	const out = [];
	while ( segs.length ) {

		let ring = segs.pop();
		let grew = true;
		while ( ring[ 0 ] !== ring[ ring.length - 1 ] && grew ) {

			grew = false;
			for ( let i = 0; i < segs.length; i ++ ) {

				const s = segs[ i ], end = ring[ ring.length - 1 ];
				if ( s[ 0 ] === end ) ring = ring.concat( s.slice( 1 ) );
				else if ( s[ s.length - 1 ] === end ) ring = ring.concat( s.slice( 0, - 1 ).reverse() );
				else continue;
				segs.splice( i, 1 ); grew = true; break;

			}

		}

		const P = ring.map( pt ).filter( Boolean );
		if ( P.length > 3 ) out.push( P );

	}

	return out;

}

const inRings = ( R, x, z ) => { let c = false; for ( const r of R ) for ( let a = 0, b = r.length - 1; a < r.length; b = a ++ ) if ( ( r[ a ][ 1 ] > z ) !== ( r[ b ][ 1 ] > z ) && x < ( r[ b ][ 0 ] - r[ a ][ 0 ] ) * ( z - r[ a ][ 1 ] ) / ( r[ b ][ 1 ] - r[ a ][ 1 ] ) + r[ a ][ 0 ] ) c = ! c; return c; };
const DIST = [ [ 'Vanalinn', 10, 3 ], [ 'Kadriorg', 10, 3 ], [ 'Pirita linnaosa', 9, 2 ], [ 'Nõmme linnaosa', 9, 1 ] ].map( ( [ n, lvl, col ] ) => {

	const r = rels.find( ( [ name, l ] ) => name === n && l === lvl );
	console.log( 'district', n, r ? 'found' : 'missing' );
	return r ? [ rings( r[ 2 ] ), col ] : null;

} ).filter( Boolean );
const colourAt = ( x, z ) => { for ( const [ R, col ] of DIST ) if ( inRings( R, x, z ) ) return col; return 0; };

// ---- junctions of differently named streets, with each street's direction there ----
const at = new Map(); // node -> Map(name -> [dx, dz])
for ( const [ refs, name ] of streets ) refs.forEach( ( id, k ) => {

	const a = pt( refs[ Math.max( 0, k - 1 ) ] ), b = pt( refs[ Math.min( refs.length - 1, k + 1 ) ] );
	if ( ! a || ! b ) return;
	if ( ! at.has( id ) ) at.set( id, new Map() );
	const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) || 1;
	at.get( id ).set( name, [ ( b[ 0 ] - a[ 0 ] ) / L, ( b[ 1 ] - a[ 1 ] ) / L ] );

} );
const junctions = [];
for ( const [ id, m ] of at ) if ( m.size >= 2 && pt( id ) ) junctions.push( [ pt( id ), m ] );

// ---- buildings by street, in a coarse grid ----
const G = 60, grid = new Map();
buildings.forEach( ( b, i ) => {

	const P = b[ 0 ].map( pt ).filter( Boolean );
	if ( P.length < 4 ) return;
	b.P = P;
	const cx = P.reduce( ( s, p ) => s + p[ 0 ], 0 ) / P.length, cz = P.reduce( ( s, p ) => s + p[ 1 ], 0 ) / P.length;
	const key = Math.floor( cx / G ) + ',' + Math.floor( cz / G );
	if ( ! grid.has( key ) ) grid.set( key, [] );
	grid.get( key ).push( i );

} );

// ---- one plate per corner building: on its facade along the addressed street, near the junction ----
const best = new Map(); // building -> plate candidate (closest junction wins)
for ( const [ [ jx, jz ], names ] of junctions ) {

	const gx = Math.floor( jx / G ), gz = Math.floor( jz / G );
	for ( let dx = - 1; dx <= 1; dx ++ ) for ( let dz = - 1; dz <= 1; dz ++ ) for ( const i of grid.get( ( gx + dx ) + ',' + ( gz + dz ) ) || [] ) {

		const b = buildings[ i ], dir = names.get( b[ 1 ] );
		if ( ! dir ) continue;
		const P = b.P;
		let pick = null;
		for ( let k = 0; k + 1 < P.length; k ++ ) {

			const ax = P[ k ][ 0 ], az = P[ k ][ 1 ], ex = P[ k + 1 ][ 0 ] - ax, ez = P[ k + 1 ][ 1 ] - az, L = Math.hypot( ex, ez );
			if ( L < 3 ) continue;
			const ux = ex / L, uz = ez / L;
			if ( Math.abs( ux * dir[ 0 ] + uz * dir[ 1 ] ) < 0.85 ) continue; // facade along the street
			const t = Math.max( 0, Math.min( L, ( jx - ax ) * ux + ( jz - az ) * uz ) );
			const d = Math.hypot( ax + ux * t - jx, az + uz * t - jz );
			if ( d > 28 || ( pick && d >= pick.d ) ) continue;
			// outward normal; it must face the street, not a back yard
			let nx = uz, nz = - ux;
			const mx = ax + ux * L / 2, mz = az + uz * L / 2;
			if ( inRings( [ P ], mx + nx * 0.3, mz + nz * 0.3 ) ) { nx = - nx; nz = - nz; }
			const tx = jx - ( ax + ux * t ), tz = jz - ( az + uz * t ); // wall to junction
			if ( nx * tx + nz * tz < 1 ) continue;
			// a metre in from the corner, along the wall
			const s = Math.max( 0.6, Math.min( L - 0.6, t + ( t < L / 2 ? 1 : - 1 ) ) );
			pick = { d, x: ax + ux * s + nx * 0.05, z: az + uz * s + nz * 0.05, yaw: Math.atan2( nx, nz ) };

		}

		if ( pick && ( ! best.has( i ) || best.get( i ).d > pick.d ) ) best.set( i, pick );

	}

}

const chunks = new Map();
const r2 = v => Math.round( v * 100 ) / 100;
for ( const [ i, p ] of best ) {

	const E = p.x + OE, N = - p.z + ON;
	const key = Math.floor( ( E - GRID_E ) / CHUNK ) + '_' + Math.floor( ( N - GRID_N ) / CHUNK );
	if ( ! chunks.has( key ) ) chunks.set( key, [] );
	chunks.get( key ).push( [ r2( p.x ), r2( p.z ), r2( p.yaw ), colourAt( p.x, p.z ), buildings[ i ][ 1 ], buildings[ i ][ 2 ] ] );

}

for ( const [ key, list ] of chunks ) writeFileSync( `${OUT}/n_${key}.json`, JSON.stringify( list ) );
writeFileSync( OUT + '/names.json', JSON.stringify( [ ...chunks.keys() ] ) );
console.log( 'street name plates', best.size, 'chunks', chunks.size );

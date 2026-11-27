// Builds the game's world data from Maa- ja Ruumiamet open data (run at build time on Vercel or locally):
//   - LOD2 buildings of Tallinn (OBJ)            -> public/city/c_X_Y.bin   (250 m chunks, with per-vertex base/top height)
//   - DTM 10 m terrain (9 GeoTIFF map sheets)    -> public/city/h_TX_TY.bin (2 km tiles) + coarse.bin
//   - single trees from lidar (GeoPackage)       -> public/city/t_X_Y.bin
//   - bridges (LOD1 traffic structures, OBJ)     -> public/city/bridges.bin
//   - CC0 sound effects                           -> public/sfx/
// Credits: "Hoonete 3D ruumiandmed, kõrgusmudel, puud ja rajatised: Maa- ja Ruumiamet"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { fromArrayBuffer } from 'geotiff';

const OUT = 'public/city';
const GEO = 'https://geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing';
const GRID_E = 40500, GRID_N = 5993000; // Maa-amet L-EST tile grid origin (chunks align with z12 ortho tiles)
const CHUNK = 250;
const T_E0 = 530000, T_N0 = 6570000, T_CELL = 10, T_TILE = 200, T_TILES = 15; // DTM: 30 x 30 km, 2 km tiles
const COARSE = 50;

if ( existsSync( OUT + '/manifest.json' ) && ! process.env.FORCE_CITY ) { console.log( 'city data already prepared' ); process.exit( 0 ); }
mkdirSync( OUT, { recursive: true } );

async function get( url, local ) {

	if ( local && existsSync( local ) ) return new Uint8Array( readFileSync( local ) );
	for ( let attempt = 0; attempt < 3; attempt ++ ) {

		try {

			const r = await fetch( url, { headers: { 'User-Agent': 'tallinna-soit-build/1.0' } } );
			if ( r.ok ) return new Uint8Array( await r.arrayBuffer() );
			console.log( 'HTTP', r.status, url );

		} catch ( e ) { console.log( 'fetch failed', String( e ) ); }

	}

	throw new Error( 'download failed: ' + url );

}

const cache = process.env.CITY_CACHE; // optional local folder with the raw downloads
const loc = n => cache ? join( cache, n ) : null;

// =============== terrain (DTM 10 m) ===============
console.log( 'terrain…' );
const TW = T_TILES * T_TILE + 1;
const H = new Float32Array( TW * TW ).fill( NaN );
for ( const s of [ 6373, 6374, 6375, 6383, 6384, 6385, 6393, 6394, 6395 ] ) {

	const buf = await get( `${GEO}&kaardiruut=${s}&andmetyyp=dem_10m_geotiff&dl=1&f=${s}_dtm_10m.tif&page_id=614`, loc( `dtm/${s}.tif` ) );
	const tif = await fromArrayBuffer( buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength ) );
	const im = await tif.getImage();
	const [ e0, , , n1 ] = im.getBoundingBox();
	const w = im.getWidth(), h = im.getHeight();
	const r = ( await im.readRasters() )[ 0 ];
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		// pixel centre -> nearest grid node
		const E = e0 + ( x + 0.5 ) * T_CELL, N = n1 - ( y + 0.5 ) * T_CELL;
		const gx = Math.round( ( E - T_E0 ) / T_CELL ), gy = Math.round( ( N - T_N0 ) / T_CELL );
		if ( gx < 0 || gy < 0 || gx >= TW || gy >= TW ) continue;
		const v = r[ y * w + x ];
		H[ gy * TW + gx ] = v > - 100 ? v : - 0.4; // sea / nodata

	}

}

for ( let i = 0; i < H.length; i ++ ) if ( Number.isNaN( H[ i ] ) ) H[ i ] = - 0.4;
const terrainAt = ( E, N ) => {

	const gx = ( E - T_E0 ) / T_CELL, gy = ( N - T_N0 ) / T_CELL;
	const x0 = Math.max( 0, Math.min( TW - 2, Math.floor( gx ) ) ), y0 = Math.max( 0, Math.min( TW - 2, Math.floor( gy ) ) );
	const ax = gx - x0, ay = gy - y0;
	return ( H[ y0 * TW + x0 ] * ( 1 - ax ) + H[ y0 * TW + x0 + 1 ] * ax ) * ( 1 - ay ) + ( H[ ( y0 + 1 ) * TW + x0 ] * ( 1 - ax ) + H[ ( y0 + 1 ) * TW + x0 + 1 ] * ax ) * ay;

};

for ( let ty = 0; ty < T_TILES; ty ++ ) for ( let tx = 0; tx < T_TILES; tx ++ ) {

	const q = new Int16Array( ( T_TILE + 1 ) ** 2 );
	for ( let y = 0; y <= T_TILE; y ++ ) for ( let x = 0; x <= T_TILE; x ++ ) q[ y * ( T_TILE + 1 ) + x ] = Math.round( H[ ( ty * T_TILE + y ) * TW + tx * T_TILE + x ] * 10 );
	writeFileSync( `${OUT}/h_${tx}_${ty}.bin`, Buffer.from( q.buffer ) );

}

const CW = ( T_TILES * T_TILE * T_CELL ) / COARSE + 1;
const coarse = new Int16Array( CW * CW );
for ( let y = 0; y < CW; y ++ ) for ( let x = 0; x < CW; x ++ ) coarse[ y * CW + x ] = Math.round( terrainAt( T_E0 + x * COARSE, T_N0 + y * COARSE ) * 10 );
writeFileSync( `${OUT}/coarse.bin`, Buffer.from( coarse.buffer ) );

// =============== simple OBJ reader (vertices with world-file offset, faces grouped by usemtl) ===============
function readObj( zipBuf ) {

	const files = unzipSync( zipBuf, { filter: f => /\.(obj|fwt)$/i.test( f.name ) } );
	const objName = Object.keys( files ).find( n => n.endsWith( '.obj' ) );
	const fwt = new TextDecoder().decode( files[ Object.keys( files ).find( n => n.endsWith( '.fwt' ) ) ] ).trim().split( /\s+/ ).map( Number );
	const off = [ fwt[ 3 ], fwt[ 7 ], fwt[ 11 ] ];
	const obj = files[ objName ];
	let vE = new Float64Array( 1 << 16 ), vN = new Float64Array( 1 << 16 ), vH = new Float32Array( 1 << 16 ), nv = 0;
	let tri = new Int32Array( 1 << 18 ), triB = new Int32Array( 1 << 16 ), nt = 0, nb = - 1;
	const grow = ( a, s ) => { const b = new a.constructor( s ); b.set( a ); return b; };
	const dec = new TextDecoder();
	let pos = 0;
	while ( pos < obj.length ) {

		let end = obj.indexOf( 10, pos );
		if ( end < 0 ) end = obj.length;
		const c0 = obj[ pos ], c1 = obj[ pos + 1 ];
		if ( c0 === 118 && c1 === 32 ) {

			const p = dec.decode( obj.subarray( pos + 2, end ) ).trim().split( /\s+/ );
			if ( nv >= vE.length ) { vE = grow( vE, nv * 2 ); vN = grow( vN, nv * 2 ); vH = grow( vH, nv * 2 ); }
			vE[ nv ] = + p[ 0 ] + off[ 0 ]; vN[ nv ] = + p[ 1 ] + off[ 1 ]; vH[ nv ] = + p[ 2 ] + off[ 2 ]; nv ++;

		} else if ( c0 === 102 && c1 === 32 ) {

			const p = dec.decode( obj.subarray( pos + 2, end ) ).trim().split( /\s+/ ).map( s => parseInt( s, 10 ) - 1 );
			for ( let k = 1; k + 1 < p.length; k ++ ) {

				if ( nt * 3 + 3 > tri.length ) tri = grow( tri, tri.length * 2 );
				if ( nt >= triB.length ) triB = grow( triB, triB.length * 2 );
				tri[ nt * 3 ] = p[ 0 ]; tri[ nt * 3 + 1 ] = p[ k ]; tri[ nt * 3 + 2 ] = p[ k + 1 ]; triB[ nt ] = nb; nt ++;

			}

		} else if ( c0 === 117 && c1 === 115 && obj[ pos + 2 ] === 101 ) nb ++;
		pos = end + 1;

	}

	return { vE, vN, vH, nv, tri, triB, nt, nb: nb + 1 };

}

// =============== buildings ===============
console.log( 'buildings…' );
const B = readObj( await get( `${GEO}&andmetyyp=hooned_lod2&dl=1&f=hooned_lod2-Tallinn-obj.zip&page_id=833`, loc( 'tallinn-lod2-obj.zip' ) ) );
console.log( 'vertices', B.nv, 'triangles', B.nt, 'buildings', B.nb );
const bE = new Float64Array( B.nb ), bN = new Float64Array( B.nb ), bMin = new Float32Array( B.nb ).fill( 1e9 ), bMax = new Float32Array( B.nb ).fill( - 1e9 ), bCnt = new Int32Array( B.nb );
for ( let t = 0; t < B.nt; t ++ ) {

	const b = B.triB[ t ];
	for ( let k = 0; k < 3; k ++ ) {

		const v = B.tri[ t * 3 + k ];
		bE[ b ] += B.vE[ v ]; bN[ b ] += B.vN[ v ]; bCnt[ b ] ++;
		if ( B.vH[ v ] < bMin[ b ] ) bMin[ b ] = B.vH[ v ];
		if ( B.vH[ v ] > bMax[ b ] ) bMax[ b ] = B.vH[ v ];

	}

}

// wall top (eave): lowest point of the roof triangles, so tall pitched roofs do not count as floors
const bEave = new Float32Array( B.nb ).fill( 1e9 );
for ( let t = 0; t < B.nt; t ++ ) {

	const b = B.triB[ t ], i0 = B.tri[ t * 3 ], i1 = B.tri[ t * 3 + 1 ], i2 = B.tri[ t * 3 + 2 ];
	const ax = B.vE[ i1 ] - B.vE[ i0 ], ay = B.vN[ i1 ] - B.vN[ i0 ], az = B.vH[ i1 ] - B.vH[ i0 ];
	const bx = B.vE[ i2 ] - B.vE[ i0 ], by = B.vN[ i2 ] - B.vN[ i0 ], bz = B.vH[ i2 ] - B.vH[ i0 ];
	const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
	const len = Math.hypot( nx, ny, nz ) || 1;
	const lo = Math.min( B.vH[ i0 ], B.vH[ i1 ], B.vH[ i2 ] );
	if ( Math.abs( nz / len ) > 0.3 && lo > bMin[ b ] + 1.5 && lo < bEave[ b ] ) bEave[ b ] = lo;

}

for ( let b = 0; b < B.nb; b ++ ) if ( bEave[ b ] > bMax[ b ] ) bEave[ b ] = bMax[ b ];

const byChunk = new Map();
for ( let t = 0; t < B.nt; t ++ ) {

	const b = B.triB[ t ];
	if ( ! bCnt[ b ] ) continue;
	const cx = Math.floor( ( bE[ b ] / bCnt[ b ] - GRID_E ) / CHUNK ), cy = Math.floor( ( bN[ b ] / bCnt[ b ] - GRID_N ) / CHUNK );
	const key = cx + '_' + cy;
	let list = byChunk.get( key );
	if ( ! list ) byChunk.set( key, list = [] );
	list.push( t );

}

const chunks = [];
let bytes = 0;
for ( const [ key, list ] of byChunk ) {

	const [ cx, cy ] = key.split( '_' ).map( Number );
	const e0 = GRID_E + cx * CHUNK, n0 = GRID_N + cy * CHUNK;
	// a vertex shared by two buildings is written once per building, so each keeps its own base / eave heights
	const used = [], usedB = [], seen = new Map();
	const idx = new Uint32Array( list.length * 3 );
	let w = 0;
	for ( const t of list ) for ( let k = 0; k < 3; k ++ ) {

		const v = B.tri[ t * 3 + k ], b = B.triB[ t ], key = v * 65536 + ( b % 65536 );
		let i = seen.get( key );
		if ( i === undefined ) { i = used.length; seen.set( key, i ); used.push( v ); usedB.push( b ); }
		idx[ w ++ ] = i;

	}

	const n = used.length;
	const pq = new Int16Array( n * 3 + ( n * 3 ) % 2 );
	const aq = new Int16Array( n * 2 );
	for ( let i = 0; i < n; i ++ ) {

		const v = used[ i ], b = usedB[ i ];
		pq[ i * 3 ] = Math.round( ( B.vE[ v ] - e0 ) * 10 );
		pq[ i * 3 + 1 ] = Math.round( B.vH[ v ] * 10 );
		pq[ i * 3 + 2 ] = Math.round( ( B.vN[ v ] - n0 ) * 10 );
		aq[ i * 2 ] = Math.round( bMin[ b ] * 10 );
		aq[ i * 2 + 1 ] = Math.round( bEave[ b ] * 10 );

	}

	const wide = n > 65535;
	const ia = wide ? idx : Uint16Array.from( idx );
	const buf = Buffer.concat( [ Buffer.from( new Uint32Array( [ 0x32544943, n, idx.length, wide ? 1 : 0 ] ).buffer ), Buffer.from( pq.buffer ), Buffer.from( aq.buffer ), Buffer.from( ia.buffer, ia.byteOffset, ia.byteLength ) ] );
	writeFileSync( `${OUT}/c_${key}.bin`, buf );
	bytes += buf.length;
	chunks.push( [ cx, cy ] );

}

console.log( 'building chunks', chunks.length, ( bytes / 1e6 ).toFixed( 1 ), 'MB' );

// =============== bridges (tunnels are underground in the DTM and are skipped) ===============
console.log( 'bridges…' );
const R = readObj( await get( `${GEO}&andmetyyp=liikluskorralduslikud_rajatised_lod1&dl=1&f=liikluskorralduslikud_rajatised_lod1-eesti-obj.zip&page_id=833`, loc( 'rajatised.zip' ) ) );
const ORIGIN_E = 542000, ORIGIN_N = 6589000;
const bpos = [], bidx = [];
let nBridges = 0;
{

	const groups = new Map();
	for ( let t = 0; t < R.nt; t ++ ) { const g = R.triB[ t ]; if ( ! groups.has( g ) ) groups.set( g, [] ); groups.get( g ).push( t ); }
	for ( const list of groups.values() ) {

		let e = 0, nn = 0, top = - 1e9, c = 0;
		for ( const t of list ) for ( let k = 0; k < 3; k ++ ) { const v = R.tri[ t * 3 + k ]; e += R.vE[ v ]; nn += R.vN[ v ]; top = Math.max( top, R.vH[ v ] ); c ++; }
		e /= c; nn /= c;
		if ( e < T_E0 + 500 || nn < T_N0 + 500 || e > T_E0 + 29500 || nn > T_N0 + 29500 ) continue;
		if ( top < terrainAt( e, nn ) + 1.5 ) continue; // tunnel or at-grade
		nBridges ++;
		for ( const t of list ) for ( let k = 0; k < 3; k ++ ) {

			const v = R.tri[ t * 3 + k ];
			bidx.push( bpos.length / 3 );
			bpos.push( R.vE[ v ] - ORIGIN_E, R.vH[ v ], - ( R.vN[ v ] - ORIGIN_N ) );

		}

	}

}

writeFileSync( `${OUT}/bridges.bin`, Buffer.from( new Float32Array( bpos ).buffer ) );
console.log( 'bridges', nBridges );

// =============== trees (lidar single trees) ===============
console.log( 'trees…' );
const treeChunks = [];
try {

	const zip = await get( `${GEO}&andmetyyp=vegetatsioon&dl=1&f=vegetatsioon-Tallinn-0784-gpkg.zip&page_id=833`, loc( 'veg.zip' ) );
	const f = unzipSync( zip, { filter: x => x.name.endsWith( '.gpkg' ) } );
	const path = join( tmpdir(), 'veg.gpkg' );
	writeFileSync( path, Object.values( f )[ 0 ] );
	const { DatabaseSync } = await import( 'node:sqlite' );
	const db = new DatabaseSync( path, { readOnly: true } );
	const rows = db.prepare( 'SELECT Shape, puutyyp, korgus, puukroon FROM yksikpuud_keskpunkt' ).all();
	const by = new Map();
	for ( const r of rows ) {

		const g = r.Shape;
		const flags = g[ 3 ];
		const env = [ 0, 32, 48, 48, 64 ][ ( flags >> 1 ) & 7 ] || 0;
		const o = 8 + env;
		const dv = new DataView( g.buffer, g.byteOffset + o, 21 );
		const le = dv.getUint8( 0 ) === 1;
		const E = dv.getFloat64( 5, le ), N = dv.getFloat64( 13, le );
		const cx = Math.floor( ( E - GRID_E ) / CHUNK ), cy = Math.floor( ( N - GRID_N ) / CHUNK );
		const key = cx + '_' + cy;
		let a = by.get( key );
		if ( ! a ) by.set( key, a = [] );
		a.push( E - GRID_E - cx * CHUNK, N - GRID_N - cy * CHUNK, r.korgus || 5, r.puukroon || 3, r.puutyyp === 'Okaspuu' ? 1 : 0 );

	}

	db.close();
	rmSync( path );
	let total = 0;
	for ( const [ key, a ] of by ) {

		const n = a.length / 5;
		const buf = new ArrayBuffer( 4 + n * 8 );
		const dv = new DataView( buf );
		dv.setUint32( 0, n, true );
		for ( let i = 0; i < n; i ++ ) {

			const o = 4 + i * 8;
			dv.setUint16( o, Math.round( a[ i * 5 ] * 100 ) % 65536, true ); // cm within chunk (0..250 m)
			dv.setUint16( o + 2, Math.round( a[ i * 5 + 1 ] * 100 ) % 65536, true );
			dv.setUint8( o + 4, Math.min( 255, Math.round( a[ i * 5 + 2 ] * 4 ) ) );
			dv.setUint8( o + 5, Math.min( 255, Math.round( a[ i * 5 + 3 ] * 8 ) ) );
			dv.setUint8( o + 6, a[ i * 5 + 4 ] );

		}

		writeFileSync( `${OUT}/t_${key}.bin`, Buffer.from( buf ) );
		const [ cx, cy ] = key.split( '_' ).map( Number );
		treeChunks.push( [ cx, cy ] );
		total += n;

	}

	console.log( 'trees', total, 'in', treeChunks.length, 'chunks' );

} catch ( e ) { console.log( 'trees skipped:', String( e ) ); }

// =============== sounds (CC0) ===============
console.log( 'sounds…' );
mkdirSync( 'public/sfx', { recursive: true } );
const SFX = {
	'engine0.wav': 'https://opengameart.org/sites/default/files/loop_0.wav',
	'engine1.wav': 'https://opengameart.org/sites/default/files/loop_1_0.wav',
	'engine2.wav': 'https://opengameart.org/sites/default/files/loop_2_0.wav',
	'engine3.wav': 'https://opengameart.org/sites/default/files/loop_3_0.wav',
	'engine4.wav': 'https://opengameart.org/sites/default/files/loop_4_0.wav',
	'engine5.wav': 'https://opengameart.org/sites/default/files/loop_5_0.wav',
	'crash.ogg': 'https://opengameart.org/sites/default/files/qubodup-crash.ogg',
	'treefall.ogg': 'https://opengameart.org/sites/default/files/chop-tree-fall.ogg',
	'skid.mp3': 'https://cdn.freesound.org/previews/614/614627_5790048-hq.mp3',
};
const got = [];
for ( const [ name, url ] of Object.entries( SFX ) ) {

	try { writeFileSync( 'public/sfx/' + name, await get( url, loc( 'snd/' + url.split( '/' ).pop() ) ) ); got.push( name ); } catch ( e ) { console.log( 'sound skipped', name ); }

}

writeFileSync( `${OUT}/manifest.json`, JSON.stringify( {
	attribution: 'Hoonete 3D ruumiandmed, kõrgusmudel, puud ja rajatised: Maa- ja Ruumiamet',
	gridE: GRID_E, gridN: GRID_N, chunk: CHUNK,
	terrain: { e0: T_E0, n0: T_N0, cell: T_CELL, tile: T_TILE, tiles: T_TILES, coarse: COARSE, coarseW: CW },
	chunks, treeChunks, sounds: got,
} ) );
console.log( 'done' );

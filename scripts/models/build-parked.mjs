// Parked cars (Sketchfab, 1990s to 2010s, no Russian makes) -> public/models/parked.glb, built for phones:
//   - one primitive per car: POSITION + COLOR_0 only (textures and materials baked into vertex colours),
//     so every car model is one draw call per chunk and the file stays small
//   - COLOR_0.a = 1 marks body paint: the game tints it per instance (src/parked.js)
//   - interiors, colliders and invisible helpers dropped; two levels of detail per car (car_<id> ~5000 triangles,
//     car_<id>_lo ~900 for distance and phones); normals rebuilt in the game
//   - real length, ground at y = 0, footprint centred, length along Z
// Usage: node build-parked.mjs (reads raw/*.glb, writes out/parked.glb). Credits: CREDITS.md
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

const DROP = /colider|collider|interior|seat|leather|cloth|carpet|fabric|dash|gauge|steer|engine|invisible|undercarriage|floor|pedal|_int$|windows_int|glass_int|koltuk|dvd|needles|headliner/i;
const GLASS = /glass|window|win_|stek|toner/i;
// never paint, even when baked near-white: lamps, chrome, wheels, plates, badges
const NOPAINT = /light|lamp|svetla|signal|chmsl|chrome|rim|wheel|tire|tyre|disk|hub|plate|badg|logo|mirr|caliper|metal|digit/i;

// paint: material names whose surface is body paint; byColor: textured atlas, paint = texels near the dominant colour
const CARS = [
	{ id: 'golf4', src: 'c_golf4', length: 4.15, paint: [ 'Extra20071Mtl' ], byColor: true },
	{ id: 'passat_b5', src: 'd_passat_b5', length: 4.67, paint: [ 'primary' ] },
	{ id: 'octavia1', src: 'e_octavia1', length: 4.51, paint: [ 'primary', 'left', 'right' ] },
	{ id: 'octavia2', src: 'c_octavia2', length: 4.57, paint: [ 'car_paint' ] },
	{ id: 'corolla_e11', src: 'e_corolla_e11', length: 4.10, paint: [ 'Color1Mtl' ], keepSide: - 1 },
	{ id: 'corolla_e180', src: 'e_corolla_e180', length: 4.62, paint: [ 'main_paint', 'main_paint.001' ] },
	{ id: 'bmw_e39', src: 'd_bmw_e39', length: 4.78, paint: [ 'body' ] },
	{ id: 'audi_a4_b8', src: 'd_a4_b8', length: 4.70, paint: [ 'primary' ] },
	{ id: 'astra_g', src: 'd_astra_g', length: 4.11, paint: [ 'primary', 'chassis.0', 'chassis.1', 'bump_rear_dam.1' ], byColor: 0.6 },
	{ id: 'merc_w210', src: 'd_merc_w210', length: 4.82, paint: [ 'mMAT_E320_W210_4matic_Sedan_2001_Metallic_Grey1' ] },
	{ id: 'volvo_s60', src: 'e_volvo_s60', length: 4.58, paint: [ 'body' ] },
	{ id: 'passat_b6', src: 'd_passat_b6', length: 4.77, paint: [ 'passat', 'passat_col', 'specialgrey' ], byColor: true },
];
const TRIS = +( process.env.TRIS || 5000 ), TRIS_LO = +( process.env.TRIS_LO || 900 );

const texCache = new Map();
async function texels( tex ) {

	if ( texCache.has( tex ) ) return texCache.get( tex );
	const { data, info } = await sharp( Buffer.from( tex.getImage() ) ).resize( 256, 256, { fit: 'fill' } ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	const t = { data, w: info.width, h: info.height };
	texCache.set( tex, t );
	return t;

}

function sample( t, u, v ) {

	u -= Math.floor( u ); v -= Math.floor( v );
	const i = ( Math.min( t.h - 1, Math.floor( v * t.h ) ) * t.w + Math.min( t.w - 1, Math.floor( u * t.w ) ) ) * 4;
	return [ t.data[ i ] / 255, t.data[ i + 1 ] / 255, t.data[ i + 2 ] / 255 ];

}

const srgb2lin = c => c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
const out = new Document(); const obuf = out.createBuffer(); const oscene = out.createScene( 'parked' );
const meta = {};
mkdirSync( 'out', { recursive: true } );

for ( const C of CARS ) {

	const doc = await io.read( `raw/${C.src}.glb` );
	const P = [], COL = [];
	let tris = 0;
	for ( const n of doc.getRoot().listNodes() ) {

		const m = n.getMesh(); if ( ! m ) continue;
		const W = n.getWorldMatrix();
		for ( const p of m.listPrimitives() ) {

			if ( p.getMode() !== 4 ) continue;
			const mat = p.getMaterial(), name = mat ? mat.getName() : '';
			const base = mat ? mat.getBaseColorFactor() : [ 1, 1, 1, 1 ];
			if ( DROP.test( name ) || DROP.test( n.getName() ) ) continue;
			if ( mat && mat.getAlphaMode() === 'BLEND' && base[ 3 ] < 0.05 && ! GLASS.test( name ) ) continue;
			const glass = mat && ( GLASS.test( name ) || ( mat.getAlphaMode() === 'BLEND' && base[ 3 ] < 0.9 ) );
			const paint = C.paint.includes( name );
			const tex = mat && mat.getBaseColorTexture();
			const T = tex && ! glass ? await texels( tex ) : null;
			const uv = p.getAttribute( 'TEXCOORD_0' ), pos = p.getAttribute( 'POSITION' ), idx = p.getIndices();
			const vc = p.getAttribute( 'COLOR_0' );
			const nI = idx ? idx.getCount() : pos.getCount();
			const v = [], t2 = [], c4 = [];
			for ( let i = 0; i < nI; i ++ ) {

				const k = idx ? idx.getScalar( i ) : i;
				pos.getElement( k, v );
				P.push( W[ 0 ] * v[ 0 ] + W[ 4 ] * v[ 1 ] + W[ 8 ] * v[ 2 ] + W[ 12 ], W[ 1 ] * v[ 0 ] + W[ 5 ] * v[ 1 ] + W[ 9 ] * v[ 2 ] + W[ 13 ], W[ 2 ] * v[ 0 ] + W[ 6 ] * v[ 1 ] + W[ 10 ] * v[ 2 ] + W[ 14 ] );
				let c = [ base[ 0 ], base[ 1 ], base[ 2 ] ];
				if ( T && uv ) { uv.getElement( k, t2 ); const s = sample( T, t2[ 0 ], t2[ 1 ] ).map( srgb2lin ); c = [ c[ 0 ] * s[ 0 ], c[ 1 ] * s[ 1 ], c[ 2 ] * s[ 2 ] ]; }
				if ( vc ) { vc.getElement( k, c4 ); c = [ c[ 0 ] * c4[ 0 ], c[ 1 ] * c4[ 1 ], c[ 2 ] * c4[ 2 ] ]; }
				if ( glass ) c = [ 0.025, 0.03, 0.035 ];
				// near-white unlit surfaces on the body are white-baked paint (BeamNG-style atlases tint them at runtime)
				const whiteBody = ! glass && ! NOPAINT.test( name ) && c[ 0 ] > 0.45 && c[ 1 ] > 0.45 && c[ 2 ] > 0.45 && Math.max( ...c ) - Math.min( ...c ) < 0.08;
				COL.push( c[ 0 ], c[ 1 ], c[ 2 ], paint || whiteBody ? 1 : 0 );

			}

			tris += nI / 3;

		}

	}

	// textured paint atlas: only the texels close to the dominant paint colour are paint
	if ( C.byColor ) {

		const bins = new Map();
		for ( let i = 0; i < COL.length; i += 4 ) if ( COL[ i + 3 ] ) {

			const key = [ 0, 1, 2 ].map( j => Math.round( COL[ i + j ] * 10 ) ).join();
			bins.set( key, ( bins.get( key ) || 0 ) + 1 );

		}

		const dom = [ ...bins ].sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ][ 0 ].split( ',' ).map( x => + x / 10 );
		for ( let i = 0; i < COL.length; i += 4 ) if ( COL[ i + 3 ] ) {

			const d = Math.hypot( COL[ i ] - dom[ 0 ], COL[ i + 1 ] - dom[ 1 ], COL[ i + 2 ] - dom[ 2 ] );
			COL[ i + 3 ] = d < ( C.byColor === true ? 0.12 : C.byColor ) ? 1 : 0;

		}

	}

	// orientation, scale, placement: length along Z, ground at 0, footprint centred
	const bb = ( arr ) => { const lo = [ 1e9, 1e9, 1e9 ], hi = [ - 1e9, - 1e9, - 1e9 ]; for ( let i = 0; i < arr.length; i += 3 ) for ( let j = 0; j < 3; j ++ ) { lo[ j ] = Math.min( lo[ j ], arr[ i + j ] ); hi[ j ] = Math.max( hi[ j ], arr[ i + j ] ); } return [ lo, hi ]; };
	if ( C.keepSide ) {

		// file with two copies of the car side by side: keep the triangles on one side
		const [ lo0, hi0 ] = bb( P ), mid = ( lo0[ 0 ] + hi0[ 0 ] ) / 2;
		const P2 = [], C2 = [];
		for ( let t = 0; t < P.length; t += 9 ) {

			const cx = ( P[ t ] + P[ t + 3 ] + P[ t + 6 ] ) / 3;
			if ( ( cx - mid ) * C.keepSide > 0 ) { for ( let j = 0; j < 9; j ++ ) P2.push( P[ t + j ] ); for ( let j = 0; j < 12; j ++ ) C2.push( COL[ t / 3 * 4 + j ] ); }

		}

		P.length = 0; for ( const x of P2 ) P.push( x ); COL.length = 0; for ( const x of C2 ) COL.push( x );

	}

	let [ lo, hi ] = bb( P );
	if ( hi[ 0 ] - lo[ 0 ] > hi[ 2 ] - lo[ 2 ] ) for ( let i = 0; i < P.length; i += 3 ) { const x = P[ i ]; P[ i ] = - P[ i + 2 ]; P[ i + 2 ] = x; }
	[ lo, hi ] = bb( P );
	const k = C.length / ( hi[ 2 ] - lo[ 2 ] );
	const cx = ( lo[ 0 ] + hi[ 0 ] ) / 2, cz = ( lo[ 2 ] + hi[ 2 ] ) / 2;
	for ( let i = 0; i < P.length; i += 3 ) { P[ i ] = ( P[ i ] - cx ) * k; P[ i + 1 ] = ( P[ i + 1 ] - lo[ 1 ] ) * k; P[ i + 2 ] = ( P[ i + 2 ] - cz ) * k; }

	// one primitive per level of detail: near (TRIS) and far / phones (TRIS_LO)
	for ( const [ suffix, target ] of [ [ '', TRIS ], [ '_lo', TRIS_LO ] ] ) {

		const d = new Document(); const buf = d.createBuffer();
		const prim = d.createPrimitive()
			.setAttribute( 'POSITION', d.createAccessor().setType( 'VEC3' ).setArray( new Float32Array( P ) ).setBuffer( buf ) )
			.setAttribute( 'COLOR_0', d.createAccessor().setType( 'VEC4' ).setArray( new Float32Array( COL ) ).setBuffer( buf ) );
		d.createScene().addChild( d.createNode( 'car' ).setMesh( d.createMesh( C.id ).addPrimitive( prim ) ) );
		await d.transform( weld() );
		const before = prim.getIndices().getCount() / 3;
		await d.transform( simplify( { simplifier: MeshoptSimplifier, ratio: Math.min( 1, target / before ), error: suffix ? 0.05 : 0.02, lockBorder: false } ) );
		let after = prim.getIndices().getCount() / 3;
		if ( after > target * 1.3 ) {

			// many loose parts: sloppy pass on what is left
			const idx = prim.getIndices(), pos = prim.getAttribute( 'POSITION' );
			const ni = MeshoptSimplifier.simplifySloppy( new Uint32Array( idx.getArray() ), new Float32Array( pos.getArray() ), 3, null, target * 3, suffix ? 0.03 : 0.01 )[ 0 ];
			idx.setArray( ni ); after = ni.length / 3;

		}

		// copy into the output document, colours as normalized bytes
		const pa = prim.getAttribute( 'POSITION' ).getArray(), ca = prim.getAttribute( 'COLOR_0' ).getArray(), ia = prim.getIndices().getArray();
		const cb = new Uint8Array( ca.length ); for ( let i = 0; i < ca.length; i ++ ) cb[ i ] = Math.round( Math.min( 1, Math.max( 0, ca[ i ] ) ) * 255 );
		const op = out.createPrimitive()
			.setAttribute( 'POSITION', out.createAccessor().setType( 'VEC3' ).setArray( new Float32Array( pa ) ).setBuffer( obuf ) )
			.setAttribute( 'COLOR_0', out.createAccessor().setType( 'VEC4' ).setArray( cb ).setNormalized( true ).setBuffer( obuf ) )
			.setIndices( out.createAccessor().setType( 'SCALAR' ).setArray( new Uint32Array( ia ) ).setBuffer( obuf ) );
		const [ l2, h2 ] = bb( pa );
		if ( ! suffix ) meta[ C.id ] = { tris_in: Math.round( tris ), l: +( h2[ 2 ] - l2[ 2 ] ).toFixed( 2 ), w: +( h2[ 0 ] - l2[ 0 ] ).toFixed( 2 ), h: +h2[ 1 ].toFixed( 2 ) };
		meta[ C.id ][ 'tris' + suffix ] = after;
		oscene.addChild( out.createNode( 'car_' + C.id + suffix ).setMesh( out.createMesh( C.id + suffix ).addPrimitive( op ) ).setExtras( meta[ C.id ] ) );

	}

	console.log( C.id, meta[ C.id ] );

}

await out.transform( prune(), meshopt( { encoder: MeshoptEncoder, level: 'high' } ) );
await io.write( 'out/parked.glb', out );
writeFileSync( 'out/parked.json', JSON.stringify( meta, null, 1 ) );

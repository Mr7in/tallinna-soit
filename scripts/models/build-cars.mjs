// Turns the Sketchfab car models into game-ready GLBs:
//   - all node transforms baked, uniform scale to the real wheelbase, +Z forward, +X left, +Y up
//   - body-local frame of car.js: ground at y = 0, front axle at z = axle[0], rear axle at z = axle[1]
//   - nodes "body" and "wheel_0..3" (FL, FR, RL, RR), each wheel centred on its hub, axle along X
//   - simplified meshes, webp textures, meshopt compression
// Usage: node build-cars.mjs  (reads raw/*.glb, writes out/*.glb and out/cars.json)
import { NodeIO, getBounds, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup, join, textureCompress, meshopt, transformMesh, flatten, clearNodeTransform, unpartition } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

// physics axles (from vehicle.js CAR_SPECS): distance of the axles from the centre of mass
const CARS = [
	{ id: 'rally', src: 'raw/ts_subaru_22b.glb', wheelbase: 2.52, axle: [ 1.06, - 1.46 ], tris: 70000,
		drop: /INT_|STEERING|CALIPER|LOD_B|LOD_C/i,
		wheel: n => /TYRE|WHEEL_mm_wheel/i.test( n ), paint: [ 'material' ] },
	{ id: 'touring', src: 'raw/ts_volvo_850.glb', wheelbase: 2.664, axle: [ 1.02, - 1.64 ], tris: 60000,
		drop: /rufrack|rollcage|decal|EnvironmentAmbientLight|licenseplate|seats_R|shifter|gauges/i, volvo: true, paint: [ 'Volvo850R', 'Volvo850R_nodamage' ] },
	{ id: 'coupe', src: 'raw/ts_bmw_m3_e30.glb', wheelbase: 2.565, axle: [ 1.26, - 1.31 ], tris: 70000,
		bmw: true, paint: [ 'Material.001' ] },
];

const meta = {};
mkdirSync( 'out', { recursive: true } );

for ( const C of CARS ) {

	const doc = await io.read( C.src );
	const root = doc.getRoot();
	const scene = root.listScenes()[ 0 ];

	// bake every transform into the geometry (clone meshes that are shared by several nodes first)
	const used = new Map();
	for ( const n of root.listNodes() ) {

		const m = n.getMesh(); if ( ! m ) continue;
		if ( used.has( m ) ) n.setMesh( m.clone() ); else used.set( m, n );

	}

	// name of each mesh node, including the parent name for the FBX/Collada style exports
	const parentName = new Map();
	const nameOf = n => n.getName() + ' ' + ( n.getMesh()?.getName() || '' );
	for ( const p of root.listNodes() ) for ( const c of p.listChildren() ) parentName.set( c, p.getName() );

	// bake world transforms into the meshes and hang every mesh node directly under the scene
	const meshNodes0 = root.listNodes().filter( n => n.getMesh() );
	const worlds = meshNodes0.map( n => n.getWorldMatrix() );
	meshNodes0.forEach( ( n, i ) => {

		transformMesh( n.getMesh(), worlds[ i ] );
		const p = n.getParentNode(); if ( p ) p.removeChild( n );
		n.setMatrix( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
		scene.addChild( n );

	} );
	await doc.transform( weld() );

	const meshNodes = root.listNodes().filter( n => n.getMesh() );
	const label = n => ( parentName.get( n ) || '' ) + ' / ' + nameOf( n );
	const bounds = n => getBounds( n );
	const centre = b => b.min.map( ( v, i ) => ( v + b.max[ i ] ) / 2 );
	const size = b => b.max.map( ( v, i ) => v - b.min[ i ] );

	const drop = [], wheelParts = [], body = [];
	for ( const n of meshNodes ) {

		const l = label( n );
		const tc = n.getMesh().listPrimitives().reduce( ( a, p ) => a + ( p.getIndices() ? p.getIndices().getCount() : 0 ) / 3, 0 );
		const nc = centre( bounds( n ) );
		if ( C.bmw && tc > 30000 && Math.abs( nc[ 0 ] ) > 0.9 ) { ( nc[ 2 ] > 2 ? drop : wheelParts ).push( n ); if ( nc[ 2 ] > 2 ) ( C._fw = C._fw || [] ).push( nc[ 2 ] ); continue; }
		if ( C.bmw && /rubber/.test( n.getMesh().listPrimitives()[ 0 ].getMaterial()?.getName() || '' ) && Math.abs( nc[ 0 ] ) < 0.3 ) {

			// all four tyres are one mesh: keep the two rear ones, split by side, as wheel parts
			for ( const side of [ 1, - 1 ] ) {

				const m = doc.createMesh( 'tyre' );
				for ( const p of n.getMesh().listPrimitives() ) {

					const q = p.clone(), pos = p.getAttribute( 'POSITION' ), idx = p.getIndices().getArray(), keep = [], v = [];
					for ( let t = 0; t < idx.length; t += 3 ) {

						let x = 0, z = 0;
						for ( let k = 0; k < 3; k ++ ) { pos.getElement( idx[ t + k ], v ); x += v[ 0 ]; z += v[ 2 ]; }
						if ( Math.sign( x ) === side && z / 3 < nc[ 2 ] ) keep.push( idx[ t ], idx[ t + 1 ], idx[ t + 2 ] );

					}

					q.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( new Uint32Array( keep ) ) );
					m.addPrimitive( q );

				}

				const tn = doc.createNode( 'tyre' ).setMesh( m ); scene.addChild( tn ); wheelParts.push( tn );

			}

			drop.push( n ); continue;

		}

		if ( C.bmw && /brake_disc/.test( n.getMesh().listPrimitives()[ 0 ].getMaterial()?.getName() || '' ) && Math.abs( nc[ 0 ] ) < 0.3 ) { drop.push( n ); continue; }
		if ( C.drop && C.drop.test( l ) ) drop.push( n );
		else if ( C.wheel && C.wheel( l ) ) wheelParts.push( n );
		else body.push( n );

	}

	// ---- wheels: one source per side, centred, axle along X ----
	// each wheel entry: { prims: [mesh], c: [x,y,z] (centre in model units), side: +1 left / -1 right, front }
	let wheels = [];
	if ( C.volvo ) {

		// the model has one rim (Volvo850R_wheel_17x8, at the origin) and a complete spare wheel lying on the roof rack.
		// Rim from the first, tyre from the spare (rotated upright).
		const rim = body.filter( n => /wheel_17x8/i.test( label( n ) ) );
		const all = root.listNodes().filter( n => n.getMesh() );
		const tyre = all.find( n => /rufrack/i.test( label( n ) ) && /tire/i.test( n.getMesh().listPrimitives()[ 0 ].getMaterial()?.getName() || '' ) );
		for ( const r of rim ) body.splice( body.indexOf( r ), 1 );
		// rim centre, then the spare tyre rotated from axis Y to axis X (about Z) and moved onto it
		const rb = rim.map( r => getBounds( r ) ).reduce( ( a, b ) => ( { min: a.min.map( ( v, k ) => Math.min( v, b.min[ k ] ) ), max: a.max.map( ( v, k ) => Math.max( v, b.max[ k ] ) ) } ) );
		const rc = centre( rb );
		const tyreMesh = tyre.getMesh().clone();
		transformMesh( tyreMesh, [ 0, - 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
		fixTranslate( tyreMesh, rc );
		drop.push( tyre );
		const src = { prims: [ ...rim.map( r => r.getMesh() ), tyreMesh ], c: rc };
		const tyreR = Math.max( ...size( getBoundsMesh( tyreMesh ) ).slice( 1 ) ) / 2;
		C._tyreR = tyreR;
		// arches: front fender centre gives the front axle; real wheelbase gives the rear one
		const fender = body.find( n => /fender_L/i.test( label( n ) ) );
		const fz = centre( bounds( fender ) )[ 2 ];
		const wy = tyreR; // this export stands on y = 0
		const tr = 0.735; // half track (m)
		wheels = [ [ 1, true ], [ - 1, true ], [ 1, false ], [ - 1, false ] ].map( ( [ side, front ] ) => ( {
			src, side, front, at: [ side * tr, wy, front ? fz : fz - C.wheelbase ] } ) );
		C._modelWB = C.wheelbase; // already metres

	} else {

		// group the wheel parts by corner
		const parts = wheelParts.map( n => ( { n, c: centre( bounds( n ) ) } ) );
		const xs = parts.map( p => p.c[ 0 ] ), zs = parts.map( p => p.c[ 2 ] );
		const zMid = ( Math.min( ...zs ) + Math.max( ...zs ) ) / 2;
		const corner = p => ( ! C.bmw && p.c[ 2 ] > zMid ? 0 : 2 ) + ( p.c[ 0 ] > 0 ? 0 : 1 );
		const groups = [ [], [], [], [] ];
		for ( const p of parts ) groups[ corner( p ) ].push( p );
		if ( C.bmw ) {

			// only the straight rear wheels are kept; the front axle sits where the (steered) front wheels were
			const fzz = C._fw.reduce( ( a, b ) => a + b, 0 ) / C._fw.length;
			groups[ 0 ] = groups[ 2 ]; groups[ 1 ] = groups[ 3 ];
			C._frontZ = fzz;

		}

		wheels = groups.map( ( g, i ) => {

			const b = g.map( p => bounds( p.n ) ).reduce( ( a, b ) => ( { min: a.min.map( ( v, k ) => Math.min( v, b.min[ k ] ) ), max: a.max.map( ( v, k ) => Math.max( v, b.max[ k ] ) ) } ) );
			const c = centre( b );
			const at = [ ...c ];
			if ( C.bmw && i < 2 ) at[ 2 ] = C._frontZ;
			return { src: { prims: g.map( p => p.n.getMesh() ), c }, side: i % 2 ? - 1 : 1, front: i < 2, at, R: size( b )[ 1 ] / 2 };

		} );
		C._modelWB = ( wheels[ 0 ].at[ 2 ] + wheels[ 1 ].at[ 2 ] ) / 2 - ( wheels[ 2 ].at[ 2 ] + wheels[ 3 ].at[ 2 ] ) / 2;
		C._tyreR = wheels[ 2 ].R;

	}

	// ---- global transform: scale to the real wheelbase, front axle to axle[0], wheel centres to y = tyre radius ----
	const s = C.wheelbase / C._modelWB;
	const R = C._tyreR * s;
	const fzModel = ( wheels[ 0 ].at[ 2 ] + wheels[ 1 ].at[ 2 ] ) / 2;
	const yModel = wheels.reduce( ( a, w ) => a + w.at[ 1 ], 0 ) / 4;
	const xModel = wheels.reduce( ( a, w ) => a + w.at[ 0 ], 0 ) / 4;
	const T = [ - xModel * s, R - yModel * s, C.axle[ 0 ] - fzModel * s ];
	const G = mat( [ s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, T[ 0 ], T[ 1 ], T[ 2 ], 1 ] );

	// ---- output document ----
	// strays below the ground (the Volvo export keeps a spare rim prototype at the origin)
	for ( const n of body.slice() ) if ( getBounds( n ).min[ 1 ] < - 0.08 && C.volvo ) { body.splice( body.indexOf( n ), 1 ); drop.push( n ); }
	for ( const n of drop ) n.dispose();
	const bodyMesh = doc.createMesh( 'body' );
	for ( const n of body ) {

		const src = n.getMesh();
		for ( const p of src.listPrimitives() ) { src.removePrimitive( p ); bodyMesh.addPrimitive( p ); }
		n.dispose();

	}

	transformMesh( bodyMesh, G );
	const outScene = doc.createScene( 'car' );
	const bodyNode = doc.createNode( 'body' ).setMesh( bodyMesh );
	outScene.addChild( bodyNode );

	// wheels: geometry in wheel space (centre at origin); right side = left wheel turned 180 deg about Y when the
	// model only has one side; per-corner sources keep their own geometry
	const made = new Map();
	wheels.forEach( ( w, i ) => {

		let key = w.src.prims[ 0 ];
		let m;
		if ( C.volvo && w.side < 0 && made.has( 'L' ) ) {

			m = made.get( 'L' ).clone();
			transformMesh( m, mat( [ - 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1 ] ) );

		} else if ( made.has( key ) ) m = made.get( key ).clone();
		else {

			m = doc.createMesh( 'wheel' );
			for ( const src of w.src.prims ) for ( const p of src.listPrimitives() ) {

				if ( C.volvo ) m.addPrimitive( p.clone() );
				else { src.removePrimitive( p ); m.addPrimitive( p ); }

			}

			const c = w.src.c;
			transformMesh( m, mat( [ s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, - c[ 0 ] * s, - c[ 1 ] * s, - c[ 2 ] * s, 1 ] ) );
			made.set( key, m );
			if ( C.volvo ) made.set( 'L', m );

		}

		const node = doc.createNode( 'wheel_' + i ).setMesh( m );
		node.setTranslation( [ w.at[ 0 ] * s + T[ 0 ], R, w.at[ 2 ] * s + T[ 2 ] ] );
		outScene.addChild( node );

	} );

	for ( const sc of root.listScenes() ) if ( sc !== outScene ) sc.dispose();
	root.setDefaultScene( outScene );

	// ---- materials ----
	for ( const m of root.listMaterials() ) {

		const n = m.getName();
		// transmission needs an extra render pass in three.js: plain tinted glass is enough here
		const tr = m.getExtension( 'KHR_materials_transmission' );
		if ( tr ) { m.setExtension( 'KHR_materials_transmission', null ); m.setAlphaMode( 'BLEND' ); const c = m.getBaseColorFactor(); m.setBaseColorFactor( [ c[ 0 ] * 0.15, c[ 0 ] * 0.17, c[ 0 ] * 0.2, 0.45 ] ); m.setRoughnessFactor( 0.05 ); m.setMetallicFactor( 0.3 ); }
		if ( C.volvo ) volvoMaterial( m, C.paint.includes( n ) ? 'paint' : n );
		if ( C.paint.includes( n ) ) m.setName( 'paint' );

	}

	await doc.transform(
		prune(), dedup(), join( { keepNamed: true } ), weld(),
		simplify( { simplifier: MeshoptSimplifier, ratio: 1, error: 0.0004 } ),
	);
	// bring the triangle count under the budget with an even ratio
	let tris = countTris( doc );
	
	if ( tris > C.tris ) await doc.transform( simplify( { simplifier: MeshoptSimplifier, ratio: C.tris / tris, error: 0.004, lockBorder: false } ) );
	tris = countTris( doc );
	const wb = getBounds( outScene );
	await doc.transform(
		textureCompress( { encoder: sharp, targetFormat: 'webp', resize: [ 1024, 1024 ], quality: 82 } ),
		prune(), dedup(),
		meshopt( { encoder: MeshoptEncoder, level: 'medium' } ),
	);
	await io.write( `out/${C.id}.glb`, doc );
	meta[ C.id ] = { R: +R.toFixed( 3 ), track: +Math.abs( wheels[ 0 ].at[ 0 ] * s + T[ 0 ] ).toFixed( 3 ), axle: C.axle, tris, length: +( wb.max[ 2 ] - wb.min[ 2 ] ).toFixed( 3 ), width: +( wb.max[ 0 ] - wb.min[ 0 ] ).toFixed( 3 ), height: +( wb.max[ 1 ] - wb.min[ 1 ] ).toFixed( 3 ), zF: +wb.max[ 2 ].toFixed( 3 ), zR: +wb.min[ 2 ].toFixed( 3 ) };
	console.log( C.id, meta[ C.id ] );

}

writeFileSync( 'out/cars.json', JSON.stringify( meta, null, 1 ) );

// ---------- helpers ----------
function mat( a ) { return a; }
function getBoundsMesh( m ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( const p of m.listPrimitives() ) {

		const a = p.getAttribute( 'POSITION' ); const v = [];
		for ( let i = 0; i < a.getCount(); i ++ ) { a.getElement( i, v ); for ( let k = 0; k < 3; k ++ ) { min[ k ] = Math.min( min[ k ], v[ k ] ); max[ k ] = Math.max( max[ k ], v[ k ] ); } }

	}

	return { min, max };

}

function fixTranslate( m, target ) {

	const b = getBoundsMesh( m ), c = b.min.map( ( v, i ) => ( v + b.max[ i ] ) / 2 );
	transformMesh( m, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, target[ 0 ] - c[ 0 ], target[ 1 ] - c[ 1 ], target[ 2 ] - c[ 2 ], 1 ] );

}

function countTris( doc ) {

	let t = 0;
	for ( const m of doc.getRoot().listMeshes() ) for ( const p of m.listPrimitives() ) { const i = p.getIndices(); t += ( i ? i.getCount() : p.getAttribute( 'POSITION' ).getCount() ) / 3; }
	return Math.round( t );

}

// the Volvo export lost its textures and has placeholder colours: give each part a sensible material
function volvoMaterial( m, n ) {

	const set = ( c, met, rough, a = 1 ) => { m.setBaseColorFactor( [ ...c, a ] ); m.setMetallicFactor( met ); m.setRoughnessFactor( rough ); if ( a < 1 ) m.setAlphaMode( 'BLEND' ); };
	if ( n === 'paint' ) set( [ 0.9, 0.62, 0.05 ], 0.3, 0.35 );
	else if ( /silver|Mirror|S60R_rim|Volvo850R_gray$/.test( n ) ) set( [ 0.75, 0.76, 0.78 ], 1, 0.25 );
	else if ( /black|gray2|undercarriage|underbody|interior|pessima|wood|alt$/.test( n ) ) set( [ 0.03, 0.03, 0.035 ], 0, 0.7 );
	else if ( /tire/.test( n ) ) set( [ 0.025, 0.025, 0.027 ], 0, 0.9 );
	else if ( /glass/.test( n ) && ! /lights/.test( n ) ) set( [ 0.05, 0.06, 0.07 ], 0.3, 0.05, 0.55 );
	else if ( /lights_glass/.test( n ) ) set( [ 0.9, 0.92, 0.95 ], 0.2, 0.05, 0.35 );
	else if ( /taillight|chmsl/.test( n ) ) { set( [ 0.55, 0.02, 0.03 ], 0, 0.3 ); m.setEmissiveFactor( [ 0.5, 0.02, 0.02 ] ); }
	else if ( /signal|foglight/.test( n ) ) set( [ 0.95, 0.5, 0.05 ], 0, 0.3 );
	else if ( /headlight|beam|reverselight|lights_misc/.test( n ) ) set( [ 0.9, 0.92, 0.95 ], 0.6, 0.15 );
	else set( [ 0.1, 0.1, 0.11 ], 0, 0.6 );

}

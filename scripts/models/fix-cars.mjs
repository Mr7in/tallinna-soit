// Second pass over the game GLBs written by build-cars.mjs (works on public/models/*.glb in place):
//   touring (Volvo 850 T-5R): the export has one paint material for every exterior part. Wipers, headlamp
//     wipers, grille slats, door handles and other small plastic parts are split off to black trim; the paint
//     becomes white (the game's default colour for this car).
//   coupe (BMW M3 E30): the wheel centre caps were part of the body (the front ones still at the steered
//     angle of the source model). They move into the wheels, so they sit on the hubs and turn with them.
//     The author's custom number plates are removed: the game draws Estonian plates.
// Usage: node fix-cars.mjs [models dir]   (needs @gltf-transform/*, meshoptimizer)
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { transformMesh, prune, dedup, meshopt, dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );
const DIR = process.argv[ 2 ] || 'public/models';
const I4 = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

// bake node transforms into the meshes; wheels keep their hub as the node translation
async function open( file ) {

	const doc = await io.read( file );
	await doc.transform( dequantize() );
	for ( const n of doc.getRoot().getDefaultScene().listChildren() ) {

		// wheels share meshes and vertex data between corners: give every node its own copy before baking
		const m = n.getMesh().clone();
		n.setMesh( m );
		for ( const p of m.listPrimitives() ) for ( const sem of p.listSemantics() ) p.setAttribute( sem, p.getAttribute( sem ).clone() );
		transformMesh( m, n.getMatrix() );
		n.setMatrix( I4 );
		if ( /^wheel_/.test( n.getName() ) ) {

			const b = getBounds( n ), c = b.min.map( ( v, i ) => ( v + b.max[ i ] ) / 2 );
			transformMesh( m, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, - c[ 0 ], - c[ 1 ], - c[ 2 ], 1 ] );
			n.setTranslation( c );

		}

	}

	return doc;

}

async function save( doc, file ) {

	await doc.transform( prune(), dedup(), meshopt( { encoder: MeshoptEncoder, level: 'medium' } ) );
	await io.write( file, doc );

}

// connected parts of a primitive (triangles sharing welded positions)
function parts( prim ) {

	const pos = prim.getAttribute( 'POSITION' ), idx = prim.getIndices().getArray();
	const n = pos.getCount(), P = new Float32Array( n * 3 ), v = [];
	for ( let i = 0; i < n; i ++ ) { pos.getElement( i, v ); P.set( v, i * 3 ); }
	const par = Int32Array.from( { length: n }, ( _, i ) => i );
	const find = i => { while ( par[ i ] !== i ) { par[ i ] = par[ par[ i ] ]; i = par[ i ]; } return i; };
	const join = ( a, b ) => { a = find( a ); b = find( b ); if ( a !== b ) par[ a ] = b; };
	const seen = new Map();
	for ( let i = 0; i < n; i ++ ) {

		const k = Math.round( P[ i * 3 ] * 2000 ) + ',' + Math.round( P[ i * 3 + 1 ] * 2000 ) + ',' + Math.round( P[ i * 3 + 2 ] * 2000 );
		if ( seen.has( k ) ) join( i, seen.get( k ) ); else seen.set( k, i );

	}

	for ( let t = 0; t < idx.length; t += 3 ) { join( idx[ t ], idx[ t + 1 ] ); join( idx[ t ], idx[ t + 2 ] ); }
	const map = new Map();
	for ( let t = 0; t < idx.length; t += 3 ) {

		const r = find( idx[ t ] );
		let c = map.get( r );
		if ( ! c ) map.set( r, c = { tris: [], min: [ 1e9, 1e9, 1e9 ], max: [ - 1e9, - 1e9, - 1e9 ] } );
		c.tris.push( idx[ t ], idx[ t + 1 ], idx[ t + 2 ] );
		for ( let k = 0; k < 3; k ++ ) for ( let a = 0; a < 3; a ++ ) { const x = P[ idx[ t + k ] * 3 + a ]; c.min[ a ] = Math.min( c.min[ a ], x ); c.max[ a ] = Math.max( c.max[ a ], x ); }

	}

	for ( const c of map.values() ) { c.n = c.tris.length / 3; c.c = c.min.map( ( v, i ) => ( v + c.max[ i ] ) / 2 ); }
	return [ ...map.values() ];

}

// a copy of prim restricted to some triangles (same vertex attributes)
function subset( doc, prim, tris ) {

	const q = prim.clone();
	q.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( new Uint32Array( tris ) ) );
	return q;

}

// ================= Volvo 850 T-5R =================
{

	const file = DIR + '/touring.glb';
	const doc = await open( file );
	const body = doc.getRoot().getDefaultScene().listChildren().find( n => n.getName() === 'body' ).getMesh();
	const paint = body.listPrimitives().find( p => p.getMaterial()?.getName() === 'paint' );
	const trimMat = doc.createMaterial( 'trim' ).setBaseColorFactor( [ 0.035, 0.036, 0.04, 1 ] ).setRoughnessFactor( 0.55 ).setMetallicFactor( 0 );
	const keep = [], trim = [];
	for ( const p of parts( paint ) ) {

		// body shell, doors, tailgate, mirror housings and the roof spoiler stay painted; the rest is plastic
		const grille = p.c[ 2 ] > 1.7 && p.c[ 1 ] < 0.45;
		( p.n >= 400 && ! grille ? keep : trim ).push( ...p.tris );

	}

	body.addPrimitive( subset( doc, paint, trim ).setMaterial( trimMat ) );
	body.addPrimitive( subset( doc, paint, keep ) );
	body.removePrimitive( paint );
	paint.getMaterial().setBaseColorFactor( [ 0.93, 0.93, 0.92, 1 ] ).setRoughnessFactor( 0.3 ).setMetallicFactor( 0.05 );
	console.log( 'touring: paint tris', keep.length / 3, 'trim tris', trim.length / 3 );
	await save( doc, file );

}

// ================= BMW M3 E30 =================
{

	const file = DIR + '/coupe.glb';
	const doc = await open( file );
	const nodes = doc.getRoot().getDefaultScene().listChildren();
	const body = nodes.find( n => n.getName() === 'body' ).getMesh();
	const logo = body.listPrimitives().find( p => p.getMaterial()?.getName() === 'Material.016' );
	const rest = [], caps = { L: null, R: null };
	for ( const p of parts( logo ) ) {

		if ( Math.abs( p.c[ 0 ] ) < 0.6 ) { rest.push( ...p.tris ); continue; } // bonnet and boot roundels stay
		if ( p.c[ 2 ] < 0 ) caps[ p.c[ 0 ] > 0 ? 'L' : 'R' ] = p; // the straight rear caps are the templates

	}

	for ( const n of nodes ) {

		const m = n.getName().match( /^wheel_(\d)$/ );
		if ( ! m ) continue;
		const side = + m[ 1 ] % 2 ? 'R' : 'L', cap = caps[ side ];
		// cap geometry relative to its own rear hub, placed on this wheel (whose mesh is centred on its hub)
		const hub = nodes.find( k => k.getName() === 'wheel_' + ( side === 'L' ? 2 : 3 ) ).getTranslation();
		const q = subset( doc, logo, cap.tris );
		const pos = q.getAttribute( 'POSITION' ).clone(), v = [];
		for ( let i = 0; i < pos.getCount(); i ++ ) { pos.getElement( i, v ); pos.setElement( i, [ v[ 0 ] - hub[ 0 ], v[ 1 ] - hub[ 1 ], v[ 2 ] - hub[ 2 ] ] ); }
		q.setAttribute( 'POSITION', pos );
		n.getMesh().addPrimitive( q );

	}

	body.addPrimitive( subset( doc, logo, rest ) );
	body.removePrimitive( logo );
	// the author's custom plates (the game draws its own)
	const plate = body.listPrimitives().find( p => p.getMaterial()?.getName() === 'Material.024' );
	if ( plate ) body.removePrimitive( plate );
	console.log( 'coupe: caps moved into the wheels, plates removed' );
	await save( doc, file );

}

// Street furniture from Sketchfab -> one GLB with a node per game prop: geometry baked, footprint centred at the origin,
// base at y = 0, the side that faces the road / traffic along +Z (as the procedural props in src/roads.js),
// simplified, webp textures, meshopt. Inputs are the Sketchfab glb downloads in raw/.
// Credits: see CREDITS.md
import { NodeIO, Document, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, join, simplify, prune, dedup, textureCompress, meshopt, transformMesh, flatten } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

// game key: source file, node name, yaw (rad) that turns the road-facing side to +Z, size (target height in m, or
// uniform scale), simplification ratio (1 = keep), texture size
const PICK = {
	lamp: { file: 'tall_street_light', node: 'Cylinder', yaw: Math.PI, height: 8.6, ratio: 1, pole: true }, // origin at the pole, arm to +Z
	shelter: { file: 'city_props_v1', node: 'BusStop', yaw: Math.PI, scale: 0.8, ratio: 0.5, error: 0.01, tex: 1024 },
	bench: { file: 'city_props_v1', node: 'ParkBenchShort', yaw: Math.PI / 2, scale: 1, ratio: 0.4, error: 0.01 },
	bin: { file: 'lasnamae_trashcan', node: 'model', yaw: 0, height: 0.85, ratio: 0.0025, error: 1, sloppy: true, tex: 512 }, // phone scan: ~1 M triangles
};

const rotY = a => { const c = Math.cos( a ), s = Math.sin( a ); return [ c, 0, - s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1 ]; };
const scl = k => [ k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1 ];
const mov = ( x, y, z ) => [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 ];

const out = new Document();
const meta = {};
const parts = [];

for ( const [ key, P ] of Object.entries( PICK ) ) {

	const doc = await io.read( `raw/${P.file}.glb` );
	const root = doc.getRoot();
	const src = root.listNodes().find( n => n.getName() === P.node );
	if ( ! src ) throw new Error( `${key}: no node ${P.node}` );

	// bake every primitive under the picked node into one mesh in world space
	const mesh = doc.createMesh( key );
	src.traverse( n => {

		const m = n.getMesh(); if ( ! m ) return;
		const w = n.getWorldMatrix();
		for ( const p of m.listPrimitives() ) { const q = p.clone(); const tmp = doc.createMesh().addPrimitive( q ); transformMesh( tmp, w ); tmp.removePrimitive( q ); tmp.dispose(); mesh.addPrimitive( q ); }

	} );
	const node = doc.createNode( key ).setMesh( mesh );

	transformMesh( mesh, rotY( P.yaw ) );
	let b = getBounds( node );
	const k = P.height ? P.height / ( b.max[ 1 ] - b.min[ 1 ] ) : P.scale;
	transformMesh( mesh, scl( k ) );
	b = getBounds( node );
	const cz = P.pole ? b.min[ 2 ] + ( b.max[ 0 ] - b.min[ 0 ] ) / 2 : ( b.min[ 2 ] + b.max[ 2 ] ) / 2;
	transformMesh( mesh, mov( - ( b.min[ 0 ] + b.max[ 0 ] ) / 2, - b.min[ 1 ], - cz ) );

	// keep only this prop, then clean and simplify it in its own document
	const scene = doc.createScene( key ).addChild( node );
	for ( const s of root.listScenes() ) if ( s !== scene ) s.dispose();
	root.setDefaultScene( scene );
	await doc.transform( prune(), dedup(), flatten(), join(), weld() );
	if ( P.sloppy ) for ( const p of mesh.listPrimitives() ) {

		// scans are cut into islands by their texture atlas: the regular simplifier keeps every seam, sloppy does not
		const idx = p.getIndices(), pos = p.getAttribute( 'POSITION' );
		const [ ni ] = MeshoptSimplifier.simplifySloppy( new Uint32Array( idx.getArray() ), new Float32Array( pos.getArray() ), 3, null, Math.floor( idx.getCount() * P.ratio / 3 ) * 3, P.error );
		idx.setArray( ni );

	} else if ( P.ratio < 1 ) await doc.transform( simplify( { simplifier: MeshoptSimplifier, ratio: P.ratio, error: P.error || 0.002, lockBorder: false } ) );
	await doc.transform( prune() );
	await doc.transform( textureCompress( { encoder: sharp, targetFormat: 'webp', resize: [ P.tex || 512, P.tex || 512 ], quality: 80 } ), prune() );

	const b2 = getBounds( node );
	let tris = 0; for ( const p of mesh.listPrimitives() ) tris += p.getIndices().getCount() / 3;
	meta[ key ] = {
		h: +( b2.max[ 1 ] ).toFixed( 2 ),
		w: +( b2.max[ 0 ] - b2.min[ 0 ] ).toFixed( 2 ), d: +( b2.max[ 2 ] - b2.min[ 2 ] ).toFixed( 2 ),
		zmin: +b2.min[ 2 ].toFixed( 2 ), zmax: +b2.max[ 2 ].toFixed( 2 ), tris,
	};
	node.setExtras( meta[ key ] );
	parts.push( doc );

}

// merge the per-prop documents into one scene
const { mergeDocuments } = await import( '@gltf-transform/functions' );
for ( const d of parts ) mergeDocuments( out, d );
const oroot = out.getRoot();
const final = out.createScene( 'props' );
for ( const s of oroot.listScenes() ) if ( s !== final ) { for ( const n of s.listChildren() ) final.addChild( n ); s.dispose(); }
oroot.setDefaultScene( final );
for ( const b of oroot.listBuffers().slice( 1 ) ) {

	for ( const a of oroot.listAccessors() ) a.setBuffer( oroot.listBuffers()[ 0 ] );
	b.dispose();

}

await out.transform( prune(), dedup(), meshopt( { encoder: MeshoptEncoder, level: 'medium' } ) );
await io.write( 'out/props.glb', out );
writeFileSync( 'out/props.json', JSON.stringify( meta, null, 1 ) );
console.log( meta );

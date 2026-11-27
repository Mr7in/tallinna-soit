// Picks the species that fit Tallinn from the Gravel Rally tree pack (summer set) and writes one GLB with a node per
// species: geometry baked, base centred at the origin (trunk foot at y = 0), simplified, webp textures.
// Credit: Deni S., Gravel Rally tree pack (CC BY 4.0), https://sketchfab.com/3d-models/gravel-rally-tree-pack-27-trees-3-seasons-65da19fc1a4449a988f8dbaf2513ae59
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, prune, dedup, textureCompress, meshopt, transformMesh } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

// game key -> pack name, share of triangles kept (informational; one global ratio is applied)
const PICK = {
	birch: [ 'Birch', 0.55 ], oak: [ 'Oak', 0.7 ], hornbeam: [ 'Hornbeam', 0.65 ], plane: [ 'Plane', 0.7 ], poplar: [ 'Poplar', 0.65 ],
	pine: [ 'Pine', 0.8 ], pine2: [ 'Plantation pine', 0.8 ],
	hazel: [ 'Hazel', 0.6 ], bush: [ 'Bush', 0.6 ], thicket: [ 'Thicket', 0.6 ],
};

const doc = await io.read( 'raw/trees.glb' );
const root = doc.getRoot();
const summer = root.listNodes().find( n => /^Summer/.test( n.getName() ) );
const scene = root.listScenes()[ 0 ];
const out = doc.createScene( 'trees' );
const meta = {};

for ( const [ key, [ name, ratio ] ] of Object.entries( PICK ) ) {

	const src = summer.listChildren().find( c => c.getName().startsWith( name + ' (summer)' ) );
	const mesh = doc.createMesh( key );
	src.traverse( n => {

		const m = n.getMesh(); if ( ! m ) return;
		const w = n.getWorldMatrix();
		for ( const p of m.listPrimitives() ) { const q = p.clone(); const tmp = doc.createMesh().addPrimitive( q ); transformMesh( tmp, w ); tmp.removePrimitive( q ); tmp.dispose(); mesh.addPrimitive( q ); }

	} );
	const node = doc.createNode( key ).setMesh( mesh );
	const b = getBounds( node );
	const cx = ( b.min[ 0 ] + b.max[ 0 ] ) / 2, cz = ( b.min[ 2 ] + b.max[ 2 ] ) / 2;
	transformMesh( mesh, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, - cx, - b.min[ 1 ], - cz, 1 ] );
	const b2 = getBounds( node );
	meta[ key ] = { h: +( b2.max[ 1 ] ).toFixed( 2 ), w: +Math.max( b2.max[ 0 ] - b2.min[ 0 ], b2.max[ 2 ] - b2.min[ 2 ] ).toFixed( 2 ), ratio };
	node.setExtras( meta[ key ] );
	out.addChild( node );

}

for ( const s of root.listScenes() ) if ( s !== out ) s.dispose();
root.setDefaultScene( out );
await doc.transform( prune(), dedup(), weld() );
// vertex colours carry the leaf tint in RGB but 0 in alpha (the pack's game uses alpha for something else):
// three.js multiplies alpha in, so drop it
for ( const m of root.listMeshes() ) for ( const p of m.listPrimitives() ) {

	const c = p.getAttribute( 'COLOR_0' ); if ( ! c || c.getType() !== 'VEC4' ) continue;
	const a = c.getArray(), out = new Float32Array( a.length / 4 * 3 );
	for ( let i = 0, j = 0; i < a.length; i += 4, j += 3 ) { out[ j ] = a[ i ]; out[ j + 1 ] = a[ i + 1 ]; out[ j + 2 ] = a[ i + 2 ]; }
	p.setAttribute( 'COLOR_0', doc.createAccessor().setType( 'VEC3' ).setArray( out ).setBuffer( c.getBuffer() ) );

}

// bark only: leaf and needle cards are single quads that simplification would delete
for ( const m of root.listMeshes() ) for ( const p of m.listPrimitives() ) if ( /bark/.test( p.getMaterial()?.getName() || '' ) ) simplifyPrimitive( p, { simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.01 } );
await doc.transform(
	textureCompress( { encoder: sharp, targetFormat: 'webp', resize: [ 512, 512 ], quality: 80 } ),
	prune(), dedup(),
	meshopt( { encoder: MeshoptEncoder, level: 'medium' } ),
);
let tris = 0;
for ( const n of out.listChildren() ) { let t = 0; for ( const p of n.getMesh().listPrimitives() ) t += p.getIndices().getCount() / 3; meta[ n.getName() ].tris = t; tris += t; }
await io.write( 'out/trees.glb', doc );
writeFileSync( 'out/trees.json', JSON.stringify( meta, null, 1 ) );
console.log( meta, 'total', tris );

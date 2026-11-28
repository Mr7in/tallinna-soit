import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------- street furniture models (merged, vertex coloured, +Z faces the road / traffic) ----------
function part( geo, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 ) {

	geo = geo.toNonIndexed();
	geo.rotateX( rx ); geo.rotateY( ry ); geo.rotateZ( rz );
	geo.translate( x, y, z );
	const c = new THREE.Color( hex ), n = geo.attributes.position.count, a = new Float32Array( n * 3 );
	for ( let i = 0; i < n; i ++ ) { a[ i * 3 ] = c.r; a[ i * 3 + 1 ] = c.g; a[ i * 3 + 2 ] = c.b; }
	geo.setAttribute( 'color', new THREE.BufferAttribute( a, 3 ) );
	if ( geo.attributes.uv ) geo.deleteAttribute( 'uv' );
	return geo;

}

const Box = ( w, h, d ) => new THREE.BoxGeometry( w, h, d );
const Cyl = ( r0, r1, h, s = 8 ) => new THREE.CylinderGeometry( r0, r1, h, s );
const POLE = 0x6f7478, DARK = 0x2b2e31;
const GALV = 0x8c9195, GALV_DARK = 0x6a6f73, BLACK = 0x17191a, FRAME = 0x35383b, GLASS = 0x7d9199;

export const LENS_Z = 0.225;
export const LENS = [ [ 3.32, 0xff2a1a ], [ 3.0, 0xffb000 ], [ 2.68, 0x29e05a ] ];

// type: [geometry, height, collision radius]
let MODELS = null;
export function models() {

	if ( MODELS ) return MODELS;
	MODELS = {
		// LED street lamp (Tallinn's current standard): tapered galvanized pole, short arm tilted up, slim flat luminaire
		1: [ mergeGeometries( [
			part( Cyl( 0.055, 0.1, 8.0, 10 ), GALV, 0, 4.0, 0 ),
			part( Cyl( 0.12, 0.12, 0.45, 10 ), GALV_DARK, 0, 0.22, 0 ),
			part( Cyl( 0.035, 0.035, 1.0, 6 ), GALV, 0, 8.02, 0.46, Math.PI / 2 - 0.16 ),
			part( Box( 0.34, 0.07, 0.62 ), 0x6e7377, 0, 8.12, 1.2, - 0.12 ),
			part( Box( 0.27, 0.02, 0.5 ), 0xfff1d2, 0, 8.08, 1.21, - 0.12 ),
		] ), 8.2, 0.14 ],
		// traffic light as in Tallinn: grey galvanized pole, black three-lamp head with hoods (no white backplate),
		// side-mounted pedestrian head, push-button box, blue crossing sign on top (lenses are separate, animated)
		2: [ mergeGeometries( [
			part( Cyl( 0.055, 0.06, 3.9, 10 ), GALV, 0, 1.95, 0 ),
			part( Cyl( 0.085, 0.09, 0.3, 10 ), GALV_DARK, 0, 0.15, 0 ),
			part( Box( 0.3, 1.0, 0.2 ), BLACK, 0, 3.0, 0.12 ),
			part( Box( 0.08, 0.5, 0.08 ), BLACK, 0, 3.0, 0.03 ),
			...LENS.map( ( [ y ] ) => part( new THREE.CylinderGeometry( 0.112, 0.112, 0.16, 10, 1, true, - Math.PI / 2, Math.PI ), BLACK, 0, y, 0.3, - Math.PI / 2 ) ),
			part( Box( 0.24, 0.58, 0.16 ), BLACK, 0.19, 2.25, 0, 0, Math.PI / 2 ), // pedestrian head
			part( new THREE.CircleGeometry( 0.085, 10 ), 0x5c0d0a, 0.275, 2.39, 0, 0, Math.PI / 2 ),
			part( new THREE.CircleGeometry( 0.085, 10 ), 0x0b3d1c, 0.275, 2.1, 0, 0, Math.PI / 2 ),
			part( Box( 0.12, 0.2, 0.09 ), 0x2c2f31, 0, 1.1, 0.09 ), // push button
			part( Box( 0.08, 0.06, 0.01 ), 0xe8e8e4, 0, 1.15, 0.136 ),
			part( Box( 0.6, 0.6, 0.03 ), 0x1f5fbf, 0, 3.95, 0.09 ), // crossing sign
			part( new THREE.CircleGeometry( 0.26, 3 ), 0xffffff, 0, 3.92, 0.11, 0, 0, Math.PI / 2 ),
			part( Box( 0.62, 0.62, 0.02 ), 0x9a9ea2, 0, 3.95, 0.065 ),
		] ), 4.25, 0.13 ],
		// bus shelter after Tallinn's new pavilions: anthracite frame, thin light roof, glass back and one glass side,
		// back-lit advert box at the other end, wooden bench, slim stop totem by the kerb
		3: [ mergeGeometries( [
			part( Box( 4.3, 0.12, 1.9 ), 0xdcddd9, 0, 2.52, 0.1 ),
			part( Box( 4.32, 0.05, 1.92 ), FRAME, 0, 2.44, 0.1 ),
			...[ - 2.0, 2.0 ].flatMap( x => [ part( Box( 0.08, 2.42, 0.08 ), FRAME, x, 1.21, - 0.7 ), part( Box( 0.08, 2.42, 0.08 ), FRAME, x, 1.21, 0.55 ) ] ),
			part( Box( 3.92, 2.05, 0.03 ), GLASS, 0, 1.2, - 0.7 ),
			part( Box( 3.92, 0.06, 0.06 ), FRAME, 0, 0.17, - 0.7 ),
			part( Box( 0.03, 2.05, 1.2 ), GLASS, 2.0, 1.2, - 0.08 ),
			part( Box( 0.16, 2.1, 1.28 ), FRAME, - 2.0, 1.15, - 0.08 ), // advert box
			part( Box( 0.18, 1.8, 1.08 ), 0xf2eedf, - 2.0, 1.2, - 0.08 ),
			part( Box( 1.9, 0.05, 0.42 ), 0x9a6a3e, 0.2, 0.46, - 0.42 ), // bench
			part( Box( 1.9, 0.3, 0.04 ), 0x9a6a3e, 0.2, 0.72, - 0.64 ),
			...[ - 0.6, 1.0 ].map( x => part( Box( 0.06, 0.44, 0.38 ), FRAME, x, 0.22, - 0.42 ) ),
			part( Box( 0.2, 2.8, 0.1 ), FRAME, 2.5, 1.4, 0.7 ), // stop totem
			part( Box( 0.36, 0.42, 0.12 ), 0xf2f2ef, 2.5, 2.55, 0.7 ),
			part( Box( 0.22, 0.08, 0.125 ), 0x1d4f9c, 2.5, 2.66, 0.7 ),
		] ), 2.6, 1.4 ],
		4: [ mergeGeometries( [ // speed camera
			part( Cyl( 0.1, 0.12, 3.3 ), 0x8e9398, 0, 1.65, 0 ),
			part( Box( 0.5, 0.62, 0.8 ), 0x9aa0a5, 0, 3.55, 0 ),
			part( Box( 0.46, 0.06, 0.86 ), 0x5d6266, 0, 3.89, 0 ),
			part( Box( 0.3, 0.3, 0.04 ), 0x141414, 0, 3.6, 0.41 ),
			part( Box( 0.5, 0.1, 0.02 ), 0xf2c300, 0, 3.2, 0.41 ),
		] ), 3.9, 0.2 ],
		5: [ mergeGeometries( [ // bench
			part( Box( 1.7, 0.06, 0.45 ), 0x8a5a33, 0, 0.45, 0 ),
			part( Box( 1.7, 0.38, 0.05 ), 0x8a5a33, 0, 0.75, - 0.22 ),
			part( Box( 0.06, 0.45, 0.45 ), DARK, - 0.75, 0.22, 0 ),
			part( Box( 0.06, 0.45, 0.45 ), DARK, 0.75, 0.22, 0 ),
		] ), 0.95, 0.6 ],
		6: [ part( Cyl( 0.24, 0.2, 0.85, 10 ), 0x2f5d3a, 0, 0.42, 0 ), 0.85, 0.28 ],
		7: [ mergeGeometries( [ // give way
			part( Cyl( 0.04, 0.04, 2.4 ), POLE, 0, 1.2, 0 ),
			part( new THREE.CircleGeometry( 0.52, 3 ), 0xd4151b, 0, 2.15, 0.05, 0, 0, - Math.PI / 2 ),
			part( new THREE.CircleGeometry( 0.36, 3 ), 0xffffff, 0, 2.15, 0.055, 0, 0, - Math.PI / 2 ),
			part( new THREE.CircleGeometry( 0.52, 3 ), 0xb0b0b0, 0, 2.15, 0.045, 0, Math.PI, - Math.PI / 2 ),
		] ), 2.6, 0.08 ],
		8: [ mergeGeometries( [ // stop
			part( Cyl( 0.04, 0.04, 2.4 ), POLE, 0, 1.2, 0 ),
			part( new THREE.CircleGeometry( 0.42, 8 ), 0xffffff, 0, 2.15, 0.05, 0, 0, Math.PI / 8 ),
			part( new THREE.CircleGeometry( 0.38, 8 ), 0xd4151b, 0, 2.15, 0.055, 0, 0, Math.PI / 8 ),
			part( new THREE.CircleGeometry( 0.42, 8 ), 0xb0b0b0, 0, 2.15, 0.045, 0, Math.PI, Math.PI / 8 ),
		] ), 2.6, 0.08 ],
		// fence / hedge / wall panels: 1 m long along +X, scaled to the panel length
		9: [ mergeGeometries( [
			part( Box( 0.08, 1.3, 0.08 ), 0x4a4f52, - 0.48, 0.65, 0 ),
			part( Box( 1, 0.05, 0.04 ), 0x5b6064, 0, 1.15, 0 ),
			part( Box( 1, 0.05, 0.04 ), 0x5b6064, 0, 0.3, 0 ),
			...[ - 0.36, - 0.24, - 0.12, 0, 0.12, 0.24, 0.36 ].map( x => part( Box( 0.05, 1.2, 0.02 ), 0x7a5a3c, x, 0.68, 0.025 ) ),
		] ), 1.3, 0.5 ],
		10: [ part( Box( 1.02, 1.25, 0.8 ), 0x3d6b33, 0, 0.62, 0 ), 1.25, 0.55 ],
		11: [ mergeGeometries( [
			part( Box( 1.01, 1.7, 0.3 ), 0xb2a690, 0, 0.85, 0 ),
			part( Box( 1.03, 0.08, 0.36 ), 0x8d8473, 0, 1.73, 0 ),
		] ), 1.75, 0.5 ],
		// garden board fence (light: one post + one board panel)
		12: [ mergeGeometries( [
			part( Box( 0.09, 1.35, 0.09 ), 0x5e4a35, - 0.48, 0.67, 0 ),
			part( Box( 1, 1.1, 0.03 ), 0x9a7650, 0, 0.66, 0 ),
		] ), 1.35, 0.5 ],
	};
	// mast arm parts: taller, thicker pole; arm 1 m long along +X (scaled to the reach); hanging head (same
	// layout as the pole head, centred at y 3.0, hanger on top up to the arm)
	MODELS.mast = mergeGeometries( [
		part( Cyl( 0.09, 0.12, 6.05, 10 ), GALV, 0, 3.02, 0 ),
		part( Cyl( 0.14, 0.15, 0.35, 10 ), GALV_DARK, 0, 0.17, 0 ),
	] );
	MODELS.arm = mergeGeometries( [
		part( Cyl( 0.07, 0.07, 1, 8 ), GALV, 0.5, 0, 0, 0, 0, Math.PI / 2 ),
	] );
	MODELS.head = mergeGeometries( [
		part( Box( 0.3, 1.0, 0.2 ), BLACK, 0, 3.0, 0.12 ),
		part( Box( 0.38, 1.12, 0.03 ), BLACK, 0, 3.0, 0.005 ),
		...LENS.map( ( [ y ] ) => part( new THREE.CylinderGeometry( 0.112, 0.112, 0.16, 10, 1, true, - Math.PI / 2, Math.PI ), BLACK, 0, y, 0.3, - Math.PI / 2 ) ),
		part( Box( 0.06, 0.36, 0.06 ), GALV, 0, 3.68, 0.05 ),
	] );
	MODELS.lens = new THREE.CircleGeometry( 0.1, 14 );
	MODELS.mat = new THREE.MeshLambertMaterial( { vertexColors: true, side: THREE.DoubleSide } ); // double-sided for the open lamp hoods
	MODELS.lensMat = new THREE.MeshBasicMaterial( { color: 0xffffff } );
	return MODELS;

}


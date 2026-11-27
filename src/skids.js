import * as THREE from 'three';

// Tyre marks: a ring buffer of thin quads laid on the street where a tyre slides.
const MAX = 6000;

export class Skids {

	constructor( scene ) {

		this.pos = new Float32Array( MAX * 4 * 3 );
		this.alpha = new Float32Array( MAX * 4 );
		const idx = new Uint32Array( MAX * 6 );
		for ( let i = 0; i < MAX; i ++ ) idx.set( [ i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3 ], i * 6 );
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( this.pos, 3 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'alpha', new THREE.BufferAttribute( this.alpha, 1 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setIndex( new THREE.BufferAttribute( idx, 1 ) );
		g.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e7 );
		const m = new THREE.ShaderMaterial( {
			transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 6, polygonOffsetUnits: - 24, fog: true,
			uniforms: THREE.UniformsUtils.merge( [ THREE.UniformsLib.fog ] ),
			vertexShader: `attribute float alpha; varying float vA;
				#include <fog_pars_vertex>
				void main() { vA = alpha; vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 ); gl_Position = projectionMatrix * mvPosition;
				#include <fog_vertex>
				}`,
			fragmentShader: `varying float vA;
				#include <fog_pars_fragment>
				void main() { gl_FragColor = vec4( 0.05, 0.05, 0.055, vA );
				#include <fog_fragment>
				}`,
		} );
		this.mesh = new THREE.Mesh( g, m );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 6;
		scene.add( this.mesh );
		this.next = 0;
		this.last = [ null, null, null, null ];

	}

	// w: wheel index, p: contact point, side: unit vector across the tyre, k: 0..1 strength (0 ends the trail)
	add( w, p, side, k, y ) {

		if ( k <= 0 ) { this.last[ w ] = null; return; }
		const half = 0.11;
		const L = this.last[ w ];
		const a = { x: p.x, z: p.z, y, sx: side.x * half, sz: side.z * half, k };
		if ( ! L ) { this.last[ w ] = a; return; }
		const d = Math.hypot( a.x - L.x, a.z - L.z );
		if ( d < 0.25 ) return;
		if ( d > 3 ) { this.last[ w ] = a; return; }
		const i = this.next;
		this.next = ( this.next + 1 ) % MAX;
		const P = this.pos, o = i * 12;
		P[ o ] = L.x - L.sx; P[ o + 1 ] = L.y; P[ o + 2 ] = L.z - L.sz;
		P[ o + 3 ] = L.x + L.sx; P[ o + 4 ] = L.y; P[ o + 5 ] = L.z + L.sz;
		P[ o + 6 ] = a.x + a.sx; P[ o + 7 ] = a.y; P[ o + 8 ] = a.z + a.sz;
		P[ o + 9 ] = a.x - a.sx; P[ o + 10 ] = a.y; P[ o + 11 ] = a.z - a.sz;
		const A = this.alpha;
		A[ i * 4 ] = A[ i * 4 + 1 ] = 0.55 * L.k;
		A[ i * 4 + 2 ] = A[ i * 4 + 3 ] = 0.55 * k;
		const g = this.mesh.geometry;
		g.attributes.position.addUpdateRange( o, 12 );
		g.attributes.alpha.addUpdateRange( i * 4, 4 );
		g.attributes.position.needsUpdate = true;
		g.attributes.alpha.needsUpdate = true;
		this.last[ w ] = a;

	}

	clear() { this.alpha.fill( 0 ); this.mesh.geometry.attributes.alpha.needsUpdate = true; this.last.fill( null ); }

}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Real tree models (Gravel Rally tree pack by Deni S., CC BY 4.0) for the trees closest to the car.
// Every few frames the nearest lidar trees get a species model each, drawn instanced; the simple procedural
// crowns of exactly those trees are collapsed in their vertex shader, so each tree is drawn once.
// Further away the procedural trees stay: they cost almost nothing.

const SPECIES = {
	decid: [ 'birch', 'birch', 'birch', 'oak', 'hornbeam', 'hornbeam', 'plane', 'poplar' ],
	conif: [ 'pine', 'pine2' ],
	bush: [ 'hazel', 'bush', 'thicket' ],
};
const BUSH = 3.5;

// shared "hide the procedural trees inside this circle" uniform: x, z, radius^2, on
const hide = { value: new THREE.Vector4( 0, 0, 0, 0 ) };
const HIDE_GLSL = `#include <begin_vertex>
#ifdef USE_INSTANCING
{ vec4 o = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); vec2 d = o.xz - uNear.xy; if ( uNear.w > 0.5 && dot( d, d ) < uNear.z ) transformed *= 0.0; }
#endif`;

export function patchHide( mat ) {

	const prev = mat.onBeforeCompile;
	mat.onBeforeCompile = ( sh, r ) => {

		if ( prev ) prev.call( mat, sh, r );
		sh.uniforms.uNear = hide;
		sh.vertexShader = sh.vertexShader.replace( '#include <common>', '#include <common>\nuniform vec4 uNear;' ).replace( '#include <begin_vertex>', HIDE_GLSL );

	};
	mat.customProgramCacheKey = () => 'nearhide';
	mat.needsUpdate = true;
	return mat;

}

// shadow-map version of the same, so hidden crowns cast no shadow either
export const hiddenDepth = patchHide( new THREE.MeshDepthMaterial( { depthPacking: THREE.RGBADepthPacking } ) );

const hash = i => { const s = Math.sin( i * 127.1 + 311.7 ) * 43758.5453; return s - Math.floor( s ); };

export class Foliage {

	constructor( world ) {

		this.world = world;
		this.lib = null;
		this.R = 130;
		this.max = 650;
		this.sel = [];
		this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._qy = new THREE.Quaternion();
		this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._up = new THREE.Vector3( 0, 1, 0 );

	}

	setDetail( tablet ) { this.R = tablet ? 80 : 130; this.max = tablet ? 260 : 650; }

	async load( url = './models/trees.glb' ) {

		const loader = new GLTFLoader();
		loader.setMeshoptDecoder( MeshoptDecoder );
		const gltf = await loader.loadAsync( url );
		gltf.scene.updateMatrixWorld( true );
		const lib = {};
		for ( const node of gltf.scene.children ) {

			const meshes = [];
			node.traverse( o => { if ( o.isMesh ) meshes.push( o ); } );
			const h = node.userData.h || new THREE.Box3().setFromObject( node ).max.y;
			const ims = meshes.map( m => {

				const mat = m.material;
				if ( mat.map ) mat.map.anisotropy = 4;
				// the compressed mesh keeps its dequantization in the node transform: bake it into float geometry,
				// because instance matrices replace the node transform
				const g = m.geometry.clone();
				for ( const k of [ 'position', 'normal', 'tangent' ] ) {

					const a = g.getAttribute( k ); if ( ! a ) continue;
					const n = a.itemSize, f = new Float32Array( a.count * n );
					for ( let i = 0; i < a.count; i ++ ) { f[ i * n ] = a.getX( i ); f[ i * n + 1 ] = a.getY( i ); f[ i * n + 2 ] = a.getZ( i ); if ( n === 4 ) f[ i * n + 3 ] = a.getW( i ); }
					g.setAttribute( k, new THREE.BufferAttribute( f, n ) );

				}

				g.applyMatrix4( m.matrixWorld ); // every species stands at the origin of the file
				g.computeBoundingSphere();
				const im = new THREE.InstancedMesh( g, mat, this.max );
				im.count = 0; im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
				im.userData.sh = 1;
				this.world.group.add( im );
				return im;

			} );
			lib[ node.name ] = { h, ims, n: 0 };

		}

		this.lib = lib;
		this.last = null;

	}

	species( T, i ) {

		const h = T.h[ i ], r = hash( i * 7 + Math.round( T.x[ i ] * 3 ) );
		if ( h < BUSH ) return SPECIES.bush[ Math.floor( r * SPECIES.bush.length ) ];
		if ( T.conif[ i ] ) return SPECIES.conif[ Math.floor( r * SPECIES.conif.length ) ];
		const s = SPECIES.decid[ Math.floor( r * SPECIES.decid.length ) ];
		return s === 'poplar' && h < 12 ? 'birch' : s;

	}

	// pick the nearest trees around (x, z): called a few times a second
	update( x, z ) {

		const W = this.world;
		if ( ! this.lib || ! W.ready ) return;
		const R2 = this.R * this.R, cand = [];
		const [ cx, cy ] = W.chunkOf( x, z );
		const span = Math.ceil( this.R / W.manifest.chunk ) + 1;
		for ( let dy = - span; dy <= span; dy ++ ) for ( let dx = - span; dx <= span; dx ++ ) {

			const c = W.chunks.get( ( cx + dx ) + '_' + ( cy + dy ) ), T = c && c.alive && c.treeData;
			if ( ! T || c.treesLod < 0 ) continue;
			for ( let i = 0; i < T.n; i ++ ) {

				if ( T.gone[ i ] ) continue;
				const ex = T.x[ i ] - x, ez = T.z[ i ] - z, d2 = ex * ex + ez * ez;
				if ( d2 < R2 ) cand.push( { d2, T, i } );

			}

		}

		let thr = R2;
		if ( cand.length > this.max ) { cand.sort( ( a, b ) => a.d2 - b.d2 ); thr = cand[ this.max ].d2; cand.length = this.max; }
		this.sel = cand;
		hide.value.set( x, z, thr, 1 );
		this.write();

	}

	// instance matrices of the chosen trees (also every frame while a knocked tree is falling)
	write() {

		if ( ! this.lib ) return;
		for ( const k in this.lib ) this.lib[ k ].n = 0;
		const { _m: m, _q: q, _qy: qy, _p: p, _s: s } = this;
		for ( const { T, i } of this.sel ) {

			const sp = this.lib[ this.species( T, i ) ];
			if ( ! sp ) continue;
			const k = sp.n ++;
			const r = hash( i * 13.7 + T.z[ i ] );
			qy.setFromAxisAngle( this._up, r * Math.PI * 2 );
			const f = T.fallen[ i ] && T.fall && T.fall[ i ];
			if ( f ) q.setFromAxisAngle( f.axis, f.angle ).multiply( qy ); else q.copy( qy );
			const sc = Math.max( 0.35, T.h[ i ] / sp.h ), wide = 0.85 + 0.3 * hash( i * 3.1 );
			s.set( sc * wide, sc, sc * wide );
			p.set( T.x[ i ], T.y[ i ] - 0.05, T.z[ i ] );
			m.compose( p, q, s );
			for ( const im of sp.ims ) im.setMatrixAt( k, m );

		}

		for ( const k in this.lib ) {

			const sp = this.lib[ k ];
			for ( const im of sp.ims ) { im.count = sp.n; im.instanceMatrix.needsUpdate = true; }

		}

	}

}

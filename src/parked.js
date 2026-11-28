import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { toCreasedNormals, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Parked cars in the big surface parking lots: 1990s to 2010s, no Russian makes.
// Models: public/models/parked.glb (scripts/models/build-parked.mjs), two levels of detail per car.
// All cars share one BatchedMesh: one draw call, per-car frustum culling, near/far detail swapped by distance.
// COLOR_0.a marks body paint, which takes the per-car paint colour.

// share of each model (Estonian register: VW, Toyota, Škoda, BMW, Audi lead)
const MODEL_SHARE = {
	golf4: 7, passat_b5: 6, passat_b6: 5, corolla_e11: 7, corolla_e180: 8, octavia1: 6, octavia2: 7,
	bmw_e39: 12, audi_a4_b8: 11, volvo_s60: 7, merc_w210: 7, astra_g: 5,
};

// paint colours (linear RGB) and how common they are
const PAINTS = [
	[ [ 0.30, 0.31, 0.33 ], 20 ], // silver
	[ [ 0.012, 0.012, 0.014 ], 20 ], // black
	[ [ 0.13, 0.135, 0.14 ], 15 ], // dark grey
	[ [ 0.015, 0.03, 0.10 ], 12 ], // dark blue
	[ [ 0.62, 0.62, 0.61 ], 10 ], // white
	[ [ 0.38, 0.02, 0.02 ], 8 ], // red
	[ [ 0.01, 0.06, 0.03 ], 5 ], // dark green
	[ [ 0.35, 0.29, 0.20 ], 4 ], // champagne
	[ [ 0.10, 0.20, 0.36 ], 3 ], // light blue
	[ [ 0.13, 0.01, 0.025 ], 3 ], // bordeaux
];

const MIN_LOT = 1500; // m²: only big lots get cars (no kerbside or small courtyard parking)
const STALL_W = 2.5, STALL_D = 5, AISLE = 6;

function pick( table, r ) {

	let sum = 0; for ( const [ , w ] of table ) sum += w;
	let x = r * sum;
	for ( const [ v, w ] of table ) { if ( ( x -= w ) < 0 ) return v; }
	return table[ table.length - 1 ][ 0 ];

}

function hash( x, z, s ) {

	const h = Math.sin( x * 12.9898 + z * 78.233 + s * 37.719 ) * 43758.5453;
	return h - Math.floor( h );

}

function inPoly( P, x, z ) {

	let inside = false;
	for ( let i = 0, j = P.length - 2; i < P.length; j = i, i += 2 ) {

		const xi = P[ i ], zi = P[ i + 1 ], xj = P[ j ], zj = P[ j + 1 ];
		if ( ( zi > z ) !== ( zj > z ) && x < ( xj - xi ) * ( z - zi ) / ( zj - zi ) + xi ) inside = ! inside;

	}

	return inside;

}

// vertex colours as they are; where alpha = 1 (paint) the per-car colour takes over
function paintMaterial() {

	const m = new THREE.MeshStandardMaterial( { vertexColors: true, roughness: 0.45, metalness: 0.25 } );
	m.onBeforeCompile = s => {

		s.vertexShader = s.vertexShader.replace( '#include <color_vertex>', `
			vColor = vec4( color.rgb, 1.0 );
			#ifdef USE_BATCHING_COLOR
				vColor.rgb = mix( color.rgb, getBatchingColor( getIndirectIndex( gl_DrawID ) ).rgb, color.a );
			#endif
			#ifdef USE_INSTANCING_COLOR
				vColor.rgb = mix( color.rgb, instanceColor.rgb, color.a );
			#endif
		` );

	};
	m.customProgramCacheKey = () => 'parked-paint';
	return m;

}

export class ParkedCars {

	constructor( roads ) {

		this.roads = roads;
		this.world = roads.world;
		this.mesh = null;
		this.phone = false;
		this.clear = null; // { x, z }: keep this spot free (the player's car)
		this.t = 0;

	}

	async load( url = './models/parked.glb' ) {

		const loader = new GLTFLoader();
		loader.setMeshoptDecoder( MeshoptDecoder );
		const gltf = await loader.loadAsync( url );
		const geo = {};
		gltf.scene.updateMatrixWorld( true );
		gltf.scene.traverse( o => {

			if ( ! o.isMesh ) return;
			const name = ( o.parent && o.parent.name.startsWith( 'car_' ) ? o.parent.name : o.name ).replace( /^car_/, '' );
			// plain floats (meshopt quantizes), world transform baked, smooth normals with hard creases
			const src = o.geometry, f = new THREE.BufferGeometry();
			for ( const [ k, n ] of [ [ 'position', 3 ], [ 'color', 4 ] ] ) {

				const a = src.getAttribute( k ), arr = new Float32Array( a.count * n );
				for ( let i = 0; i < a.count; i ++ ) for ( let j = 0; j < n; j ++ ) arr[ i * n + j ] = a.getComponent( i, j );
				f.setAttribute( k, new THREE.BufferAttribute( arr, n ) );

			}

			f.setIndex( src.index );
			f.applyMatrix4( o.matrixWorld );
			const g = mergeVertices( toCreasedNormals( f, Math.PI / 5 ) );
			f.dispose();
			geo[ name ] = g;

		} );
		this.models = Object.keys( geo ).filter( k => ! k.endsWith( '_lo' ) && geo[ k + '_lo' ] ).map( id => ( { id, hi: geo[ id ], lo: geo[ id + '_lo' ], share: MODEL_SHARE[ id ] || 5 } ) );
		this.table = this.models.map( m => [ m, m.share ] );
		let nv = 0, ni = 0;
		for ( const g of Object.values( geo ) ) { nv += g.getAttribute( 'position' ).count; ni += g.index.count; }
		const max = this.phone ? 200 : 600;
		const mesh = new THREE.BatchedMesh( max, nv, ni, paintMaterial() );
		mesh.perObjectFrustumCulled = true;
		mesh.frustumCulled = false; // cars come and go with the chunks: cull per car instead
		mesh.castShadow = ! this.phone;
		mesh.receiveShadow = true;
		for ( const m of this.models ) { m.hiId = mesh.addGeometry( m.hi ); m.loId = mesh.addGeometry( m.lo ); m.hi.dispose(); m.lo.dispose(); }
		this.mesh = mesh;
		this.roads.group.add( mesh );
		for ( const c of this.roads.chunks.values() ) if ( c.group ) this.fill( c );

	}

	// cars for one chunk's big lots, once the models are in
	fill( c ) {

		if ( ! this.mesh || c.cars || ! c.data ) return;
		c.cars = [];
		const W = this.world, mesh = this.mesh;
		const cap = this.phone ? 25 : 60;
		const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), col = new THREE.Color(), probe = new THREE.Vector3();
		const Y = new THREE.Vector3( 0, 1, 0 ), ONE = new THREE.Vector3( 1, 1, 1 );
		for ( const [ type, P ] of c.data.a || [] ) {

			if ( type !== 0 || P.length < 6 ) continue;
			// size and the longest edge: stalls run along it
			let area = 0, best = 0, ux = 1, uz = 0;
			for ( let i = 0, j = P.length - 2; i < P.length; j = i, i += 2 ) {

				area += P[ j ] * P[ i + 1 ] - P[ i ] * P[ j + 1 ];
				const dx = P[ i ] - P[ j ], dz = P[ i + 1 ] - P[ j + 1 ], L = Math.hypot( dx, dz );
				if ( L > best ) { best = L; ux = dx / L; uz = dz / L; }

			}

			area = Math.abs( area ) / 2;
			if ( area < MIN_LOT ) continue;
			const vx = - uz, vz = ux;
			let u0 = 1e9, u1 = - 1e9, v0 = 1e9, v1 = - 1e9;
			for ( let i = 0; i < P.length; i += 2 ) {

				const u = P[ i ] * ux + P[ i + 1 ] * uz, v = P[ i ] * vx + P[ i + 1 ] * vz;
				u0 = Math.min( u0, u ); u1 = Math.max( u1, u ); v0 = Math.min( v0, v ); v1 = Math.max( v1, v );

			}

			// a third to under half of the stalls taken
			const fill = 0.3 + hash( P[ 0 ], P[ 1 ], 1 ) * 0.15;
			const period = STALL_D * 2 + AISLE;
			for ( let v = v0 + 1; v < v1 - STALL_D; v += period ) for ( let row = 0; row < 2; row ++ ) {

				const vc = v + STALL_D * ( row + 0.5 );
				for ( let u = u0 + STALL_W; u < u1 - STALL_W / 2; u += STALL_W ) {

					if ( c.cars.length >= cap || mesh.instanceCount >= mesh.maxInstanceCount ) break;
					const x = u * ux + vc * vx, z = u * uz + vc * vz;
					if ( hash( x, z, 2 ) > fill ) continue;
					// the whole stall inside the lot
					let ok = inPoly( P, x, z );
					for ( const [ a, b ] of [ [ - 1.1, - 2.4 ], [ 1.1, - 2.4 ], [ - 1.1, 2.4 ], [ 1.1, 2.4 ] ] ) ok = ok && inPoly( P, x + a * ux + b * vx, z + a * uz + b * vz );
					if ( ! ok ) continue;
					if ( this.clear && Math.hypot( x - this.clear.x, z - this.clear.z ) < 10 ) continue;
					if ( W.treesNear( x, z, 2.6 ).length ) continue; // trees, lamp posts, other props, other cars
					const y = W.height( x, z );
					if ( W.closest( probe.set( x, y + 1, z ), 2.8 ) ) continue; // buildings
					const model = pick( this.table, hash( x, z, 3 ) );
					const yaw = Math.atan2( vx, vz ) + ( row ? Math.PI : 0 ) + ( hash( x, z, 4 ) < 0.2 ? Math.PI : 0 ) + ( hash( x, z, 5 ) - 0.5 ) * 0.08;
					const id = mesh.addInstance( model.loId );
					mesh.setMatrixAt( id, m4.compose( pos.set( x, y + 0.02, z ), q.setFromAxisAngle( Y, yaw ), ONE ) );
					mesh.setColorAt( id, col.setRGB( ...pick( PAINTS, hash( x, z, 6 ) ) ) );
					c.cars.push( { id, model, x, z, hi: false } );
					// two solid posts along the body: the player bumps into parked cars, they never fall over
					const fx = Math.sin( yaw ), fz = Math.cos( yaw );
					for ( const s of [ - 1, 1 ] ) c.props.push( { type: - 1, solid: true, x: x + fx * s * 1.25, z: z + fz * s * 1.25, y, h: 1.5, r: 0.95, fallen: false, fell() {} } );

				}

			}

		}

	}

	drop( c ) {

		if ( ! c.cars || ! this.mesh ) return;
		for ( const car of c.cars ) this.mesh.deleteInstance( car.id );
		c.cars = null;

	}

	// near cars get the detailed model
	update( dt, x, z ) {

		if ( ! this.mesh || ( this.t -= dt ) > 0 ) return;
		this.t = 0.4;
		const near = ( this.phone ? 18 : 70 ) ** 2;
		for ( const c of this.roads.chunks.values() ) for ( const car of c.cars || [] ) {

			const hi = ( car.x - x ) ** 2 + ( car.z - z ) ** 2 < near;
			if ( hi !== car.hi ) { car.hi = hi; this.mesh.setGeometryIdAt( car.id, hi ? car.model.hiId : car.model.loId ); }

		}

	}

}

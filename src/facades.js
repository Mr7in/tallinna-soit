import * as THREE from 'three';
import { ORIGIN_E, ORIGIN_N } from './world.js';

// Streams Maa- ja Ruumiamet textured LOD2 buildings (I3S scene layer, photo facades from oblique imagery)
// around the car. The plain LOD2 buildings stay underneath for collisions and far away.
const URL = 'https://tiles.arcgis.com/tiles/ZYGCYltwz5ExeoGm/arcgis/rest/services/hooned_lod2_tallinn_slpk/SceneServer/layers/0/nodes/';
const REC = 7; // floats per leaf: res, x, z, y, r, texels, verts

function facadeMaterial( tex ) {

	const m = new THREE.MeshLambertMaterial( { map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 8 } );
	m.onBeforeCompile = s => {

		s.vertexShader = s.vertexShader
			.replace( '#include <common>', '#include <common>\nattribute vec4 uvRegion;\nvarying vec4 vRegion;' )
			.replace( '#include <uv_vertex>', '#include <uv_vertex>\nvRegion = uvRegion;' );
		s.fragmentShader = s.fragmentShader
			.replace( '#include <common>', '#include <common>\nvarying vec4 vRegion;' )
			.replace( '#include <map_fragment>', `
				vec2 fuv = vRegion.xy + fract( vMapUv ) * ( vRegion.zw - vRegion.xy );
				vec2 gx = dFdx( vMapUv ) * ( vRegion.zw - vRegion.xy ), gy = dFdy( vMapUv ) * ( vRegion.zw - vRegion.xy );
				vec4 sampledDiffuseColor = textureGrad( map, fuv, gx, gy );
				diffuseColor *= sampledDiffuseColor;` );

	};

	return m;

}

export class Facades {

	constructor( world ) {

		this.world = world;
		this.group = new THREE.Group();
		world.group.add( this.group );
		this.chunkData = new Map(); // chunk key -> Float32Array | Promise
		this.nodes = new Map(); // res -> { mesh, alive }
		this.queue = [];
		this.active = 0;
		this.radius = 230;
		this.maxTex = 1024;
		this.enabled = true;
		this.failures = 0;

	}

	chunk( key ) {

		let d = this.chunkData.get( key );
		if ( d === undefined ) {

			this.chunkData.set( key, null );
			fetch( `./city/f_${key}.bin` ).then( r => r.ok ? r.arrayBuffer() : null ).then( b => {

				this.chunkData.set( key, b ? new Float32Array( b ) : new Float32Array( 0 ) );

			} ).catch( () => this.chunkData.set( key, new Float32Array( 0 ) ) );
			return null;

		}

		return d;

	}

	update( x, z ) {

		if ( ! this.enabled || ! this.world.manifest || ! this.world.manifest.facadeChunks ) return;
		const has = this.hasSet || ( this.hasSet = new Set( this.world.manifest.facadeChunks.map( c => c[ 0 ] + '_' + c[ 1 ] ) ) );
		const [ cx, cy ] = this.world.chunkOf( x, z );
		const R = this.radius, want = new Map();
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const key = ( cx + dx ) + '_' + ( cy + dy );
			if ( ! has.has( key ) ) continue;
			const d = this.chunk( key );
			if ( ! d ) continue;
			for ( let i = 0; i < d.length; i += REC ) {

				const dist = Math.hypot( d[ i + 1 ] - x, d[ i + 2 ] - z ) - d[ i + 4 ];
				if ( dist < R ) want.set( d[ i ], { i, d, dist } );

			}

		}

		for ( const [ res, n ] of this.nodes ) if ( ! want.has( res ) ) {

			const d = n.leaf ? Math.hypot( n.leaf.x - x, n.leaf.z - z ) - n.leaf.r : 1e9;
			if ( d > R + 40 ) this.drop( res, n );

		}

		const q = [];
		for ( const [ res, w ] of want ) if ( ! this.nodes.has( res ) ) q.push( [ w.dist, res, w ] );
		q.sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		this.queue = q;
		this.pump();

	}

	pump() {

		while ( this.active < 6 && this.queue.length ) {

			const [ , res, w ] = this.queue.shift();
			if ( this.nodes.has( res ) ) continue;
			const d = w.d, i = w.i;
			const leaf = { x: d[ i + 1 ], z: d[ i + 2 ], y: d[ i + 3 ], r: d[ i + 4 ], texels: d[ i + 5 ] };
			const n = { alive: true, mesh: null, leaf };
			this.nodes.set( res, n );
			this.active ++;
			this.load( res, n ).catch( () => {

				this.failures ++;
				if ( this.failures > 40 && this.nodes.size < 5 ) this.enabled = false;

			} ).finally( () => {

				this.active --;
				this.pump();

			} );

		}

	}

	async load( res, n ) {

		const [ gb, img ] = await Promise.all( [
			fetch( URL + res + '/geometries/0' ).then( r => {

				if ( ! r.ok ) throw new Error( 'geom ' + r.status );
				return r.arrayBuffer();

			} ),
			fetch( URL + res + '/textures/0' ).then( r => {

				if ( ! r.ok ) throw new Error( 'tex ' + r.status );
				return r.blob();

			} ).then( async b => {

				const probe = await createImageBitmap( b );
				const s = Math.min( 1, this.maxTex / Math.max( probe.width, probe.height ) );
				if ( s >= 1 ) return probe;
				const w = Math.max( 4, Math.round( probe.width * s ) ), h = Math.max( 4, Math.round( probe.height * s ) );
				probe.close();
				return createImageBitmap( b, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } );

			} )
		] );
		if ( ! n.alive ) {

			img.close && img.close();
			return;

		}

		let buf = gb;
		const head = new Uint8Array( buf, 0, 2 );
		if ( head[ 0 ] === 0x1f && head[ 1 ] === 0x8b ) buf = await new Response( new Blob( [ buf ] ).stream().pipeThrough( new DecompressionStream( 'gzip' ) ) ).arrayBuffer();
		const vc = new Uint32Array( buf, 0, 2 )[ 0 ];
		let o = 8;
		const pos = new Float32Array( buf, o, vc * 3 ); o += vc * 12;
		o += vc * 12; // normals (we compute flat ones)
		const uv = new Float32Array( buf, o, vc * 2 ); o += vc * 8;
		o += vc * 4; // colour
		const reg = new Uint16Array( buf.slice( o, o + vc * 8 ) );

		// I3S positions are offsets from the node centre in L-EST97 metres (E, N, H)
		const cx = n.leaf.x, cz = n.leaf.z, cy = n.leaf.y;
		const p = new Float32Array( vc * 3 );
		for ( let k = 0; k < vc; k ++ ) {

			p[ k * 3 ] = pos[ k * 3 ];
			p[ k * 3 + 1 ] = pos[ k * 3 + 2 ];
			p[ k * 3 + 2 ] = - pos[ k * 3 + 1 ];

		}

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( p, 3 ) );
		g.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( uv ), 2 ) );
		g.setAttribute( 'uvRegion', new THREE.BufferAttribute( reg, 4, true ) );
		g.computeVertexNormals();
		g.computeBoundingSphere();
		const tex = new THREE.Texture( img );
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.flipY = false;
		tex.anisotropy = 8;
		tex.needsUpdate = true;
		const mesh = new THREE.Mesh( g, facadeMaterial( tex ) );
		mesh.position.set( cx, cy, cz );
		n.mesh = mesh;
		this.group.add( mesh );

	}

	drop( res, n ) {

		n.alive = false;
		this.nodes.delete( res );
		if ( n.mesh ) {

			this.group.remove( n.mesh );
			n.mesh.geometry.dispose();
			n.mesh.material.map.dispose();
			n.mesh.material.dispose();

		}

	}

}

export { ORIGIN_E, ORIGIN_N };
